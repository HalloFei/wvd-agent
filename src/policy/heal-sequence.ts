/**
 * One heal, as a sequence with observable steps (operator rule 2026-11-07: *only next order based on the
 * current stable frame. no competing orders*).
 *
 * The old heal was one blocking composite — card, sparkle, 恢复 and close with fixed sleeps between —
 * and it returned "ok" when the four taps were *sent*. Nothing said the page was gone, \`#healDue\` was
 * cleared before the close even left, and the route then asked for \`open-map\` on a frame that was still
 * the page (live 2026-11-07 23:39-23:42, run 21: seven \`open-map was overtaken: the screen is now
 * character-page\` at a 21 s period, then a stall).
 *
 * This sequence owns the heal from the party card to the page being gone:
 *
 *   card → sparkle → 恢复 → close → (wait for the page to leave) → done
 *
 * Each step is sent only from a frame that has held its own name, the page's close is **verified** rather
 * than hoped for, and a page that will not close gets one \`Esc\` before the sequence gives up. Nothing here
 * presses a point: the caller owns the taps and reports their return.
 */
import type { ScreenId } from '../contracts.ts';

export type HealStepKind = 'card' | 'sparkle' | 'restore' | 'close';

export type HealStep =
  | { readonly kind: 'wait'; readonly why: 'settle' | 'unstable' | 'paced' | 'page-closing' }
  | { readonly kind: HealStepKind; readonly at: 'dungeon' | 'page' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'done'; readonly why: 'closed' | 'gave-up' };

/** What one frame says: the screen it named, how many frames in a row named it, and whether it is the page. */
export interface HealPhase {
  readonly screen: ScreenId;
  readonly stable: number;
  readonly page: boolean;
}

export interface HealOptions {
  /** Frames that must name a screen before a step is sent from it. */
  readonly stableFrames: number;
  /** Between two steps, measured from the previous tap's return, ms. */
  readonly stepMs: number;
  /** How long the page may take to leave after the close press, ms. */
  readonly graceMs: number;
  /** How long the \`Esc\` gets before the sequence gives up, ms. */
  readonly escapeGraceMs: number;
  /**
   * The whole sequence's bound, ms: from enter to done, whatever it is waiting for.
   *
   * Without it the sequence hangs on the one thing it cannot see: a card tap that never opened the
   * page (a battle started instead, or the tap was swallowed) leaves it waiting for a page that will
   * never come — a worse stall than the composite it replaces. Measured live 2026-11-08: the four taps
   * with their settles are ~4.5 s, so 12 s is the whole heal plus two chances at every step.
   */
  readonly deadlineMs: number;
}

const STEPS: readonly HealStepKind[] = ['card', 'sparkle', 'restore', 'close'];

export class HealSequence {
  readonly #options: HealOptions;
  #enteredAtMs: number | null = null;
  #next = 0;
  #lastTapAtMs: number | null = null;
  #closeAtMs: number | null = null;
  #escapedAtMs: number | null = null;

  constructor(options: HealOptions) {
    this.#options = options;
  }

  enter(nowMs: number): void {
    this.#enteredAtMs ??= nowMs;
  }

  /** One step for this tick, or a reason to wait. The caller sends at most one tap. */
  next(phase: HealPhase, nowMs: number): HealStep {
    if (this.#enteredAtMs === null) return { kind: 'wait', why: 'settle' };
    // The deadline is the sequence's own bound: nothing it waits for may outlive it.
    if (nowMs - this.#enteredAtMs >= this.#options.deadlineMs) return { kind: 'done', why: 'gave-up' };
    const paced = this.#lastTapAtMs === null || nowMs - this.#lastTapAtMs >= this.#options.stepMs;
    if (!paced) return { kind: 'wait', why: 'paced' };

    // The page's own steps: once the card opened it, the rest are sent from the page's frames, and the
    // page is the only thing that may be on screen until it is gone.
    if (this.#next > 0 && this.#next < STEPS.length) {
      if (phase.stable < this.#options.stableFrames) return { kind: 'wait', why: 'unstable' };
      if (!phase.page) return { kind: 'wait', why: 'unstable' };
      return { kind: STEPS[this.#next]!, at: 'page' };
    }

    // The close has been sent: the page must leave before the heal is done.
    if (this.#next === STEPS.length) {
      if (!phase.page) {
        if (phase.stable >= this.#options.stableFrames) return { kind: 'done', why: 'closed' };
        return { kind: 'wait', why: 'unstable' };
      }
      const since = this.#closeAtMs ?? nowMs;
      if (this.#escapedAtMs !== null) {
        if (nowMs - this.#escapedAtMs < this.#options.escapeGraceMs) return { kind: 'wait', why: 'page-closing' };
        return { kind: 'done', why: 'gave-up' };
      }
      if (nowMs - since < this.#options.graceMs) return { kind: 'wait', why: 'page-closing' };
      return { kind: 'escape' };
    }

    // The first step starts from the dungeon itself, and the dungeon is what was named and stable.
    if (phase.stable < this.#options.stableFrames) return { kind: 'wait', why: 'unstable' };
    return { kind: STEPS[this.#next]!, at: 'dungeon' };
  }

  /** The tap the last \`next\` named returned: the pace starts here and the step advances. */
  completed(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
    if (this.#next < STEPS.length) {
      if (STEPS[this.#next] === 'close') this.#closeAtMs = nowMs;
      this.#next += 1;
    }
  }

  /** A refused or failed tap: the pace applies, the step stays owed. */
  refused(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
  }

  /**
   * What the sequence is waiting on, for the log: the step it owes and how many it has sent.
   *
   * A give-up is the one outcome that needs this. `gave-up` alone says the bound was hit, not which
   * step was owed — and on 2026-11-08 a live give-up was diagnosable only by replaying the four steps
   * from a saved frame. The line names the step, so the next one names its cause.
   */
  get owed(): { readonly step: HealStepKind; readonly sent: number } {
    return { step: STEPS[Math.min(this.#next, STEPS.length - 1)]!, sent: this.#next };
  }

  /** The \`escape\` was sent: the grace clock restarts from it. */
  escaped(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
    this.#escapedAtMs = nowMs;
  }
}
