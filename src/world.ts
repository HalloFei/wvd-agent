/**
 * The WVD World: the loop that runs the modules, the four tools, and the escalation exchange.
 *
 * The loop is the only thing in this package that knows *when*; every *what* arrives through a
 * contract (contracts §0.1, §0.2). `FarmPolicy`, `SessionClassifier`, `RouteCommands`,
 * `FrameSource`, `Perceiver`, `Actuator` and `SnapshotSource` are constructor arguments; `main.ts`
 * decides which realizations they are. That is what lets a replay source, a template perceiver or a
 * fake in `tests/world.test.ts` run this same loop.
 *
 * The rulings that shape the tick:
 *
 * - **One clock.** `atMs` is `performance.now()`; the engine reports `ageMs` only, and
 *   `Win32Capture` already subtracts it. A decision is dated by `frame.atMs`, never by "just
 *   received".
 * - **No overlapping ticks.** A tick that is still running is skipped, not queued: a tick that
 *   overruns is a bug, not a backlog. During an escalation the paused tick *is* the pause.
 * - **Warm-up.** The first capture after an idle gap can answer `timeout` while the child starts
 *   rendering, so capture failures are retried for three ticks before the engine is called absent.
 * - **Stalls are the loop's.** `classify` is stateless and deliberately so; "no progress" is
 *   measured here, turned into an escalation at a quarter of `stallStopSeconds` and into a stop at
 *   all of it.
 * - **Engine failure is a stop.** No window, a dead child, a capture that keeps failing: the session
 *   ends and says why (contracts §0.6).
 */
import type {
  EventEnvelope,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type {
  ActionResult,
  Actuator,
  EngineEvent,
  FarmPolicy,
  Frame,
  FrameSource,
  Intent,
  Observation,
  Perceiver,
  RouteState,
  ScreenId,
  SessionVerdict,
} from './contracts.ts';
import { WVD_CONFIG_GROUP, WVD_ID, type WvdConfigSection } from './config.ts';
import {
  fallbackPhrase,
  observationLine,
  stoppedEvent,
  stuckEvent,
  type WvdEvent,
} from './escalation/event.ts';
import { snapshotBlob, takeSnapshot, type SnapshotSource } from './escalation/image.ts';
import { Supervisor, type EscalationOutcome } from './escalation/supervisor.ts';

/** `classify` from `policy/session.ts` (contracts §6, §9): a verdict, never an action. */
export type SessionClassifier = (
  state: RouteState,
  escalationsThisHour: number,
  escalateMaxPerHour: number,
) => SessionVerdict;

/** The three key commands of `actions/automove.ts`, bound to an `Actuator` by the composition root. */
export interface RouteCommands {
  openMap(): Promise<ActionResult>;
  automoveToChest(): Promise<ActionResult>;
  automoveToExit(): Promise<ActionResult>;
}

/** One session's collaborators: everything the loop drives, for as long as it runs. */
export interface WvdSession {
  readonly source: FrameSource;
  readonly perceiver: Perceiver;
  readonly actuator: Actuator;
  /** The engine's own JPEG for the escalation image (contracts §5 `capture { maxWidth }`). */
  readonly snapshot?: SnapshotSource | undefined;
  /** The child's unsolicited messages (stop hotkey, capability problems); returns an unsubscribe. */
  readonly onEngineEvent?: ((listener: (event: EngineEvent) => void) => () => void) | undefined;
  readonly close?: (() => void) | undefined;
}

export interface WvdWorldOptions {
  /** Live reference to `worlds.wvd`; the keys this World owns are read per decision, not copied. */
  cfg: WvdConfigSection;
  /** Deployment timezone; event timestamps use it. */
  timezone: string;
  policy: FarmPolicy;
  classify: SessionClassifier;
  commands: RouteCommands;
  /** Builds the engine for one session; absent means this World cannot farm at all. */
  openSession?: (() => Promise<WvdSession | null>) | undefined;
  /** The loop's scheduler: on in production, off in tests so a tick runs only when asked. */
  autoTick?: boolean | undefined;
  /** The one clock. `performance.now()` unless a test says otherwise. */
  now?: (() => number) | undefined;
}

// --- constants the loop owns ----------------------------------------------------------------

/** Capture failures retried before the engine is treated as absent: warm-up, not failure (§5). */
const WARMUP_TICKS = 3;
/** The loop escalates at this fraction of `stallStopSeconds`, and stops at all of it. */
const STALL_ESCALATE_DIVISOR = 4;
/** Below this a stall-escalate floor would ask a question about a screen that is still settling. */
const MIN_STALL_ESCALATE_MS = 500;
/** One hour on the loop's clock: `escalateMaxPerHour`'s window. */
const HOUR_MS = 60 * 60 * 1000;
/** `wvd_act` holdKey defaults, mirroring contracts §8.3's `hazardEscapeHoldMs` and §4's floor. */
const DEFAULT_ACT_HOLD_MS = 250;
const MIN_ACT_HOLD_MS = 40;
const MAX_ACT_HOLD_MS = 2000;
/** Windows set-1 scan codes for the WASD keys; the model names letters, the engine gets integers. */
const MOVEMENT_SCAN: Readonly<Record<string, number>> = { w: 0x11, a: 0x1e, s: 0x1f, d: 0x20 };
/** What the loop does when nobody answers: the route's own recovery (contracts §6). */
const FALLBACK_INTENT: Intent = { kind: 'exit' };
/** Before any map has been read, one chest is budgeted so the first move is to open the map. */
const INITIAL_CHEST_BUDGET = 1;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Every tool the escalation path needs; all four are wired by this loop. */
export const WVD_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wvd_status',
    description:
      'Report the WVD farming session: whether one is running, what it last decided, whether a question '
      + 'is waiting, and how much of the hourly escalation budget is left. Takes no arguments.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_look',
    description:
      'Capture the game window again and return the frame as an image together with what this World '
      + 'recognizes on it. Use it when the frame in the question is not enough, and after wvd_act to see '
      + 'what the input did. Works whether the loop is paused or running.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_act',
    description:
      'Send one input to the game window: a tap, a double tap, or a held movement key. Accepted only '
      + 'while a question from this World is waiting for you. x and y are pixels of the last image this '
      + 'World sent you — its size is in the [blob …] line; the World maps them onto the window. The '
      + 'receipt says whether the input was sent, not what the game did: call wvd_look to see that.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['tap', 'doubleTap', 'holdKey'],
          description: 'tap: one click at x, y. doubleTap: two clicks at the same place. holdKey: hold key for holdMs.',
        },
        x: { type: 'integer', minimum: 0, description: 'Pixel column on the last image, 0 at its left edge. tap and doubleTap only.' },
        y: { type: 'integer', minimum: 0, description: 'Pixel row on that image, 0 at its top edge. tap and doubleTap only.' },
        key: { type: 'string', enum: ['w', 'a', 's', 'd'], description: 'holdKey only: the movement key to hold.' },
        holdMs: { type: 'integer', minimum: 40, maximum: 2000, description: 'holdKey only: how long to hold, default 250.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'wvd_resume',
    description:
      'Answer the waiting question and let the farming loop run again. Call it once, after wvd_act and '
      + 'wvd_look have done what you want. intent is the decision for the loop; leave it out and the loop '
      + 'reads the screen again and lets the route policy decide. The loop stays paused until this call or '
      + 'its own timeout, and then it takes its own fallback.',
    tags: ['flow'],
    barrierAfter: true,
    endsTurn: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: {
          type: 'object',
          additionalProperties: false,
          description: 'What the loop should do as soon as it resumes.',
          properties: {
            kind: { type: 'string', enum: ['open-map', 'move', 'open-chest', 'fight', 'exit', 'wait', 'stop'] },
            x: { type: 'integer', description: 'move: target tile, grid X as the map readout shows it.' },
            y: { type: 'integer', description: 'move: target tile, grid Y.' },
            ms: { type: 'integer', minimum: 0, description: 'wait: how long.' },
            reason: { type: 'string', description: 'stop: why.' },
          },
          required: ['kind'],
        },
        note: { type: 'string', description: 'One line for the session log: what you saw and why this is right.' },
      },
    },
  },
];

/** An intent the model named, or why it could not be read. A value, not a throw. */
export type ParsedIntent = { readonly ok: true; readonly intent: Intent | null } | { readonly ok: false; readonly detail: string };

/** Map `wvd_resume`'s `intent` argument onto contracts §6's closed union. */
export function parseIntent(value: unknown): ParsedIntent {
  if (value === undefined || value === null) return { ok: true, intent: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, detail: 'intent must be an object' };
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'open-map':
    case 'open-chest':
    case 'fight':
    case 'exit':
      return { ok: true, intent: { kind: record.kind } };
    case 'move': {
      const { x, y } = record;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, detail: 'move needs x and y' };
      return { ok: true, intent: { kind: 'move', target: { x: x as number, y: y as number } } };
    }
    case 'wait': {
      const { ms } = record;
      if (!Number.isInteger(ms) || (ms as number) < 0) return { ok: false, detail: 'wait needs ms' };
      return { ok: true, intent: { kind: 'wait', ms: ms as number } };
    }
    case 'stop':
      return {
        ok: true,
        intent: {
          kind: 'stop',
          reason: typeof record.reason === 'string' && record.reason.trim() !== ''
            ? record.reason
            : 'the model asked to stop',
        },
      };
    default:
      return { ok: false, detail: `unknown intent kind: ${String(record.kind)}` };
  }
}

export class WvdWorld implements World {
  readonly id = WVD_ID;

  #host: WorldHost | null = null;
  #session: WvdSession | null = null;
  #unsubscribe: (() => void) | null = null;
  #running = false;
  #ticking = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  #sessionStartedAtMs = 0;
  #lastProgressAtMs = 0;
  #lastScreen: ScreenId | null = null;
  #lastIntent: { readonly intent: Intent; readonly atMs: number } | null = null;
  #lastObservation: Observation | null = null;
  #ticks = 0;
  #captureFailures = 0;
  #willpower: readonly number[] = [];
  #chestsRemaining = INITIAL_CHEST_BUDGET;
  #hourStartMs = -1;
  #escalationsThisHour = 0;
  #escalationCooldownUntilMs = 0;
  #nextEscalationId = 1;
  #engineProblem: string | null = null;
  #lastStopReason: string | null = null;

  readonly #supervisor: Supervisor;
  readonly #cfg: WvdConfigSection;
  readonly #timezone: string;
  readonly #policy: FarmPolicy;
  readonly #classify: SessionClassifier;
  readonly #commands: RouteCommands;
  readonly #openSession: (() => Promise<WvdSession | null>) | undefined;
  readonly #autoTick: boolean;
  readonly #now: () => number;

  constructor(options: WvdWorldOptions) {
    this.#cfg = options.cfg;
    this.#timezone = options.timezone;
    this.#policy = options.policy;
    this.#classify = options.classify;
    this.#commands = options.commands;
    this.#openSession = options.openSession;
    this.#autoTick = options.autoTick !== false;
    this.#now = options.now ?? (() => performance.now());
    this.#supervisor = new Supervisor(() => this.#host, this.#now);
  }

  /** No environment section yet: the tool receipts carry what the model needs to know. */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  tools(): ToolDef[] {
    return WVD_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.#handlerFor(decl.name) }));
  }

  webUi(): WorldWebUiDecl {
    return { config: [WVD_CONFIG_GROUP] };
  }

  /** Mounting announces nothing; a session starts only when `enabled` is set or the operator asks. */
  async start(host: WorldHost): Promise<void> {
    this.#host = host;
    if (this.#cfg.enabled && !this.#running) await this.startSession();
  }

  async stop(): Promise<void> {
    await this.#endSession('the session was stopped', { report: true });
  }

  // --- session lifecycle ---------------------------------------------------------------------

  isRunning(): boolean {
    return this.#running;
  }

  escalationsThisHour(): number {
    return this.#spentThisHour(this.#now());
  }

  /**
   * Open a session: build the engine's collaborators, reset the session's counters and start the
   * loop. Returns false when there is nothing to run, with the reason kept for `wvd_status`.
   */
  async startSession(): Promise<boolean> {
    if (this.#running) return true;
    if (!this.#host || !this.#openSession) {
      this.#lastStopReason = 'no engine is wired to this World';
      return false;
    }
    let session: WvdSession | null = null;
    try {
      session = await this.#openSession();
    } catch (error) {
      this.#lastStopReason = `the engine could not be started: ${message(error)}`;
      return false;
    }
    if (!session) {
      this.#lastStopReason = 'the engine child did not start';
      return false;
    }

    this.#session = session;
    const now = this.#now();
    this.#running = true;
    this.#ticking = false;
    this.#sessionStartedAtMs = now;
    this.#lastProgressAtMs = now;
    this.#lastScreen = null;
    this.#lastIntent = null;
    this.#lastObservation = null;
    this.#ticks = 0;
    this.#captureFailures = 0;
    this.#willpower = [];
    this.#chestsRemaining = INITIAL_CHEST_BUDGET;
    this.#escalationCooldownUntilMs = 0;
    this.#lastStopReason = null;
    this.#unsubscribe = session.onEngineEvent?.((event) => {
      void this.onEngineEvent(event);
    }) ?? null;
    if (this.#autoTick) this.#schedule();
    return true;
  }

  /**
   * One tick. Public because the scheduler and the tests are the two callers, and because a skipped
   * tick must be observable: while one runs, every other call returns at once (no queue, no overlap).
   */
  async tick(): Promise<void> {
    if (!this.#running || this.#ticking) return;
    const session = this.#session;
    if (!session) return;
    this.#ticking = true;
    try {
      await this.#step(session);
    } catch (error) {
      // A module threw across its boundary (contracts §0.6): that is the loop's failure to handle.
      await this.#endSession(`a module failed: ${message(error)}`, { report: true });
    } finally {
      this.#ticking = false;
    }
  }

  // --- the tick body -------------------------------------------------------------------------

  async #step(session: WvdSession): Promise<void> {
    this.#ticks += 1;

    const frame = await this.#capture(session);
    if (!frame || !this.#running || this.#session !== session) return;

    let observation: Observation;
    try {
      observation = await session.perceiver.observe(frame);
    } catch (error) {
      await this.#endSession(`perception failed: ${message(error)}`, { report: true });
      return;
    }
    if (!this.#running || this.#session !== session) return;

    const now = this.#now();
    this.#lastObservation = observation;
    this.#track(observation);
    if (observation.screen !== this.#lastScreen) {
      // The screen is what progress means: an action that changed nothing is not progress.
      this.#lastScreen = observation.screen;
      this.#lastProgressAtMs = now;
    }

    if (this.#cfg.sessionMaxMinutes > 0 && now - this.#sessionStartedAtMs >= this.#cfg.sessionMaxMinutes * 60_000) {
      await this.#endSession('the session time limit was reached', { report: true });
      return;
    }
    const stalledMs = now - this.#lastProgressAtMs;
    if (stalledMs >= this.#cfg.stallStopSeconds * 1000) {
      await this.#endSession(`nothing changed for ${this.#cfg.stallStopSeconds} s`, { report: true });
      return;
    }

    const state: RouteState = {
      observation,
      willpower: this.#willpower,
      chestsRemaining: this.#chestsRemaining,
    };
    const spent = this.#spentThisHour(now);
    let verdict = this.#classify(state, spent, this.#cfg.escalateMaxPerHour);
    if (verdict === 'ok' && stalledMs >= this.#stallEscalateMs()) verdict = 'escalate';

    switch (verdict) {
      case 'stop':
        await this.#endSession(this.#stopReason(observation, spent), { report: true });
        return;
      case 'escalate':
        await this.#escalate(session, frame, observation, now);
        return;
      case 'ok':
        await this.#execute(this.#policy.next(state));
        return;
    }
  }

  /** Warm-up aware capture: a failure is a skipped tick until the retries are spent (§5). */
  async #capture(session: WvdSession): Promise<Frame | null> {
    try {
      const frame = await session.source.capture();
      this.#captureFailures = 0;
      return frame;
    } catch (error) {
      this.#captureFailures += 1;
      if (this.#captureFailures <= WARMUP_TICKS) {
        this.#host?.log.warn(
          `wvd: capture failed (${this.#captureFailures}/${WARMUP_TICKS}); the engine may still be warming up`,
          message(error),
        );
        return null;
      }
      await this.#endSession(`the engine stopped answering: ${message(error)}`, { report: true });
      return null;
    }
  }

  /** The two counts the route's `RouteState` needs, from the observation that carries them. */
  #track(observation: Observation): void {
    if (observation.screen === 'chest-open') {
      this.#willpower = observation.opener.members.map((member) => member.willpower);
    }
    if (observation.screen === 'dungeonmap') {
      // The map is the only chest count the loop has: what the map still shows is the budget.
      this.#chestsRemaining = observation.map.icons.filter((icon) => icon.kind === 'chest').length;
    }
  }

  // --- the escalation ------------------------------------------------------------------------

  async #escalate(session: WvdSession, frame: Frame, observation: Observation, now: number): Promise<void> {
    if (this.#supervisor.isOpen()) return;
    if (now < this.#escalationCooldownUntilMs) {
      this.#host?.log.warn('wvd: still cooling down after the last question; not asking again yet');
      return;
    }
    const spent = this.#spentThisHour(now);
    if (spent >= this.#cfg.escalateMaxPerHour) {
      await this.#endSession('the escalation budget for this hour is spent', { report: true });
      return;
    }

    // The snapshot is a second capture at the escalation width; the verdict's frame stays the
    // authority for the decision, and its `atMs` is what the event dates the question by.
    const maxWidth = this.#cfg.escalationImageWidth;
    const snapshot = await takeSnapshot(session.snapshot, maxWidth);
    // A stop can land inside that capture. Nothing may be asked — or acted on — after it.
    if (!this.#running || this.#session !== session) return;
    const image = snapshot ? snapshotBlob(snapshot) : null;
    const imageVisible = this.#supervisor.imageAccepted();
    const question = this.#question(observation);
    const id = `esc-${this.#nextEscalationId++}`;
    const timeoutMs = this.#cfg.escalateTimeoutMs;

    const envelope = stuckEvent({
      timezone: this.#timezone,
      at: new Date(),
      atMs: frame.atMs,
      escalationId: id,
      ticksStuck: Math.max(1, Math.round((now - this.#lastProgressAtMs) / Math.max(1, this.#cfg.tickMs))),
      observation,
      question,
      fallbackLine: fallbackPhrase(FALLBACK_INTENT),
      timeoutMs,
      fallback: FALLBACK_INTENT,
      escalationsThisHour: spent,
      maxPerHour: this.#cfg.escalateMaxPerHour,
      image,
      imageVisible,
    });

    const outcome: EscalationOutcome = await this.#supervisor.escalate({
      envelope,
      question,
      id,
      atMs: now,
      frameWidth: frame.width,
      image: snapshot ? { width: snapshot.width, height: snapshot.height } : null,
      fallback: FALLBACK_INTENT,
      timeoutMs,
      onPush: () => {
        // The count arms the cap at the push, not at the answer: an unanswered question is spent.
        this.#escalationsThisHour = spent + 1;
        if (this.#hourStartMs < 0) this.#hourStartMs = now;
      },
    });

    // The session may have been stopped while the question was open. A cancelled outcome says so,
    // but a stop that raced the push settles nothing; either way a stopped loop sends no input.
    if (!this.#running || this.#session !== session) return;

    switch (outcome.kind) {
      case 'answered':
        if (outcome.intent) {
          // The model redirected the loop: that is progress, whatever the screen does next.
          this.#lastProgressAtMs = this.#now();
          await this.#execute(outcome.intent);
        }
        // No intent is a diagnosis only: the loop re-reads the screen, as promised by the receipt.
        return;
      case 'timeout':
      case 'undelivered':
        // One wait's worth of cooldown: a screen that stays unknown must not spend the hour in a
        // minute (research §5.2).
        this.#escalationCooldownUntilMs = this.#now() + Math.max(1, timeoutMs);
        await this.#execute(FALLBACK_INTENT);
        return;
      case 'cancelled':
        return;
    }
  }

  /** The question the model is asked. One line, about the screen the loop actually refused. */
  #question(observation: Observation): string {
    switch (observation.screen) {
      case 'unknown':
        return 'The screen is not one this World can name. What is it showing, and what should the loop do next?';
      case 'dungeonmap':
        return 'The map is open but the route cannot act on what it reads. Which chest should the loop take, or should it leave?';
      case 'chest-qte':
        return 'The chest QTE is on screen and this World will not gamble a tap. Where is the safe window?';
      case 'chest-open':
        return 'The opener panel is up and the route will not choose blindly. Who should open this chest?';
      default:
        return `The screen has been ${observation.screen} longer than the loop expects. Is it seeing the right thing, and what should it do?`;
    }
  }

  /** Why a `stop` verdict ended the session, in the words the operator and Coo read. */
  #stopReason(observation: Observation, spent: number): string {
    if (spent >= this.#cfg.escalateMaxPerHour) {
      return `the escalation budget for this hour is spent (${spent}/${this.#cfg.escalateMaxPerHour})`;
    }
    if (observation.screen === 'unknown' && observation.confidence <= 0) {
      return 'nothing on the screen could be perceived';
    }
    return `the session classifier stopped on a ${observation.screen} screen`;
  }

  /** The escalation width, floored so a mid-stall question is not asked about an unreadable screen. */
  #stallEscalateMs(): number {
    return Math.max(MIN_STALL_ESCALATE_MS, (this.#cfg.stallStopSeconds * 1000) / STALL_ESCALATE_DIVISOR);
  }

  /** `escalateMaxPerHour`'s window: a rolling hour owned here, because `classify` is stateless. */
  #spentThisHour(now: number): number {
    if (this.#hourStartMs < 0) this.#hourStartMs = now;
    if (now - this.#hourStartMs >= HOUR_MS) {
      this.#hourStartMs = now;
      this.#escalationsThisHour = 0;
    }
    return this.#escalationsThisHour;
  }

  // --- acting --------------------------------------------------------------------------------

  /** The one path from an `Intent` to an `Actuator` call: the escalation must not grow a second. */
  async #execute(intent: Intent): Promise<void> {
    this.#lastIntent = { intent, atMs: this.#now() };
    switch (intent.kind) {
      case 'open-map':
        // Never blind-retry this one: if the second G failed, the menu is already open and a retry
        // presses G on the map, which is 移动至目的地 — an unintended automove. Re-perceive instead.
        await this.#press('open the map', () => this.#commands.openMap());
        return;
      case 'move':
        await this.#press('walk to the nearest chest', () => this.#commands.automoveToChest());
        return;
      case 'exit':
        await this.#press('walk to the exit', () => this.#commands.automoveToExit());
        return;
      case 'open-chest':
        // The chest module's QTE control is not wired into the loop yet (post-v1): the loop will
        // re-observe, stall, and ask a human rather than gamble a tap on an unread bar.
        this.#host?.log.info('wvd: a chest is open and this loop has no QTE control yet');
        return;
      case 'fight':
        this.#host?.log.info('wvd: a battle is on screen; auto-battle is a later module');
        return;
      case 'wait':
        // The tick cadence is the wait; the next tick re-perceives.
        return;
      case 'stop':
        await this.#endSession(intent.reason, { report: true });
        return;
      default:
        return assertNever(intent);
    }
  }

  async #press(what: string, command: () => Promise<ActionResult>): Promise<void> {
    if (this.#cfg.dryRun) {
      this.#host?.log.info(`wvd: dry run, would ${what}`);
      return;
    }
    const result = await command();
    if (!result.ok) {
      // A refused or failed input is never retried here: the next tick re-perceives. A retry of a
      // half-applied command is how a farm walks somewhere nobody asked it to.
      this.#host?.log.warn(`wvd: could not ${what}`, {
        reason: result.reason,
        detail: result.detail ?? null,
      });
    }
  }

  // --- stopping ------------------------------------------------------------------------------

  /** The child's unsolicited messages. A dead safety net is a stop; a slow path is a note. */
  async onEngineEvent(event: EngineEvent): Promise<void> {
    if (!this.#running) {
      // The child can report before a session starts or after one ends: record it, stop nothing.
      if (event.kind === 'engineProblem') this.#engineProblem = event.detail;
      return;
    }
    if (event.kind === 'stopHotkey') {
      await this.#endSession('the stop hotkey was pressed', { report: true });
      return;
    }
    this.#engineProblem = event.detail;
    this.#host?.log.warn(`wvd: the engine reported a problem: ${event.detail}`);
    if (event.detail === 'stop-hotkey-unregistered') {
      // A session must not run believing the stop key works (contracts §5).
      await this.#endSession('the stop hotkey is not registered', { report: true });
    }
  }

  /** `onEventsSettled`: the only report that the question reached — or was cleared from — a session. */
  onEventsSettled(events: readonly EventEnvelope[], settlement: 'delivered' | 'discarded'): void {
    this.#supervisor.onSettled(events, settlement);
  }

  /** A turn can end for reasons that have nothing to do with our question: observe only (§5.4). */
  onTurnEnded(): void {
    if (this.#supervisor.isOpen()) {
      this.#host?.log.warn('wvd: the model turn ended with the question unanswered; still waiting');
    }
  }

  /** Close the session exactly once: settle the paused tick first, then release the engine. */
  async #endSession(reason: string, options: { report?: boolean } = {}): Promise<void> {
    const wasRunning = this.#running;
    this.#running = false;
    this.#lastStopReason = reason;
    // A paused tick nobody settles holds the host's whole 20 s stop deadline (research §4.3).
    this.#supervisor.cancel();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    try {
      unsubscribe?.();
    } catch (error) {
      this.#host?.log.warn('wvd: could not unsubscribe from the engine', message(error));
    }
    const session = this.#session;
    this.#session = null;
    try {
      session?.close?.();
    } catch (error) {
      this.#host?.log.warn('wvd: the engine did not close cleanly', message(error));
    }
    if (wasRunning && options.report !== false) await this.#reportStopped(reason);
  }

  /** One event per stopped session, and a push that may not throw into the loop (research §5.3). */
  async #reportStopped(reason: string): Promise<void> {
    const host = this.#host;
    if (!host) return;
    const event: WvdEvent = stoppedEvent({
      timezone: this.#timezone,
      at: new Date(),
      atMs: this.#now(),
      reason,
      observation: this.#lastObservation,
      escalationsThisHour: this.#spentThisHour(this.#now()),
    });
    try {
      await host.pushEvent(event, { trigger: 'flush' });
    } catch (error) {
      host.log.warn('wvd: the stop report could not be pushed', { reason, error: message(error) });
    }
  }

  /** The loop's scheduler: one timer, one tick in flight, and a paused tick is simply no timer. */
  #schedule(): void {
    if (this.#timer !== null || !this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#running) return;
      void this.tick().finally(() => {
        if (this.#running) this.#schedule();
      });
    }, Math.max(1, this.#cfg.tickMs));
    this.#timer.unref?.();
  }

  // --- the tools -----------------------------------------------------------------------------

  #handlerFor(name: string): ToolDef['handler'] {
    switch (name) {
      case 'wvd_status':
        return async () => this.#statusText();
      case 'wvd_look':
        return async (_args, ctx) => this.#look(ctx);
      case 'wvd_act':
        return async (args, ctx) => this.#act(args, ctx);
      case 'wvd_resume':
        return async (args) => this.#resume(args);
      default:
        return async () => ({ text: `wvd: ${name} has no handler`, failed: true });
    }
  }

  /** Prose, not JSON: the model reads `text` either way and prose costs fewer tokens. */
  #statusText(): string {
    if (!this.#running || !this.#session) {
      return this.#lastStopReason === null
        ? 'no session running'
        : `no session running: the last one stopped because ${this.#lastStopReason}`;
    }
    const now = this.#now();
    const parts = [
      `session running for ${Math.max(0, Math.round((now - this.#sessionStartedAtMs) / 1000))} s `
        + `(${this.#ticks} ticks)`,
    ];
    if (this.#lastIntent) {
      const age = Math.max(0, Math.round((now - this.#lastIntent.atMs) / 1000));
      parts.push(`last intent ${this.#lastIntent.intent.kind} ${age} s ago`);
    }
    if (this.#lastObservation) parts.push(`last observation ${observationLine(this.#lastObservation)}`);
    const open = this.#supervisor.open;
    if (open) {
      const waited = Math.max(0, Math.round((now - open.atMs) / 1000));
      parts.push(`a question is waiting: asked ${waited} s ago, expires in ${Math.max(0, Math.round((open.atMs + open.timeoutMs - now) / 1000))} s`);
    }
    parts.push(`escalations this hour ${this.#spentThisHour(now)}/${this.#cfg.escalateMaxPerHour}`);
    if (this.#engineProblem !== null) parts.push(`engine problem: ${this.#engineProblem}`);
    return parts.join('; ');
  }

  /** Capture again, read it, and hand the model the same frame perception just saw. */
  async #look(ctx?: ToolCallContext): Promise<ToolOutcome> {
    const session = this.#session;
    if (!session) return { text: 'not captured: no session is running', failed: true };
    if (ctx?.signal?.aborted) return { text: 'not captured: the call was cancelled', failed: true };
    try {
      const frame = await session.source.capture();
      const observation = await session.perceiver.observe(frame);
      const snapshot = await takeSnapshot(session.snapshot, this.#cfg.escalationImageWidth);
      if (!snapshot) {
        return { text: `${observationLine(observation)}. No image: the frame could not be captured again.` };
      }
      // The model's next wvd_act reads pixels of this image, so the mapping follows the newest one.
      this.#supervisor.noteImage(frame.width, snapshot);
      return {
        text: `${observationLine(observation)}. Image ${snapshot.width}×${snapshot.height}.`,
        blobs: [snapshotBlob(snapshot)],
      };
    } catch (error) {
      return { text: `not captured: ${message(error)}`, failed: true };
    }
  }

  /** One input, only while a question is open: the loop's safety rule, not the model's manners. */
  async #act(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolOutcome> {
    const open = this.#supervisor.open;
    if (!open) {
      return { text: 'not sent: no question is waiting; the loop is running on its own', failed: true };
    }
    if (this.#cfg.dryRun) {
      return { text: 'not sent: dry run is on; the game was not touched', failed: true };
    }
    if (ctx?.signal?.aborted) {
      return { text: 'not sent: the call was cancelled before any input', failed: true };
    }
    const session = this.#session;
    if (!session) return { text: 'not sent: no session is running', failed: true };

    switch (args.kind) {
      case 'tap':
      case 'doubleTap': {
        const point = this.#imagePixel(args, open);
        if (!point.ok) return { text: point.text, failed: true };
        const result = args.kind === 'tap'
          ? await session.actuator.tap(point.point)
          : await session.actuator.doubleTap(point.point);
        const what = `${args.kind === 'tap' ? 'tap' : 'double tap'} ${point.point.x}, ${point.point.y}`;
        return this.#actionReceipt(what, result);
      }
      case 'holdKey': {
        const key = typeof args.key === 'string' ? args.key.toLowerCase() : '';
        const scan = MOVEMENT_SCAN[key];
        if (scan === undefined) return { text: 'not sent: key must be one of w, a, s, d', failed: true };
        const requested = Number(args.holdMs ?? DEFAULT_ACT_HOLD_MS);
        const holdMs = Number.isFinite(requested)
          ? Math.min(MAX_ACT_HOLD_MS, Math.max(MIN_ACT_HOLD_MS, Math.round(requested)))
          : DEFAULT_ACT_HOLD_MS;
        return this.#actionReceipt(`held ${key} ${holdMs} ms`, await session.actuator.holdKey(scan, holdMs));
      }
      default:
        return { text: 'not sent: kind must be tap, doubleTap or holdKey', failed: true };
    }
  }

  /**
   * The model answered in pixels of the image it saw; the window is device pixels. One scale
   * removes the error, and a coordinate outside the image is refused with its size, never clamped
   * (research §2.5).
   */
  #imagePixel(
    args: Record<string, unknown>,
    open: { readonly image: { width: number; height: number; frameWidth: number } | null },
  ): { ok: true; point: { x: number; y: number } } | { ok: false; text: string } {
    const image = open.image;
    if (!image) {
      return { ok: false, text: 'not sent: no image was sent with the question; call wvd_look first' };
    }
    const inside = `not sent: x and y must be integers inside ${image.width}×${image.height}`;
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, text: inside };
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return { ok: false, text: inside };
    const scale = image.frameWidth / image.width;
    return { ok: true, point: { x: Math.round(x * scale), y: Math.round(y * scale) } };
  }

  #actionReceipt(what: string, result: ActionResult): ToolOutcome {
    if (result.ok) {
      this.#supervisor.countAction();
      return { text: `sent: ${what}` };
    }
    const detail = result.detail === undefined ? '' : ` (${result.detail})`;
    return { text: `not sent: ${result.reason}${detail}`, failed: true };
  }

  /** `wvd_resume`: validate, then settle the paused tick. The receipt is written after the close. */
  async #resume(args: Record<string, unknown>): Promise<ToolOutcome> {
    const parsed = parseIntent(args.intent);
    if (!parsed.ok) return { text: `not resumed: ${parsed.detail}`, failed: true };
    const note = typeof args.note === 'string' ? args.note : null;
    const receipt = this.#supervisor.answer(parsed.intent, note);
    return receipt.ok ? { text: receipt.text } : { text: receipt.text, failed: true };
  }
}

/** A new `Intent` member breaks the build here, in the same commit as the union grows. */
function assertNever(value: never): never {
  throw new Error(`unhandled intent: ${JSON.stringify(value)}`);
}
