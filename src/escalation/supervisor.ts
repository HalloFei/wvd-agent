/**
 * The escalation handshake (research-escalation-design.md §4): one question open at a time, one
 * deferred the paused tick awaits, one timer, and receipts the three tools settle.
 *
 * The mechanism, and why it is this one:
 *
 * - The paused tick **awaits a promise**. That await *is* the pause: there is no tick while the
 *   question is open, so nothing unseen can act on the game between two of the model's calls.
 * - A tool handler settles that promise **synchronously**, before returning its receipt. No handler
 *   awaits anything long, and the answer's state is written before the receipt exists.
 * - The push is `pushEvent` with `trigger:'flush'` — never `pushDeferred`, whose item a hidden World
 *   silently drops and which returns `void`, so there would be no evidence the question was asked.
 *   The envelope's `contextDelivery` is the only synchronous evidence there is, and it is checked.
 * - The timeout is the World's own `setTimeout`, armed when the question opens. The host can swallow
 *   a delivered event in ways no World observes (the operator's pause, a delivery gate, no model),
 *   so waiting without a deadline means waiting forever.
 *
 * Host-free on purpose: everything it needs arrives through `EscalationHost`, which `WorldHost`
 * satisfies structurally. That is what makes the whole exchange testable with a fake.
 */
import type { TriggerMode } from 'cortico/core/types.ts';
import type { Intent } from '../contracts.ts';
import type { WvdEvent } from './event.ts';

/** The parts of the envelope the handshake reads: the cursor and the delivery verdict. */
export interface PushedEnvelope {
  readonly cursor: number;
  readonly contextDelivery?: 'deliver' | 'archive-only';
}

/** The slice of `WorldHost` this module uses; `WorldHost` satisfies it. */
export interface EscalationHost {
  pushEvent(event: WvdEvent, opts?: { trigger?: TriggerMode }): Promise<PushedEnvelope>;
  modelFacts?: { accepts(mime: string): boolean } | undefined;
  log?: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void } | undefined;
}

/** Why a question never reached a session: each closes the wait instead of letting it run out. */
export type UndeliveredWhy = 'archive-only' | 'unreachable' | 'discarded' | 'already-open';

export type EscalationOutcome =
  | { kind: 'answered'; intent: Intent | null; note: string | null; waitedMs: number; actions: number }
  | { kind: 'timeout'; waitedMs: number; actions: number }
  | { kind: 'undelivered'; why: UndeliveredWhy; actions: number }
  | { kind: 'cancelled'; actions: number };

/** What `wvd_act` needs to map image pixels, and what `wvd_look` may update. */
export interface EscalationImage {
  width: number;
  height: number;
  /** Device pixels of the frame the image came from: the scale `wvd_act` applies. */
  frameWidth: number;
}

/** The question currently open, as the tools see it. */
export interface OpenEscalation {
  readonly id: string;
  readonly question: string;
  readonly atMs: number;
  readonly timeoutMs: number;
  /** The loop's own recovery when nobody answers (contracts §6); the receipt names it. */
  readonly fallback: Intent;
  image: EscalationImage | null;
  actions: number;
}

export interface EscalationRequest {
  readonly envelope: WvdEvent;
  readonly question: string;
  readonly id: string;
  /** `performance.now()` when the verdict fired. */
  readonly atMs: number;
  readonly frameWidth: number;
  readonly image: { readonly width: number; readonly height: number } | null;
  readonly fallback: Intent;
  readonly timeoutMs: number;
  /** Called once when the envelope comes back (or when the push throws): the loop counts pushes. */
  readonly onPush?: () => void;
}

export interface ResumeReceipt {
  readonly ok: boolean;
  readonly text: string;
}

interface Pending {
  readonly open: OpenEscalation;
  readonly settle: (outcome: EscalationOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  cursor: number | null;
  deliveredAtMs: number | null;
  settled: boolean;
}

/** One clock for the wait: `performance.now()`, the World's own (contracts §0.4). */
const defaultNow = (): number => performance.now();

export class Supervisor {
  #pending: Pending | null = null;
  #last: { readonly outcome: EscalationOutcome; readonly atMs: number; readonly fallback: Intent } | null = null;

  constructor(
    private readonly host: () => EscalationHost | null,
    private readonly now: () => number = defaultNow,
  ) {}

  /** The open question, or null. `wvd_act` refuses without one; `wvd_look` ignores it. */
  get open(): OpenEscalation | null {
    return this.#pending?.open ?? null;
  }

  isOpen(): boolean {
    return this.#pending !== null;
  }

  /**
   * Whether the active endpoint can attach a JPEG. Wrapped because `ModelFacts.accepts` throws when
   * the active provider names a missing endpoint (research §2.2); a throw is "no", not a crash.
   */
  imageAccepted(): boolean {
    const facts = this.host()?.modelFacts;
    if (!facts) return false;
    try {
      return facts.accepts('image/jpeg') === true;
    } catch {
      return false;
    }
  }

  /** `wvd_look` sends a newer image: the next `wvd_act` reads pixels of that one, not the old one. */
  noteImage(frameWidth: number, image: { readonly width: number; readonly height: number }): void {
    if (this.#pending) {
      this.#pending.open.image = { width: image.width, height: image.height, frameWidth };
    }
  }

  /**
   * Ask the question and wait for the answer, the deadline or a cancel. Never throws: an absent
   * host, a dead lease and an archived event are all `undelivered`, which the loop answers with its
   * own fallback.
   */
  async escalate(request: EscalationRequest): Promise<EscalationOutcome> {
    // One open at a time (research §5.2): a second question cannot be correlated with its answer.
    if (this.#pending) {
      return { kind: 'undelivered', why: 'already-open', actions: this.#pending.open.actions };
    }
    const host = this.host();
    if (!host) return { kind: 'undelivered', why: 'unreachable', actions: 0 };

    const open: OpenEscalation = {
      id: request.id,
      question: request.question,
      atMs: request.atMs,
      timeoutMs: request.timeoutMs,
      fallback: request.fallback,
      image: request.image === null
        ? null
        : { width: request.image.width, height: request.image.height, frameWidth: request.frameWidth },
      actions: 0,
    };

    const outcome = await new Promise<EscalationOutcome>((resolve) => {
      const pending: Pending = {
        open,
        settle: (result) => {
          if (pending.settled) return;
          pending.settled = true;
          if (pending.timer !== null) {
            clearTimeout(pending.timer);
            pending.timer = null;
          }
          if (this.#pending === pending) this.#pending = null;
          this.#last = { outcome: result, atMs: this.now(), fallback: open.fallback };
          resolve(result);
        },
        timer: null,
        cursor: null,
        deliveredAtMs: null,
        settled: false,
      };
      pending.timer = setTimeout(() => {
        const waitedMs = this.now() - open.atMs;
        host.log?.warn('wvd: the escalation timed out', { id: open.id, waitedMs, actions: open.actions });
        pending.settle({ kind: 'timeout', waitedMs, actions: open.actions });
      }, Math.max(1, request.timeoutMs));
      pending.timer.unref?.();
      this.#pending = pending;
      void this.push(host, pending, request);
    });
    return outcome;
  }

  private async push(host: EscalationHost, pending: Pending, request: EscalationRequest): Promise<void> {
    let envelope: PushedEnvelope | null = null;
    try {
      envelope = await host.pushEvent(request.envelope, { trigger: 'flush' });
    } catch (error) {
      // A push from a dead host lease throws (`HOST_LIFECYCLE_ENDED`): a value, not a crash (§5.3).
      host.log?.warn('wvd: the question could not be pushed', { id: pending.open.id, error: String(error) });
      pending.settle({ kind: 'undelivered', why: 'unreachable', actions: pending.open.actions });
      return;
    }
    request.onPush?.();
    if (!envelope) {
      pending.settle({ kind: 'undelivered', why: 'unreachable', actions: pending.open.actions });
      return;
    }
    pending.cursor = envelope.cursor;
    if (envelope.contextDelivery === 'archive-only') {
      // Nobody will see it: a hidden World's event is archived, not queued. Stop waiting now.
      pending.settle({ kind: 'undelivered', why: 'archive-only', actions: pending.open.actions });
      return;
    }
    pending.deliveredAtMs = this.now();
    host.log?.info('wvd: the escalation was delivered', { id: pending.open.id, cursor: envelope.cursor });
  }

  /**
   * The receipt for an answer that arrives with no question open. Pure: it reads what the last
   * question did and settles nothing, so a caller may ask before validating its arguments.
   */
  lateReceipt(): ResumeReceipt {
    const last = this.#last;
    if (last?.outcome.kind === 'timeout') {
      const seconds = Math.max(1, Math.round((this.now() - last.atMs) / 1000));
      return {
        ok: false,
        text: `not resumed: this question expired ${seconds} s ago; the loop ${fallbackWord(last.fallback)}`,
      };
    }
    if (last?.outcome.kind === 'undelivered') {
      return {
        ok: false,
        text: `not resumed: the question never reached the session (${last.outcome.why}); the loop ${fallbackWord(last.fallback)}`,
      };
    }
    return { ok: false, text: 'not resumed: nothing is waiting for an answer' };
  }

  /** `wvd_resume`: close first, then release the paused tick. Never called for a closed question. */
  answer(intent: Intent | null, note: string | null): ResumeReceipt {
    const pending = this.#pending;
    if (!pending) return this.lateReceipt();
    const waitedMs = this.now() - pending.open.atMs;
    pending.settle({ kind: 'answered', intent, note, waitedMs, actions: pending.open.actions });
    this.host()?.log?.info('wvd: the escalation was answered', { id: pending.open.id, intent: intent?.kind ?? null, note, waitedMs });
    return {
      ok: true,
      text: intent ? `resumed: the loop takes ${intent.kind}` : 'resumed: the loop reads the screen again',
    };
  }

  /** One more input sent while the question is open; reported with the question's outcome. */
  countAction(): void {
    if (this.#pending) this.#pending.open.actions += 1;
  }

  /**
   * `World.onEventsSettled`: the only report that a batch reached the session. `delivered` is
   * recorded; `discarded` (the operator cleared the queue) closes the wait instead of letting the
   * deadline run out.
   */
  onSettled(events: readonly { readonly cursor: number }[], outcome: 'delivered' | 'discarded'): void {
    const pending = this.#pending;
    if (!pending || pending.cursor === null) return;
    if (!events.some((event) => event.cursor === pending.cursor)) return;
    if (outcome === 'delivered') {
      pending.deliveredAtMs = this.now();
      return;
    }
    pending.settle({ kind: 'undelivered', why: 'discarded', actions: pending.open.actions });
  }

  /** `stop()`'s first statement: a paused tick nobody settles holds the host's whole stop deadline. */
  cancel(): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    pending.settle({ kind: 'cancelled', actions: pending.open.actions });
    return true;
  }
}

/** The event's own words for the fallback, for a receipt that has to name what happened. */
function fallbackWord(intent: Intent): string {
  switch (intent.kind) {
    case 'open-map': return 'opened the map';
    case 'move': return 'walked to the nearest chest';
    case 'open-chest': return 'tried the chest it was standing on';
    case 'fight': return 'stayed in the battle';
    case 'exit': return 'leaves the dungeon and restarts the route';
    case 'run-script': return 'runs the task script';
    case 'wait': return 'waited and looked again';
    case 'stop': return 'stopped the session';
  }
}
