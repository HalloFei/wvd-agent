/**
 * The rest town's inn, one module (operator, 2026-11-06: *make it a rest module or plugin so it is
 * modular*).
 *
 * The module's whole job is the act the screen's policy chose: one tap on the row the frame named —
 * a room (the party rests, the game heals it), 住宿 (into the room list) or the way out. The rest
 * scene itself is the game's: the dialog closes, the party is healed, and the loop is back in the
 * town, which the orientation owns. Nothing here waits or guesses a point.
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';

/** Take the row the policy chose. A refused press is the caller's value, not a retry here. */
export async function restAtInn(actuator: Actuator, at: Point): Promise<ActionResult> {
  return actuator.tap(at);
}
