/**
 * The battle's operations as a **sequence** (operator rule 2026-11-04).
 *
 * A battle is turn-based, not real time: one decision can be made slowly. So the loop must not rush
 * presses. It does its operations **in order but never at the same time**, waits for a frame that has
 * stopped moving, and paces them in units of **1 s, at least 700 ms** — the same floor the pacing
 * primitive declares (`src/policy/pacing.ts`). The design record is
 * `docs/specs/2026-11-04-battle-sequencing-design.md`.
 *
 * Why the primitive alone was not enough: the pacer keys its stability on `observation.screen`, and
 * inside a battle that key is `combat` for the whole fight — so "two stable frames" is satisfied
 * ~200 ms after the battle appears, while the party panel is still drawing (live 2026-11-03 02:07:
 * the first combat frame read no gold card; the saved next frame reads 爱丽丝 at 68.8). And the
 * World stamped the pace with the frame an operation *started* on, so the opener's two taps and the
 * 自動 press after them could be ~100 ms apart, inside the skill's resolution.
 *
 * The six steps — settle → 倍速 → opener slot → opener confirm → 自動 → hold — are each one tap,
 * one at a time, each with its own evidence from the frame:
 *
 * - `settle`: nothing is pressed for `settleMs` after the battle's first named frame.
 * - 倍速 and 自動 are **toggles**: each is pressed only when the frame says it is off (contracts §2
 *   `speedOn`/`autoOn`), so a blind re-press cannot turn one back off. A press that did not take
 *   is retried on a later turn of the sequence, capped by `toggleAttempts`.
 * - the opener's slot is sent only when the ACTIVE card is **readable** (contracts §11): a null read
 *   is a wait, bounded by `readWindowMs`, and then the cast is given up — never a blind slot tap.
 * - the pace is measured from the tap's **return** (`completed`/`refused`), not from the frame the
 *   operation started on.
 *
 * The sequence never returns two operations for one call, so "one operation at a time" is a property
 * of the caller's await, not a timer.
 */
import type { BattleOpener } from '../contracts.ts';
import { openerFor } from '../actions/battle.ts';

/** What this frame says about the battle; each field is the contract's own fact, or null when absent. */
export interface BattlePhase {
  /** 倍速 on, off, or null when the frame does not show the buttons (contracts §2). */
  readonly speedOn: boolean | null;
  /** 自動 on, off, or null when the frame does not show the buttons (contracts §2). */
  readonly autoOn: boolean | null;
  /** The ACTIVE member's name from the turn card, or null when it cannot be read (contracts §11). */
  readonly activeMember: string | null;
}

/** Why a turn ended without an operation: each is the caller's cue for a log line, or silence. */
export type BattleWait = 'settle' | 'paced' | 'unreadable' | 'no-evidence' | 'speed-capped' | 'auto-capped';

/** One decision: a single operation to send, a reason to wait, or the battle's decision is done. */
export type BattleStep =
  | { readonly kind: 'wait'; readonly why: BattleWait }
  | { readonly kind: 'speed' | 'auto' | 'done' }
  | { readonly kind: 'slot' | 'confirm'; readonly opener: BattleOpener };

export interface BattleSequenceOptions {
  /** How long after the battle's first frame before the first press, ms (`battleSettleMs`). */
  readonly settleMs: number;
  /** Between two operations, measured from the previous tap's return, ms (`battleStepMs`). */
  readonly stepMs: number;
  /** How long the ACTIVE card may take to become readable before the cast is given up, ms. */
  readonly readWindowMs: number;
  /** The configured attempts per toggle (`autoBattleEnableAttempts`, contracts §8.5). */
  readonly toggleAttempts: number;
  /** The operator's opener list (contracts §11); empty means no cast is ever owed. */
  readonly openers: readonly BattleOpener[];
}

type Operation = 'speed' | 'slot' | 'confirm' | 'auto';

export class BattleSequence {
  readonly #options: BattleSequenceOptions;
  #enteredAtMs: number | null = null;
  /** When the previous tap returned; the next operation waits `stepMs` from here. */
  #lastTapAtMs: number | null = null;
  /** The opener the turn card decided; undefined until a turn card is read, null for no cast. */
  #opener: BattleOpener | null | undefined = undefined;
  /** When the read first came back unreadable; the read window's clock. */
  #readSinceMs: number | null = null;
  #slotSent = false;
  #confirmSent = false;
  #speedTries = 0;
  #autoTries = 0;
  /** The operation the last `next` returned, so `completed` can count it. */
  #sent: Operation | null = null;

  constructor(options: BattleSequenceOptions) {
    this.#options = options;
  }

  /** The battle's first named frame. The first call wins: a re-entry is the same battle. */
  enter(nowMs: number): void {
    if (this.#enteredAtMs !== null) return;
    this.#enteredAtMs = nowMs;
  }

  /**
   * True when the next decision needs the ACTIVE card's name. It is false on every frame the decision
   * would not use a read: before the settle window, with no configured opener, once the opener is
   * decided, while 倍速 is still owed (it is pressed before the cast), in a battle that already plays
   * itself (no command phase is drawn), and inside the step pace (the next call would only wait).
   * Without this the World reads — and logs — once per tick instead of once per decision.
   */
  needsMemberRead(phase: BattlePhase, nowMs: number): boolean {
    if (this.#enteredAtMs === null) return false;
    if (nowMs - this.#enteredAtMs < this.#options.settleMs) return false;
    if (this.#options.openers.length === 0 || this.#opener !== undefined) return false;
    if (phase.speedOn !== true || phase.autoOn === true) return false;
    return this.#lastTapAtMs === null || nowMs - this.#lastTapAtMs >= this.#options.stepMs;
  }

  /** One decision for this tick. The caller sends at most one tap and reports its return. */
  next(phase: BattlePhase, nowMs: number): BattleStep {
    this.#sent = null;
    if (this.#enteredAtMs === null) return { kind: 'wait', why: 'settle' };
    if (nowMs - this.#enteredAtMs < this.#options.settleMs) return { kind: 'wait', why: 'settle' };
    // A battle already playing itself draws no command phase, so nothing can be cast into it; and an
    // empty opener list has nothing to cast either way. Deciding here keeps the read window unpaid.
    if (phase.autoOn === true && this.#opener === undefined) this.#opener = null;
    if (this.#opener === undefined && this.#options.openers.length === 0) this.#opener = null;

    const paced = this.#lastTapAtMs === null || nowMs - this.#lastTapAtMs >= this.#options.stepMs;
    if (!paced) return { kind: 'wait', why: 'paced' };

    // 1. 倍速: the battle's clock, and everything after it rides on it.
    if (phase.speedOn === null) return { kind: 'wait', why: 'no-evidence' };
    if (!phase.speedOn) {
      if (this.#speedTries >= this.#options.toggleAttempts) return { kind: 'wait', why: 'speed-capped' };
      this.#sent = 'speed';
      return { kind: 'speed' };
    }

    // 2. The opener: the turn card decides whether there is a cast, and an unreadable panel is a wait,
    // never a slot tap. The window's expiry is the miss the cast cannot recover from.
    if (this.#opener === undefined) {
      if (phase.activeMember !== null) {
        this.#opener = openerFor(phase.activeMember, this.#options.openers);
        this.#readSinceMs = null;
      } else {
        this.#readSinceMs ??= nowMs;
        if (nowMs - this.#readSinceMs < this.#options.readWindowMs) return { kind: 'wait', why: 'unreadable' };
        this.#opener = null;
      }
    }

    // 3. The cast: the slot, then the press that resolves the skill — two operations, not one.
    if (this.#opener !== null) {
      if (!this.#slotSent) {
        this.#sent = 'slot';
        return { kind: 'slot', opener: this.#opener };
      }
      if (!this.#confirmSent) {
        this.#sent = 'confirm';
        return { kind: 'confirm', opener: this.#opener };
      }
    }

    // 4. 自動: the battle plays itself from here.
    if (phase.autoOn === null) return { kind: 'wait', why: 'no-evidence' };
    if (!phase.autoOn) {
      if (this.#autoTries >= this.#options.toggleAttempts) return { kind: 'wait', why: 'auto-capped' };
      this.#sent = 'auto';
      return { kind: 'auto' };
    }

    // 5. Both toggles on and the opener decided: nothing to press; the mode holds until it ends.
    return { kind: 'done' };
  }

  /** The tap `next` named returned: the pace starts here, and the operation counts. */
  completed(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
    switch (this.#sent) {
      case 'speed': this.#speedTries += 1; break;
      case 'auto': this.#autoTries += 1; break;
      case 'slot': this.#slotSent = true; break;
      case 'confirm': this.#confirmSent = true; break;
      default: break;
    }
    this.#sent = null;
  }

  /**
   * The tap `next` named was refused or failed: the game was not foreground, so nothing was sent.
   * The pace still applies (no hammering) but the attempt is not spent — the step stays owed, and the
   * stall clock is what bounds a window that never comes back.
   */
  refused(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
    this.#sent = null;
  }
}
