/**
 * The capture host: the supervisor around the engine child (the vision module, 2026-11-07).
 *
 * The child owns a native boundary (PrintWindow, the DIB surfaces, koffi), and a native boundary is
 * what this codebase measured failing: the old native encoder took a napi fatal at the end of long
 * runs, and the World saw only `stale-frame` until the day's run ended. The answer is not to trust
 * the child but to supervise it (Erlang, Chrome, OBS): when it dies — or when its heartbeat in the
 * frame channel goes quiet while it is supposed to be alive — spawn it again, report `capture-restarted`,
 * and let the session keep running.
 *
 * The contract with the World is still `EngineRequester` (contracts §5): a request is answered by the
 * current child, and past the restart cap the answer is a value —
 * `{ ok:false, error:'unavailable', detail:'capture-unavailable' }` — never a throw.
 *
 * Two details are the difference between a supervisor and a restart storm:
 *
 * - **A capture waits for the new child's first frame.** The child's warm-up is up to 500 ms while the
 *   World's own capture accounting gives up after three 100 ms ticks; a capture forwarded into a child
 *   that is still starting would spend that budget and end a session for a restart that was working.
 *   The host therefore holds a `capture` through a restart until the channel publishes a frame newer
 *   than the one the dead child left (bounded by `firstFrameMs`), so the World never reads the dead
 *   child's last frame as a live one.
 * - **The heartbeat, not the frame rate, is liveness.** The child's render loop stops 300 ms after the
 *   last demand; an idle child still writes the heartbeat every 250 ms.
 */
import type { EngineEvent, EngineReply, EngineRequest } from '../../contracts.ts';
import type { EngineClient } from '../child.ts';
import { heartbeatOf, readHeader, type FrameChannel } from './frame-channel.ts';

/** What the host needs, and nothing else: how to spawn a child, and the channel to watch. */
export interface CaptureHostOptions {
  /** Spawn one child and connect it; called again for a restart. Must not throw for a normal spawn. */
  launch(): EngineClient;
  /** The channel the child publishes into and heartbeats to; absent, liveness is the process only. */
  channel?: FrameChannel;
  /** Epoch ms clock (the channel's own); injectable so a test never waits out a real heartbeat. */
  now?: () => number;
  /** A heartbeat older than this means the capture is gone (the plan's ~1 s). */
  heartbeatStaleMs?: number;
  /** How often the liveness check runs. */
  healthIntervalMs?: number;
  /** Restarts allowed per host, and so per session; the plan's decision is one. */
  maxRestarts?: number;
  /** How long a `capture` waits for the restarted child's first frame. */
  firstFrameMs?: number;
  /** How long one wait between frame checks is. */
  framePollMs?: number;
  /** Where the host's own lines go; the World's logger, or stderr by default. */
  logger?: (line: string) => void;
  /** The wait seam, so a test can drive the retry loop without wall time. */
  wait?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  heartbeatStaleMs: 1_000,
  healthIntervalMs: 250,
  maxRestarts: 1,
  firstFrameMs: 3_000,
  framePollMs: 25,
} as const;

/** Unsolicited events that arrive before the World subscribes; the same shape `connectEngine` buffers. */
const MAX_BUFFERED_EVENTS = 32;

const CAPTURE_UNAVAILABLE: EngineReply = {
  id: 0,
  ok: false,
  error: 'unavailable',
  detail: 'capture-unavailable',
};

export class CaptureHost {
  #engine: EngineClient | null = null;
  #restarts = 0;
  #unavailable = false;
  #closed = false;
  /** When the current child was spawned: the grace it gets before its heartbeat is believed. */
  #launchedAt = 0;
  /** The newest heartbeat the host has seen from the current child. */
  #lastBeat = 0;
  /** The channel sequence the dead child left behind: a capture waits for a newer one. */
  #deathSeq = 0;
  #waitingFrame = false;
  #health: ReturnType<typeof setInterval> | null = null;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  readonly #buffered: EngineEvent[] = [];
  readonly #options: Required<Pick<CaptureHostOptions, 'heartbeatStaleMs' | 'healthIntervalMs' | 'maxRestarts' | 'firstFrameMs' | 'framePollMs'>> & {
    readonly launch: () => EngineClient;
    readonly channel?: FrameChannel;
    readonly now: () => number;
    readonly logger: (line: string) => void;
    readonly wait: (ms: number) => Promise<void>;
  };

  constructor(options: CaptureHostOptions) {
    this.#options = {
      launch: options.launch,
      channel: options.channel,
      now: options.now ?? (() => Date.now()),
      heartbeatStaleMs: options.heartbeatStaleMs ?? DEFAULTS.heartbeatStaleMs,
      healthIntervalMs: options.healthIntervalMs ?? DEFAULTS.healthIntervalMs,
      maxRestarts: options.maxRestarts ?? DEFAULTS.maxRestarts,
      firstFrameMs: options.firstFrameMs ?? DEFAULTS.firstFrameMs,
      framePollMs: options.framePollMs ?? DEFAULTS.framePollMs,
      logger: options.logger ?? ((line) => process.stderr.write(`${line}\n`)),
      wait: options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /** The current child's client, for a caller that needs the process itself; null before the first use. */
  get client(): EngineClient | null {
    return this.#engine;
  }

  /** How many children have been spawned after the first, i.e. how many restarts happened. */
  get restarts(): number {
    return this.#restarts;
  }

  /** Whether the cap is spent: every later request answers `capture-unavailable`. */
  get unavailable(): boolean {
    return this.#unavailable;
  }

  /**
   * One §5 request. A capture during a restart waits for the new child's first frame; every request
   * past the cap is a value. The host never rejects: the World's loop reads §5 replies, not exceptions.
   */
  async request(request: EngineRequest): Promise<EngineReply> {
    if (this.#closed) return { id: 0, ok: false, error: 'unavailable', detail: 'engine-closed' };
    if (this.#engine === null && !this.#unavailable) this.#spawn();
    if (this.#unavailable || this.#engine === null) return { ...CAPTURE_UNAVAILABLE };
    if (request.op === 'capture' && this.#waitingFrame) await this.#awaitFrame();
    const engine = this.#engine;
    if (engine === null) return { ...CAPTURE_UNAVAILABLE };
    return engine.request(request);
  }

  /**
   * The child's unsolicited events, and the host's own reports (`capture-restarted`,
   * `capture-unavailable`). Events that arrive before anything subscribes are buffered, so a restart
   * during a session's first tick is not lost.
   */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);
    for (const event of this.#buffered.splice(0)) listener(event);
    return () => this.#listeners.delete(listener);
  }

  /** Stop supervising and tear the current child down. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopHealth();
    const engine = this.#engine;
    this.#engine = null;
    engine?.close();
  }

  // --- supervision ---------------------------------------------------------------------------

  /** Spawn the child, adopt it, and start watching. A spawn that throws is the cap's first case. */
  #spawn(): void {
    if (this.#closed) return;
    let client: EngineClient;
    try {
      client = this.#options.launch();
    } catch (error) {
      this.#log(`capture host: the child could not be started: ${message(error)}`);
      this.#giveUp();
      return;
    }
    this.#engine = client;
    this.#launchedAt = this.#options.now();
    this.#lastBeat = Math.max(this.#heartbeat(), this.#launchedAt);
    client.child.once('exit', () => this.#onDeath('the child exited'));
    client.child.once('error', () => this.#onDeath('the child failed'));
    client.onEvent((event) => this.#emit(event));
    this.#startHealth();
  }

  /** The child is gone: restart it, or report the cap and answer `capture-unavailable` from now on. */
  #onDeath(reason: string): void {
    if (this.#closed || this.#engine === null) return;
    const dead = this.#engine;
    this.#engine = null;
    this.#stopHealth();
    // The dead child's frame is still inside the channel's stale window; remember the sequence so a
    // capture waits for a newer frame instead of serving that one as if it were live.
    this.#deathSeq = this.#latestSeq();
    this.#waitingFrame = true;
    try {
      dead.close();
    } catch {
      // the process is already gone; the pipe close is best-effort
    }
    if (this.#restarts >= this.#options.maxRestarts) {
      this.#log(`capture host: ${reason}, and the restart budget is spent`);
      this.#giveUp();
      return;
    }
    this.#restarts += 1;
    this.#log(`capture host: ${reason}; restarting the capture (${this.#restarts}/${this.#options.maxRestarts})`);
    this.#emit({ kind: 'engineProblem', detail: 'capture-restarted' });
    this.#spawn();
  }

  /** The capture cannot be had any more; the World hears it once, and every request says so. */
  #giveUp(): void {
    this.#unavailable = true;
    this.#waitingFrame = false;
    this.#engine = null;
    this.#stopHealth();
    this.#emit({ kind: 'engineProblem', detail: 'capture-unavailable' });
  }

  /** A heartbeat that has not moved since the child was born (or last beat) means the child is dead. */
  #checkHealth(): void {
    if (this.#closed || this.#engine === null) return;
    const channel = this.#options.channel;
    if (channel === undefined) return;
    const beat = this.#heartbeat();
    if (beat > this.#lastBeat) this.#lastBeat = beat;
    const since = Math.max(this.#lastBeat, this.#launchedAt);
    const silentMs = this.#options.now() - since;
    if (silentMs > this.#options.heartbeatStaleMs) {
      this.#log(`capture host: no heartbeat for ${Math.round(silentMs)} ms`);
      this.#onDeath('the heartbeat stopped');
    }
  }

  #startHealth(): void {
    if (this.#health !== null) return;
    this.#health = setInterval(() => this.#checkHealth(), this.#options.healthIntervalMs);
    this.#health.unref?.();
  }

  #stopHealth(): void {
    if (this.#health === null) return;
    clearInterval(this.#health);
    this.#health = null;
  }

  /**
   * Wait for a frame newer than the dead child's last one, bounded. On the deadline the request is
   * forwarded anyway: the child's own reply (`no-frame`/`stale-frame`) is the World's to read.
   */
  async #awaitFrame(): Promise<void> {
    const deadline = this.#options.now() + this.#options.firstFrameMs;
    while (!this.#closed && this.#engine !== null && this.#options.now() < deadline) {
      if (this.#latestSeq() > this.#deathSeq) {
        this.#waitingFrame = false;
        return;
      }
      await this.#options.wait(this.#options.framePollMs);
    }
    this.#waitingFrame = false;
  }

  /** The channel's newest published sequence, or 0 when there is no channel to read. */
  #latestSeq(): number {
    const channel = this.#options.channel;
    if (channel === undefined) return 0;
    try {
      return Number(readHeader(channel).latestSeq);
    } catch {
      return 0;
    }
  }

  /** The channel's heartbeat, or 0 when there is no channel to read. */
  #heartbeat(): number {
    const channel = this.#options.channel;
    if (channel === undefined) return 0;
    try {
      return heartbeatOf(channel);
    } catch {
      return 0;
    }
  }

  #emit(event: EngineEvent): void {
    if (this.#listeners.size === 0) {
      this.#buffered.push(event);
      if (this.#buffered.length > MAX_BUFFERED_EVENTS) this.#buffered.shift();
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }

  #log(line: string): void {
    this.#options.logger(line);
  }
}

/** A child process's failure, without trusting it to be an Error. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
