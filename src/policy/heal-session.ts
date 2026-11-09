/**
 * One heal, as an owned episode (operator's design, 2026-11-09).
 *
 * The previous heal was a step list read against the loop's per-tick screen name. It failed for the
 * same reason every time: a chest's aftermath draws frames no reader names (the loot camera, the item
 * detail page), the *global* name flipped, and the step list was abandoned — leaving its page open for
 * the loop's own close branch to fight. Seven fixes later the live run still opened and closed the
 * character page in a loop (2026-11-09 05:22-05:29).
 *
 * This episode owns the interface instead. It has four steps and three outcomes:
 *
 *   1 CARD     the page must be up                  (settled farm view -> one card tap)
 *   2 SPARKLE  the dialog must be up                (page stable -> one sparkle tap)
 *   3 RESTORE  the dialog must have gone            (dialog stable -> one 恢复 tap at its matched point)
 *   4 CLOSE    the page must be gone                (page/dialog -> Esc, or the matched cancel)
 *
 * Every step is **verified by its own material**, never by a timer, and the interruptions that matter
 * are the game's own screens — a battle, a chest QTE, a death — **and the chest flow** (the prompt,
 * the opener panel, the lid, the loot card), which is the farm's own work: the episode is *suspended*
 * and keeps its step, and the tick goes on to the route that owns that screen. An unnamed or transitional frame is not an interruption — it is a wait. A step that
 * never lands is retried a bounded number of times; only then does the episode move on (the CARD and
 * SPARKLE steps may finish *unverified*, because the only hard end is the page being gone).
 *
 * Full health is not an error: if the sparkle opens no dialog, the episode treats the heal as done
 * (nothing to heal) and closes the page. The result box after 恢复 — 「已恢复。」 or 「不需要恢复」 —
 * is the same shape and is advanced, not read.
 */
import type { Point } from '../contracts.ts';

export type HealStepKind = 'card' | 'sparkle' | 'restore' | 'close';

/** What one frame offers the episode. The World builds it; the episode asks no one else. */
export interface HealFacts {
  /** The farm view: the 3-D view, the game's mode `dungeon`, and it has held for a few frames. */
  readonly settled: boolean;
  /** The character page is up, and where its X 关闭 was matched. */
  readonly page: boolean;
  readonly pageAt: Point | null;
  /** The 一键恢复 dialog is up, where its 恢复 button was matched, and its 关闭. */
  readonly dialog: boolean;
  readonly dialogAt: Point | null;
  readonly dialogCancelAt: Point | null;
  /** A one-off result box on top (the box after 恢复, of either wording). */
  readonly message: boolean;
  readonly messageAt: Point | null;
  /** The page and its dialog are gone and a farm view has held: the heal is over. */
  readonly pageGone: boolean;
  /**
   * The game owns the frame: battle, chest QTE, revive, death — and the chest flow (prompt, panel,
   * opening, loot), the farm's own work. The step is kept.
   */
  readonly suspended: boolean;
}

export type HealDecision =
  | { readonly kind: 'wait'; readonly why: string }
  /** One command. `at` present means "tap this matched point", absent means the step's own key/tap. */
  | { readonly kind: 'send'; readonly step: HealStepKind; readonly at?: Point }
  /** Advance the result box at the matched point. */
  | { readonly kind: 'message'; readonly at: Point }
  | { readonly kind: 'done'; readonly unverified: boolean }
  | { readonly kind: 'failed'; readonly why: string };

export interface HealSessionOptions {
  /** The minimum pace between two sends, measured from the previous send's return. */
  readonly stepMs: number;
  /**
   * How long a step's fact may take before the step is **re-sent**, ms. A retry is not a pace: the
   * card's page takes ~3 s to draw, the dialog ~1-2 s after the sparkle — re-sending at the pace
   * pressed the sparkle twice before the dialog had a chance (live 2026-11-09).
   */
  readonly waits: { readonly card: number; readonly sparkle: number; readonly restore: number; readonly close: number };
  /** Taps one step gets before it is given up: card, sparkle, restore, close. */
  readonly retries: { readonly card: number; readonly sparkle: number; readonly restore: number; readonly close: number };
  /** The whole episode's wall-clock bound (a real hang, not a slow animation). */
  readonly deadlineMs: number;
}

const DEFAULT: HealSessionOptions = {
  stepMs: 900,
  waits: { card: 4_000, sparkle: 3_000, restore: 2_500, close: 2_000 },
  retries: { card: 2, sparkle: 2, restore: 2, close: 2 },
  deadlineMs: 90_000,
};

/** The step order; the cursor is the index. */
const STEPS: readonly HealStepKind[] = ['card', 'sparkle', 'restore', 'close'];

export class HealSession {
  readonly #options: HealSessionOptions;
  #step = 0;
  #enteredAtMs: number | null = null;
  #lastSendAtMs: number | null = null;
  /** When the current step's first send went out: its answer window is measured from here. */
  #stepFirstSendAtMs: number | null = null;
  readonly #sends = [0, 0, 0, 0];
  #unverified = false;

  constructor(options: Partial<HealSessionOptions> = {}) {
    this.#options = {
      ...DEFAULT,
      ...options,
      waits: { ...DEFAULT.waits, ...(options.waits ?? {}) },
      retries: { ...DEFAULT.retries, ...(options.retries ?? {}) },
    };
  }

  /**
   * Start the episode. `atPage` means the character page is already up (a page the operator or a
   * previous attempt left): the card step is skipped and the sparkle is the first act.
   */
  enter(nowMs: number, atPage = false): void {
    this.#enteredAtMs ??= nowMs;
    if (atPage) this.#advanceTo(1);
  }

  /** Move the cursor to a step and reset its answer window. */
  #advanceTo(step: number): void {
    this.#step = step;
    this.#stepFirstSendAtMs = null;
  }

  /** What the episode wants this tick. The caller sends at most one thing. */
  next(facts: HealFacts, nowMs: number): HealDecision {
    if (this.#enteredAtMs === null) return { kind: 'wait', why: 'not entered' };
    if (nowMs - this.#enteredAtMs >= this.#options.deadlineMs) return { kind: 'failed', why: 'deadline' };
    if (facts.suspended) return { kind: 'wait', why: 'suspended' };

    switch (STEPS[this.#step]) {
      case 'card': {
        // The page may already be up (a leftover): the card is satisfied without a tap.
        if (facts.page) { this.#advanceTo(1); return this.next(facts, nowMs); }
        if (!facts.settled) return { kind: 'wait', why: 'not settled' };
        if (this.#budget('card') === 0) { this.#unverified = true; this.#advanceTo(3); return this.next(facts, nowMs); }
        const cardPause = this.#pause('card', nowMs);
        if (cardPause !== null) return cardPause;
        return { kind: 'send', step: 'card' };
      }
      case 'sparkle': {
        if (facts.dialog) { this.#advanceTo(2); return this.next(facts, nowMs); }
        // A result box can arrive straight from the page: it is the game's answer, advance it.
        if (facts.message && facts.messageAt !== null) return { kind: 'message', at: facts.messageAt };
        if (facts.page) {
          if (this.#budget('sparkle') === 0) {
            // Full health may open no dialog at all: close the page and end, not fail.
            this.#unverified = true;
            this.#advanceTo(3);
            return this.next(facts, nowMs);
          }
          const sparklePause = this.#pause('sparkle', nowMs);
          if (sparklePause !== null) return sparklePause;
          return { kind: 'send', step: 'sparkle' };
        }
        // The page closed itself (Esc from somewhere, or the game): the heal is over either way.
        if (facts.pageGone) return { kind: 'done', unverified: true };
        return { kind: 'wait', why: 'page not up' };
      }
      case 'restore': {
        if (facts.message && facts.messageAt !== null) return { kind: 'message', at: facts.messageAt };
        if (facts.dialog) {
          if (this.#budget('restore') === 0) { this.#unverified = true; this.#advanceTo(3); return this.next(facts, nowMs); }
          const restorePause = this.#pause('restore', nowMs);
          if (restorePause !== null) return restorePause;
          // The 恢复 button's matched point, never a fixed coordinate.
          return { kind: 'send', step: 'restore', ...(facts.dialogAt === null ? {} : { at: facts.dialogAt }) };
        }
        // The dialog is gone: the game processed the press (healed or not needed) — that is the fact.
        this.#advanceTo(3);
        return this.next(facts, nowMs);
      }
      case 'close': {
        if (facts.pageGone) return { kind: 'done', unverified: this.#unverified };
        if (facts.message && facts.messageAt !== null) return { kind: 'message', at: facts.messageAt };
        if (facts.dialog) {
          // The dialog is still up after the restore budget: leave by its 关闭 (a matched tap).
          if (this.#budget('close') === 0) return { kind: 'failed', why: 'the dialog would not close' };
          const dialogPause = this.#pause('close', nowMs);
          if (dialogPause !== null) return dialogPause;
          const cancel = facts.dialogCancelAt ?? facts.dialogAt;
          return { kind: 'send', step: 'close', ...(cancel === null ? {} : { at: cancel }) };
        }
        if (facts.page) {
          if (this.#budget('close') === 0) return { kind: 'failed', why: 'the page would not close' };
          const pagePause = this.#pause('close', nowMs);
          if (pagePause !== null) return pagePause;
          // Esc first (legacy's PressReturn always closed the page); the page's **matched** X tile is
          // the fallback on the second send, not a fixed coordinate.
          const escFirst = this.#sends[3] === 0;
          return { kind: 'send', step: 'close', ...(escFirst || facts.pageAt === null ? {} : { at: facts.pageAt }) };
        }
        return { kind: 'wait', why: 'page closing' };
      }
      default:
        return { kind: 'failed', why: 'unknown step' };
    }
  }

  /** Why a step may not be sent yet: the minimum pace, then the step's own answer window. */
  #pause(step: HealStepKind, nowMs: number): HealDecision | null {
    if (this.#lastSendAtMs !== null && nowMs - this.#lastSendAtMs < this.#options.stepMs) {
      return { kind: 'wait', why: 'paced' };
    }
    if (this.#stepFirstSendAtMs !== null && nowMs - this.#stepFirstSendAtMs < this.#options.waits[step]) {
      return { kind: 'wait', why: 'waiting for the answer' };
    }
    return null;
  }

  /** The command was sent and returned ok: the pace starts here and the step's budget is spent. */
  sent(nowMs: number): void {
    this.#lastSendAtMs = nowMs;
    this.#stepFirstSendAtMs ??= nowMs;
    this.#sends[this.#step] = (this.#sends[this.#step] ?? 0) + 1;
  }

  /** The command was refused (not foreground): the pace applies, the step stays owed. */
  refused(nowMs: number): void {
    this.#lastSendAtMs = nowMs;
  }

  /** The step the cursor is on, for the log. */
  get step(): HealStepKind {
    return STEPS[this.#step]!;
  }

  /** How many sends the current step has spent, for the log. */
  get sentCount(): number {
    return this.#sends[this.#step] ?? 0;
  }

  #budget(step: HealStepKind): number {
    const used = this.#sends[STEPS.indexOf(step)] ?? 0;
    return Math.max(0, this.#options.retries[step] - used);
  }
}
