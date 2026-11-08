/**
 * The arbiter of the loop's intent-driven stages (operator rule 2026-11-09, plan Task 1).
 *
 * Three stages share the loop's tick: the **orientation** (to the farm floor), the **exit** (the
 * leave goal, out of the dungeon) and a **scripted stage** (a task script, one step a tick). Each
 * used to keep its own boolean, and a boolean is a promise someone calls it. Live run 7 broke that
 * promise: the leave owned the harken page — the branch deferred to it — while its only pump sat
 * inside `run-script`, an intent the route does not return on that page. The session stopped on the
 * stall clock 150 s later. The same run had two owners on one exit path in one tick: the leave
 * pressed F and the orientation re-armed off the same frame.
 *
 * The registry is the whole of the rule and nothing else: a name, when the claim started, when the
 * owner was last given the tick, and how many ticks it has had. It knows no screen, no command and no
 * World, and every method takes `now`, so the clock stays the caller's.
 */
export type StageName = 'orient' | 'exit' | 'stage';

/** One claim: who owns the tick, since when, and when the owner was last given the tick. */
export interface StageClaim {
  readonly name: StageName;
  readonly sinceMs: number;
  readonly pumpedAtMs: number;
  readonly pumps: number;
}

/** A claim's answer: taken, or refused in the holder's name. */
export type StageClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly heldBy: StageName };

export class StageRegistry {
  #owner: StageClaim | null = null;

  /** The current owner, or null. */
  get owner(): StageClaim | null {
    return this.#owner;
  }

  /**
   * Claim the loop for `name`. Idempotent for the current owner (it re-stamps the pump); a different
   * owner is refused with the holder's name and changes nothing — not the name, not the start, not
   * the pump stamp, not the count.
   *
   * A re-claim keeps `sinceMs`: it is the same episode, and a deadline measures the episode.
   */
  claim(name: StageName, now: number): StageClaimResult {
    const owner = this.#owner;
    if (owner === null) {
      this.#owner = { name, sinceMs: now, pumpedAtMs: now, pumps: 0 };
      return { ok: true };
    }
    if (owner.name !== name) return { ok: false, heldBy: owner.name };
    this.#owner = { ...owner, pumpedAtMs: now };
    return { ok: true };
  }

  /** Release the loop. False when `name` is not the owner — a release is not a takeover. */
  release(name: StageName): boolean {
    const owner = this.#owner;
    if (owner === null || owner.name !== name) return false;
    this.#owner = null;
    return true;
  }

  /** The owner was given this tick. False when it does not own — a pump of a non-owner changes nothing. */
  pump(name: StageName, now: number): boolean {
    const owner = this.#owner;
    if (owner === null || owner.name !== name) return false;
    this.#owner = { ...owner, pumpedAtMs: now, pumps: owner.pumps + 1 };
    return true;
  }

  /** The owner has held the loop for at least `deadlineMs`. */
  overdue(now: number, deadlineMs: number): boolean {
    const owner = this.#owner;
    return owner !== null && now - owner.sinceMs >= deadlineMs;
  }
}
