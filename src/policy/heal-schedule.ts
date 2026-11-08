/**
 * When the party is owed a heal (operator's matrix, 2026-11-09).
 *
 * The loop used to answer one question — "did a battle or a chest just happen?" — with a hardcoded
 * flag, cleared *before* the sequence ran. Two consequences made every heal fix a new regression:
 *
 * - there was no frequency: every battle and every chest, whether the party needed it or not, and no
 *   way to turn one of them down or make it "every Nth";
 * - a give-up **dropped the debt**. The sequence's only bound was a deadline on frames it could act
 *   on, so a game animation slower than the deadline ended the heal for good — and the loop's own
 *   page-close branch then closed the page the heal had just opened, leaving the party unhealed.
 *
 * This module is the debt, separated from the taps. It counts **events** (a completed battle, a
 * completed chest, the entry into the farm floor, a rest) and answers one question per tick: is a heal
 * due? The World owns the sequence and the page; this owns *when* and *whether the debt survives*.
 *
 * Invariants (the ones the old code broke):
 *
 * - A heal is paid only by a **completed** heal. An abandoned attempt (the frame was taken by a
 *   battle or a chest) keeps the debt; a give-up **re-arms** it once with a backoff, and only the last
 *   give-up of an episode spends it.
 * - The counters are per episode, reset on completion or on the episode's end — not per tick, so the
 *   Nth battle/chest is counted once.
 * - Nothing here knows a screen, a point or a deadline elapsed. Pure: one event in, one answer out.
 */

/** What made the party owe a heal. */
export type HealCause = 'battles' | 'chests' | 'entry' | 'rest';

/** The matrix, as the config declares it. `0` is off; `1` is every event; `N` is every Nth. */
export interface HealScheduleOptions {
  readonly afterBattles: number;
  readonly afterChests: number;
  readonly onEntry: boolean;
  readonly afterRest: boolean;
  /**
   * How many attempts one episode gets: the first, then one re-arm per give-up. A heal that keeps
   * failing on an unnamed screen must not block the farm forever — after this many give-ups the debt
   * is spent and the next battle or chest arms a fresh episode.
   */
  readonly maxAttempts?: number;
  /** The pause between a give-up and the re-arm, ms. The page-close branch has that window to act. */
  readonly retryBackoffMs?: number;
}

export type HealDue = { readonly due: false } | { readonly due: true; readonly cause: HealCause };

/** The pause before a re-arm: long enough for the loop's own page close to run first. */
const DEFAULT_RETRY_BACKOFF_MS = 1_500;
const DEFAULT_MAX_ATTEMPTS = 2;

export class HealSchedule {
  readonly #afterBattles: number;
  readonly #afterChests: number;
  readonly #onEntry: boolean;
  readonly #afterRest: boolean;
  readonly #maxAttempts: number;
  readonly #retryBackoffMs: number;

  /** Completed events this episode. */
  #battles = 0;
  #chests = 0;
  /** The armed entry/rest flags: set by the cycle's own events, spent with the episode. */
  #entry = false;
  #rest = false;
  /** Given-up attempts in this episode, and the earliest instant the next one may start. */
  #attempts = 0;
  #retryAtMs = 0;

  constructor(options: HealScheduleOptions) {
    this.#afterBattles = Math.max(0, Math.trunc(options.afterBattles));
    this.#afterChests = Math.max(0, Math.trunc(options.afterChests));
    this.#onEntry = options.onEntry;
    this.#afterRest = options.afterRest;
    this.#maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.#retryBackoffMs = Math.max(0, Math.trunc(options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS));
  }

  /** A battle finished (the game's battle mode left the frame). */
  battleCompleted(): void {
    this.#battles += 1;
  }

  /** A chest finished (its screens ended, the loot was claimed). */
  chestCompleted(): void {
    this.#chests += 1;
  }

  /** The orientation landed on the farm floor: the cycle's entry. */
  enteredFloor(): void {
    if (this.#onEntry) this.#entry = true;
  }

  /** The cycle's rest is over: the party came back to town from the inn. */
  rested(): void {
    if (this.#afterRest) this.#rest = true;
  }

  /** Is a heal owed on this tick, and why? The backoff and the attempt cap are applied here. */
  due(nowMs: number): HealDue {
    if (nowMs < this.#retryAtMs) return { due: false };
    if (this.#entry) return { due: true, cause: 'entry' };
    if (this.#rest) return { due: true, cause: 'rest' };
    if (this.#afterBattles > 0 && this.#battles >= this.#afterBattles) return { due: true, cause: 'battles' };
    if (this.#afterChests > 0 && this.#chests >= this.#afterChests) return { due: true, cause: 'chests' };
    return { due: false };
  }

  /** Does the party still owe a heal (ignoring the backoff)? For the log and the tests. */
  get owed(): boolean {
    return this.#entry || this.#rest
      || (this.#afterBattles > 0 && this.#battles >= this.#afterBattles)
      || (this.#afterChests > 0 && this.#chests >= this.#afterChests);
  }

  /** The heal completed: the debt is paid and the next episode starts at zero. */
  completed(): void {
    this.#spend();
  }

  /**
   * The attempt was abandoned because another screen took the frame (a battle, a chest): the debt
   * stays, and the next attempt starts at once — the interruption is not the heal's failure.
   */
  abandoned(): void {
    this.#attempts = 0;
    this.#retryAtMs = 0;
  }

  /**
   * The sequence gave up at its own bound. The first give-up keeps the debt and re-arms after the
   * backoff; the last one spends it, so an unfixable page cannot hold the farm.
   */
  gaveUp(nowMs: number): boolean {
    this.#attempts += 1;
    if (this.#attempts < this.#maxAttempts) {
      this.#retryAtMs = nowMs + this.#retryBackoffMs;
      return true;
    }
    this.#spend();
    return false;
  }

  /** The trip through the dungeon cancels the heal (operator rule 2026-11-03): the debt is spent. */
  cancel(): void {
    this.#spend();
  }

  /** A cycle boundary: the per-cycle counts and flags start again, and no episode is inherited. */
  resetCycle(): void {
    this.#spend();
  }

  #spend(): void {
    this.#battles = 0;
    this.#chests = 0;
    this.#entry = false;
    this.#rest = false;
    this.#attempts = 0;
    this.#retryAtMs = 0;
  }
}
