/**
 * The session classifier (contracts §6, plan Task 8): one pure verdict on whether a session may
 * continue, must ask a human to look, or must end.
 *
 * The route policy answers "what next" from a single observation and keeps no memory, so a wall, a
 * menu that never closes and a black frame all look like "keep going". This module answers the other
 * question — *should this session continue at all?* — and never decides what to do.
 *
 * The verdicts:
 *
 * - `stop`: nothing was perceived — confidence 0 or less, whatever the screen label says (a uniform
 *   or black frame is `unknown` at confidence 0, contracts §2, and a frame nobody identified must
 *   never continue a session) — or the hourly escalation budget is spent. With no budget left a
 *   session cannot ask for help, and §8.5 defines the cap as "model calls before the session stops".
 *   A missing window is an engine failure, not an observation: the loop must stop on it itself
 *   (§0.6) rather than ask for a verdict, because one `Observation` cannot say "no window".
 * - `escalate`: perception saw something it could not name (`unknown` with confidence > 0), or named
 *   a screen with too little confidence for the route to act on (below the route's 0.5 floor). A
 *   human can look at that frame and decide.
 * - `ok`: everything else, including identified screens the route hands off by design (`loading`, a
 *   QTE, the world map, the Dungeon Select list). Those are transient: escalating them every 100 ms
 *   would spend the hourly budget in seconds. A screen that *stays* is a stall, and the loop owns
 *   that "N ticks in a row" counter — it is not one observation's business (controller ruling).
 *
 * Pure and total: same inputs, same verdict; no clock, no config, no counter of its own. The hour
 * window belongs to the caller, which passes the count it accumulated.
 */
import type { RouteState, SessionVerdict } from '../contracts.ts';

/**
 * The route's acting floor, mirrored because a module may not import another module's
 * implementation (contracts §0.1). The route treats a screen below 0.5 as not identified well
 * enough to act on, so below 0.5 is exactly the case where a human could usefully look.
 * `tests/session.test.ts` cross-checks the two numbers through the two public functions so they
 * cannot drift apart unnoticed.
 */
const ACTING_CONFIDENCE_FLOOR = 0.5;

/**
 * The verdict for one observation. `escalationsThisHour` is what the caller has already spent in
 * its own rolling hour — the window, its reset and the counting are the caller's business.
 *
 * `escalateMaxPerHour` is the caller's configured cap (§8.5) and is deliberately required: config
 * belongs to the composition root (§0.3), and a default here would silently replace the operator's
 * tuned value with the spec's 20 (review, Important 1).
 */
export function classify(
  state: RouteState,
  escalationsThisHour: number,
  escalateMaxPerHour: number,
): SessionVerdict {
  // Checked first: a session that cannot ask for help must not run on, whatever the frame shows.
  // `>=`: `escalationsThisHour` counts calls already made, so at the cap the next one would exceed
  // it, and the budget is exhausted rather than "one spare".
  if (escalationsThisHour >= escalateMaxPerHour) return 'stop';

  const { screen, confidence } = state.observation;

  // No confidence at all: nothing was perceived, so there is nothing to act on and nothing to ask
  // a human about. One rule for every label (review, Minor 2): by contract only `unknown` sits at
  // 0 (contracts §2), so a named screen at 0 is a perceiver bug — and a frame nobody identified
  // must never continue the session, whether it was labelled or not.
  if (confidence <= 0) return 'stop';

  // Something was seen but not named, so a human can look at the frame and name it.
  if (screen === 'unknown') return 'escalate';

  // Named, but not firmly enough for the route to act: the same question, one human answer.
  if (confidence < ACTING_CONFIDENCE_FLOOR) return 'escalate';

  return 'ok';
}
