/**
 * The World side of the engine child: spawn it, and speak contracts §5 to it over stdin/stdout.
 *
 * The child is plain ESM (`./child.mjs`) spawned with `process.execPath` and
 * `ELECTRON_RUN_AS_NODE=1`, so it starts under the app's Electron-as-Node and under a plain
 * `node` alike (R9). Every Win32 call lives in that process; here there is only the pipe.
 *
 * Two things about the pipe worth knowing (R23): the child's stderr is forwarded to the World's
 * logger instead of being drained and dropped, and output that is not the `[wvd-engine]` banner
 * before the first successful frame is also surfaced as an `engineProblem`. Events that arrive
 * before anything subscribes are buffered, so a stop hotkey or a startup problem is not lost.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TEARDOWN_GRACE_MS,
  type ActionFailure,
  type EngineReply,
  type EngineRequest,
} from '../contracts.ts';
import { LineDecoder, decodeLine, encodeRequest, type EngineEvent } from './protocol.ts';

export interface EngineOptions {
  /** The window the child captures and guards; the World's `gameWindowTitle`. */
  title: string;
  /** Global stop hotkey, e.g. `Ctrl+Alt+W`; an empty string disables registration. */
  hotkey?: string;
  /**
   * The shared frame channel the child publishes into: the region's name and its byte size. The
   * World creates the mapping before spawning (the child opens it), and the layout's header is the
   * contract between them. Absent, the child captures nothing — there is no other frame transport.
   */
  channel?: { readonly name: string; readonly bytes: number };
}

export interface EngineClientOptions {
  /** Per-request wait; the World's `engineTimeoutMs`. */
  timeoutMs?: number;
  /** Where the child's stderr goes; the World passes its logger. */
  logger?: (line: string) => void;
}

/** The engine's request surface, as the rest of the World sees it. */
export interface EngineClient {
  readonly child: ChildProcess;
  /** One §5 request; never rejects — a failure is a §5 reply (`unavailable`, `rejected` or `timeout`). */
  request(request: EngineRequest): Promise<EngineReply>;
  /** The child's unsolicited messages (R3, R23); the returned function unsubscribes. */
  onEvent(listener: (event: EngineEvent) => void): () => void;
  /** Graceful teardown: end the pipe, wait briefly for the child to release input and exit, then
   *  kill it. Pending requests fail with `unavailable`. */
  close(): void;
}

const CHILD = fileURLToPath(new URL('./child.mjs', import.meta.url));
/** The child's own banner lines; anything else on stderr is unexpected output. */
const CHILD_BANNER = '[wvd-engine]';
const MAX_BUFFERED_EVENTS = 32;

/** Spawns the engine child; `connectEngine` turns it into the protocol client. */
export function startEngine(options: EngineOptions): ChildProcess {
  const args = [CHILD, `--title=${options.title}`];
  if (options.hotkey !== undefined) args.push(`--hotkey=${options.hotkey}`);
  if (options.channel !== undefined) {
    args.push(`--channel=${options.channel.name}`, `--channel-bytes=${options.channel.bytes}`);
  }
  return spawn(process.execPath, args, {
    // Electron's binary runs as Node only with this set; plain Node ignores the variable.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Wraps a spawned child in the request/reply client. */
export function connectEngine(child: ChildProcess, options: EngineClientOptions = {}): EngineClient {
  const timeoutMs = options.timeoutMs ?? 5000;
  const logger = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stdout = child.stdout;
  if (!stdout) throw new Error('engine child was spawned without a stdout pipe');
  const stdin = child.stdin;

  const pending = new Map<number, {
    resolve(reply: EngineReply): void;
    timer: ReturnType<typeof setTimeout>;
    op: EngineRequest['op'];
  }>();
  const listeners = new Set<(event: EngineEvent) => void>();
  const bufferedEvents: EngineEvent[] = [];
  let nextId = 1;
  let closed = false;
  let firstFrame = false;
  let startupProblemSurfaced = false;

  const emit = (event: EngineEvent): void => {
    if (listeners.size === 0) {
      bufferedEvents.push(event);
      if (bufferedEvents.length > MAX_BUFFERED_EVENTS) bufferedEvents.shift();
      return;
    }
    for (const listener of listeners) listener(event);
  };

  const settle = (reply: EngineReply): void => {
    const entry = pending.get(reply.id);
    if (!entry) return; // a reply for a request that already timed out
    clearTimeout(entry.timer);
    pending.delete(reply.id);
    if (reply.ok && entry.op === 'capture') firstFrame = true;
    entry.resolve(reply);
  };

  const failAll = (error: ActionFailure, detail: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, ok: false, error, detail });
    }
    pending.clear();
  };

  const decoder = new LineDecoder();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      const message = decodeLine(line);
      if (!message) continue;
      if ('reply' in message) settle(message.reply);
      else if ('event' in message) emit(message.event);
    }
  });

  // stderr is the child's log, not the protocol: forward it, and treat unexpected output before the
  // first frame as a startup problem rather than losing why the engine is not producing frames
  let stderrPending = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrPending += chunk;
    for (;;) {
      const end = stderrPending.indexOf('\n');
      if (end < 0) break;
      const line = stderrPending.slice(0, end).replace(/\r$/, '');
      stderrPending = stderrPending.slice(end + 1);
      if (!line.trim()) continue;
      logger(line);
      if (!firstFrame && !startupProblemSurfaced && !line.startsWith(CHILD_BANNER)) {
        startupProblemSurfaced = true;
        emit({ kind: 'engineProblem', detail: line.trim() });
      }
    }
  });

  child.on('error', () => failAll('unavailable', 'engine-error'));
  child.on('close', () => {
    closed = true;
    failAll('unavailable', 'engine-exited');
  });
  stdin?.on('error', () => {
    // EPIPE reaches the pending request as a timeout or as the close above
  });

  return {
    child,
    request(request) {
      const id = nextId++;
      if (closed || !stdin) return Promise.resolve({ id, ok: false, error: 'unavailable', detail: 'engine-closed' });
      return new Promise<EngineReply>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          resolve({ id, ok: false, error: 'timeout', detail: `after ${timeoutMs}ms` });
        }, timeoutMs);
        pending.set(id, { resolve, timer, op: request.op });
        try {
          stdin.write(encodeRequest(id, request));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ id, ok: false, error: 'unavailable', detail: 'engine-write' });
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      // deliver what arrived while nobody was listening, oldest first
      for (const event of bufferedEvents.splice(0)) listener(event);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      failAll('unavailable', 'engine-closed');
      // Closing stdin is the child's teardown signal: it finishes the request in flight, calls
      // releaseHeld() and exits. On Windows kill() is TerminateProcess, which would skip both, so
      // wait for the graceful exit first and only kill a child that hangs (a crash can still lose
      // the release; that is accepted).
      try {
        stdin?.end();
      } catch {
        // already closed
      }
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, TEARDOWN_GRACE_MS);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    },
  };
}
