/**
 * The opener panel's one action: tap the fixed card slot the policy chose.
 *
 * The panel is a fixed 2×3 grid (see `perception/opener.ts`): choosing a member is choosing a slot,
 * and the tap point is that slot's measured centre — no detection, no measurement and no adjustment
 * at click time. The upstream autoscript does exactly this, turning a configured slot into a
 * constant point; the difference here is that the slot comes from a parsed card rather than a config.
 *
 * Pure enough to test with a recording actuator; the only boundary is `Actuator.tap` (contracts §4).
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';
import { openerCardCentre } from '../perception/opener.ts';

/** Tap the card at `slot` (row-major, 0-based) to choose that member as the opener. */
export async function tapOpenerCard(actuator: Actuator, slot: number): Promise<ActionResult> {
  const centre: Point | null = openerCardCentre(slot);
  if (centre === null) {
    // The policy only ever names a parsed member, so this is a programmer error caught as a value —
    // never a blind tap at an unmeasured point (contracts §0.6).
    return { ok: false, reason: 'rejected', detail: `no card at slot ${slot}` };
  }
  return actuator.tap(centre);
}
