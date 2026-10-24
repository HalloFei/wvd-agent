/**
 * The chest policy's opener choice (chest spec §5, contracts §6/§8): which member of the
 * `由谁打开?` panel should open the chest, from the panel alone.
 *
 * The ranking the spec asks for is 陷阱解除 first — it sets the QTE's zone width — then 陷阱发现,
 * which decides whether the QTE happens at all (chest §5). Two more rules bound it:
 *
 * - **Never below the willpower floor.** A trap that fires under 60 心 may inflict 陷阱恐惧, which
 *   removes the character from the roster for the rest of the dungeon (chest §2, §6). The floor is
 *   `worlds.wvd.willpowerFloor` (contracts §8, default 60); the World passes the configured value and
 *   `WILLPOWER_FLOOR` mirrors the default so a bare `chooseOpener(panel)` still means 60.
 * - **Never a feared member**, whatever the numbers: 陷阱恐惧 bars a character from opening chests
 *   (chest §5). `feared` is not visible in the one recorded panel, so `parseOpener` reports `false`
 *   for every member; the floor above is what actually protects the choice there.
 *
 * Ties go to the higher 陷阱发现, then to the lower index (the earlier card). Deterministic on
 * purpose: the same panel must always choose the same card.
 *
 * Pure and total: every panel yields a choice or `null`, never a throw (contracts §0.6).
 */
import type { OpenerMember, OpenerPanel } from '../contracts.ts';

/**
 * The default floor: the mirror of `WVD_DEFAULTS.willpowerFloor` (contracts §8, 60). A module may not
 * import the composition root's config (contracts §0.1), so the number is repeated here and
 * `tests/opener.test.ts` cross-checks it against the config default so the two cannot drift.
 */
export const WILLPOWER_FLOOR = 60;

export interface OpenerChoice {
  readonly member: OpenerMember;
  readonly index: number;
}

/**
 * The member to open the chest with, or `null` when nobody qualifies. `index` is the member's
 * position in `panel.members` — the card it sits on, which is what the loop clicks
 * (`openerCardCentre`).
 */
export function chooseOpener(panel: OpenerPanel, willpowerFloor: number = WILLPOWER_FLOOR): OpenerChoice | null {
  const floor = Number.isFinite(willpowerFloor) ? willpowerFloor : WILLPOWER_FLOOR;
  let best = -1;

  for (let index = 0; index < panel.members.length; index += 1) {
    const member = panel.members[index]!;
    if (member.feared) continue;
    // A NaN willpower is not "above the floor": an unreadable value must never become a choice.
    if (!(member.willpower >= floor)) continue;
    if (best < 0) {
      best = index;
      continue;
    }
    const current = panel.members[best]!;
    if (member.disarm > current.disarm) best = index;
    else if (member.disarm === current.disarm && member.detect > current.detect) best = index;
    // Everything equal: the earlier card keeps the choice (strict > above), so ties are stable.
  }

  if (best < 0) return null;
  return { member: panel.members[best]!, index: best };
}
