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
 * The steps — settle → 倍速 → 自動 off (when the cast is owed) → opener slot → opener confirm →
 * 自動 → hold — are each one tap, one at a time, each with its own evidence from the frame:
 *
 * - `settle`: nothing is pressed for `settleMs` after the battle's first named frame.
 * - 倍速 and 自動 are **toggles**: each is pressed only when the frame says it is off (contracts §2
 *   `speedOn`/`autoOn`), so a blind re-press cannot turn one back off. A press that did not take
 *   is retried on a later turn of the sequence, capped by `toggleAttempts`.
 * - **自動 off before the cast** (operator rule 2026-11-04): a battle entered with 自動 on draws no
 *   command phase, so the sequence turns 自動 off, casts the opener once by hand, and turns 自動 back
 *   on — enter → off → cast → on. A battle with no configured opener is left alone.
 * - the opener's slot is sent only when the ACTIVE card is **readable and confirmed** (contracts
 *   §11): the caller hands over the name only after it has held on consecutive frames, and a value
 *   that never confirms is a wait bounded by `openerTimeoutMs` — never a blind slot tap.
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
  /**
   * The frame is the game's blank one (a load or a fade, named `loading`). Every clock in the
   * sequence runs on **seen** time: the battle's settle, the turn card's read and the panel's 確定 are
   * all measured from frames that actually showed a battle, never from the load before them.
   */
  readonly blank?: boolean;
}

/** Why a turn ended without an operation: each is the caller's cue for a log line, or silence. */
export type BattleWait =
  | 'settle' | 'paced' | 'unreadable' | 'no-evidence' | 'speed-capped' | 'auto-capped' | 'auto-stuck';

/** One decision: a single operation to send, a reason to wait, or the battle's decision is done. */
export type BattleStep =
  | { readonly kind: 'wait'; readonly why: BattleWait }
  | { readonly kind: 'speed' | 'auto-off' | 'auto' | 'done' }
  | { readonly kind: 'slot' | 'confirm'; readonly opener: BattleOpener };

export interface BattleSequenceOptions {
  /** How long after the battle's first frame before the first press, ms (`battleSettleMs`). */
  readonly settleMs: number;
  /** Between two operations, measured from the previous tap's return, ms (`battleStepMs`). */
  readonly stepMs: number;
  /**
   * How long the opener may wait for a **confirmed** turn card before the cast is given up, ms
   * (`battleOpenerTimeoutMs`). The confirmation itself is the caller's: it reports the ACTIVE member
   * only once the same answer has held on consecutive frames (operator rule 2026-11-04: *until we get
   * a stable frame, then confirm the current state*).
   */
  readonly openerTimeoutMs: number;
  /**
   * How long the **確定** may stay owed after the slot tap before the cast is given up, ms.
   *
   * The panel is drawn a beat after the slot (the locator finds it on the next frame in every measured
   * battle). A panel that never comes is a cast that cannot resolve — and holding the confirm forever
   * is not neutral: 自動 was turned off to reach the command phase and is only pressed back on after the
   * cast is decided, so the battle waits with **no input at all** (live 2026-11-08 21:14: 751 ticks on
   * `combat 1.00`, the party at full HP, the enemy alive). Past this bound the cast is given up and the
   * next step is 自動.
   */
  readonly confirmTimeoutMs: number;
  /** The configured attempts per toggle (`autoBattleEnableAttempts`, contracts §8.5). */
  readonly toggleAttempts: number;
  /** The operator's opener list (contracts §11); empty means no cast is ever owed. */
  readonly openers: readonly BattleOpener[];
}

type Operation = 'speed' | 'auto-off' | 'slot' | 'confirm' | 'auto';

export class BattleSequence {
  readonly #options: BattleSequenceOptions;
  #enteredAtMs: number | null = null;
  /** When the previous tap returned; the next operation waits `stepMs` from here. */
  #lastTapAtMs: number | null = null;
  /** The opener the turn card decided; undefined until a turn card is read, null for no cast. */
  #opener: BattleOpener | null | undefined = undefined;
  /** When the cast first waited for a confirmed state; the opener timeout's clock. */
  #readSinceMs: number | null = null;
  #slotSent = false;
  #confirmSent = false;
  /** When the 確定 first became owed; the confirm timeout's clock. */
  #confirmSinceMs: number | null = null;
  /** The cast was given up because its panel never came: one line for the log, not one per tick. */
  #confirmGaveUp = false;
  #speedTries = 0;
  /** 自動 presses spent turning it ON; the fallback cap's count. */
  #autoTries = 0;
  /** 自動 presses spent turning it OFF to reach the command phase; the cast's own cap. */
  #autoOffTries = 0;
  /** The operation the last `next` returned, so `completed` can count it. */
  #sent: Operation | null = null;
  /** Blank time, accumulated: the operation clocks are `now - blank` (`#visible`). */
  #blankTotalMs = 0;
  #blankAtMs: number | null = null;

  constructor(options: BattleSequenceOptions) {
    this.#options = options;
  }

  /** The battle's first named frame. The first call wins: a re-entry is the same battle. */
  enter(nowMs: number): void {
    if (this.#enteredAtMs !== null) return;
    this.#enteredAtMs = this.#visible(nowMs, false);
  }

  /**
   * The operation clock: the wall clock minus every frame the game spent blank.
   *
   * A battle's load is not the battle's time. Counting it made the settle window and the turn card's
   * read expire while the screen was still black — the opener was skipped, then retried into a
   * consumed turn (operator, 2026-11-08: *only start counting when you see an actual battle frame*).
   * Pacing stays on the wall clock: the interval between two taps is a safety bound, not a deadline.
   */
  #visible(nowMs: number, blank: boolean): number {
    if (blank) {
      this.#blankAtMs ??= nowMs;
    } else if (this.#blankAtMs !== null) {
      this.#blankTotalMs += nowMs - this.#blankAtMs;
      this.#blankAtMs = null;
    }
    const inBlank = this.#blankAtMs === null ? 0 : nowMs - this.#blankAtMs;
    return nowMs - this.#blankTotalMs - inBlank;
  }

  /**
   * True when the next decision needs the ACTIVE card's name: after the settle window, with a
   * configured opener, while the cast is undecided, once 倍速 is on and while the battle is not
   * playing itself (an auto battle draws no command phase). It is **not** gated on the step pace: the
   * caller reads every frame so it can confirm the state across consecutive frames, and it is the
   * sequence's `openerTimeoutMs` that bounds the wait. Nothing is read before the settle, with no
   * configured opener, or once the cast is decided.
   */
  needsMemberRead(phase: BattlePhase, nowMs: number): boolean {
    if (this.#enteredAtMs === null) return false;
    if (this.#visible(nowMs, phase.blank === true) - this.#enteredAtMs < this.#options.settleMs) return false;
    if (this.#options.openers.length === 0 || this.#opener !== undefined) return false;
    return phase.speedOn === true && phase.autoOn !== true;
  }

  /**
   * The opener whose skill panel is waiting for its **確定**, or null when no cast is half-done.
   *
   * The slot has been sent and the resolving press has not: the operation is owed, and it needs
   * **nothing** from the frame — the panel covers the toggles, and the press is on the panel's own
   * button. That is why the fact is stated here, without a frame: the loop only dispatches the battle
   * branch when the route says `fight`, and the route's rule is that an unnamed screen is a wait, never
   * a click — so a caller that asks the sequence only on frames it can name would never send this press
   * (live 2026-11-07 22:00:11: the panel for 拉巴迪奥斯的秘术, 48 s, the run stopped).
   */
  pendingConfirm(): BattleOpener | null {
    if (this.#opener === undefined || this.#opener === null) return null;
    if (!this.#slotSent || this.#confirmSent) return null;
    return this.#opener;
  }

  /** One decision for this tick. The caller sends at most one tap and reports its return. */
  next(phase: BattlePhase, nowMs: number): BattleStep {
    this.#sent = null;
    const now = this.#visible(nowMs, phase.blank === true);
    if (this.#enteredAtMs === null) return { kind: 'wait', why: 'settle' };
    if (now - this.#enteredAtMs < this.#options.settleMs) return { kind: 'wait', why: 'settle' };
    // An empty opener list has nothing to cast: the cast is decided without a read and 自動 is never
    // touched for it.
    if (this.#opener === undefined && this.#options.openers.length === 0) this.#opener = null;

    const paced = this.#lastTapAtMs === null || nowMs - this.#lastTapAtMs >= this.#options.stepMs;
    if (!paced) return { kind: 'wait', why: 'paced' };

    // The slot tap opens the skill's detail panel, and the skill does not resolve until 確定 is pressed:
    // the confirmation is owed whatever this frame says about the toggles — the panel covers them
    // (operator, 2026-11-07: *a full team damage skill needs press confirmation after selection*).
    // Live 2026-11-07 01:05: the slot tap opened the panel, the frame stopped being `combat`, and the
    // confirm was never sent — 453 ticks, the run stopped.
    const owed = this.pendingConfirm();
    if (owed !== null) {
      this.#confirmSinceMs ??= now;
      // A panel that never comes is bounded: the confirm is owed whatever the frame says, but not
      // forever — the cast is given up and 自動 comes back (see `confirmTimeoutMs`).
      if (now - this.#confirmSinceMs < this.#options.confirmTimeoutMs) {
        this.#sent = 'confirm';
        return { kind: 'confirm', opener: owed };
      }
      this.#opener = null;
      this.#confirmGaveUp = true;
    }

    // 1. 倍速: the battle's clock, and everything after it rides on it.
    if (phase.speedOn === null) return { kind: 'wait', why: 'no-evidence' };
    if (!phase.speedOn) {
      if (this.#speedTries >= this.#options.toggleAttempts) return { kind: 'wait', why: 'speed-capped' };
      this.#sent = 'speed';
      return { kind: 'speed' };
    }

    // 2. The cast needs the command phase, and a battle that plays itself draws none: turn 自動 off,
    // then read and cast, then let the last step turn it back on (operator rule 2026-11-04).
    const castOwed = this.#opener === undefined
      ? this.#options.openers.length > 0
      : (this.#opener !== null && !this.#slotSent);
    if (phase.autoOn === true && castOwed) {
      if (this.#autoOffTries >= this.#options.toggleAttempts) {
        // The toggle will not come off: give the cast up and let the battle play itself.
        this.#opener = null;
        return { kind: 'wait', why: 'auto-stuck' };
      }
      this.#sent = 'auto-off';
      return { kind: 'auto-off' };
    }

    // 3. The opener: the turn card decides whether there is a cast, and an unreadable panel is a wait,
    // never a slot tap. The window's expiry is the miss the cast cannot recover from.
    if (this.#opener === undefined) {
      if (phase.activeMember !== null) {
        this.#opener = openerFor(phase.activeMember, this.#options.openers);
        this.#readSinceMs = null;
      } else {
        // No confirmed state yet. Keep checking — the panel is drawn a beat after the battle, and a
        // frame of anything else in between is not a decision — until the opener's own timeout.
        // The read's bound is **seen** time too: a load between two battle frames is not a failed read.
        this.#readSinceMs ??= now;
        if (now - this.#readSinceMs < this.#options.openerTimeoutMs) return { kind: 'wait', why: 'unreadable' };
        this.#opener = null;
      }
    }

    // 4. The cast: the slot, then the press that resolves the skill — two operations, not one.
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

    // 5. 自動: the battle plays itself from here (the last step found it off, or turned it off above).
    if (phase.autoOn === null) return { kind: 'wait', why: 'no-evidence' };
    if (!phase.autoOn) {
      if (this.#autoTries >= this.#options.toggleAttempts) return { kind: 'wait', why: 'auto-capped' };
      this.#sent = 'auto';
      return { kind: 'auto' };
    }

    // 6. Both toggles on and the opener decided: nothing to press; the mode holds until it ends.
    return { kind: 'done' };
  }

  /** Whether the cast was given up for a panel that never came: the World says so once. */
  confirmGaveUp(): boolean {
    return this.#confirmGaveUp;
  }

  /** The tap `next` named returned: the pace starts here, and the operation counts. */
  completed(nowMs: number): void {
    this.#lastTapAtMs = nowMs;
    switch (this.#sent) {
      case 'speed': this.#speedTries += 1; break;
      case 'auto-off': this.#autoOffTries += 1; break;
      case 'auto': this.#autoTries += 1; break;
      case 'slot': this.#slotSent = true; break;
      case 'confirm': this.#confirmSent = true; this.#confirmSinceMs = null; break;
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
