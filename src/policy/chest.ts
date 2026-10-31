/**
 * The chest policy's opener choice (chest spec §5, contracts §6/§8): which member of the
 * `由谁打开?` panel should open the chest, from the panel alone.
 *
 * The ranking is 陷阱解除 first — it sets the QTE's zone width — then 陷阱发现, which decides whether
 * the QTE happens at all (chest §5). Three rules bound it:
 *
 * - **Never below the willpower floor.** The task brief (Task 12) makes the floor a rule of the
 *   choice; chest §2/§6 explain why: a trap that fires under 60 心 may inflict 陷阱恐惧, which removes
 *   the character from the roster for the rest of the dungeon. The floor is `worlds.wvd.willpowerFloor`
 *   (contracts §8, default 60); the World passes the configured value and `WILLPOWER_FLOOR` mirrors the
 *   default so a bare `chooseOpener(panel)` still means 60.
 * - **A heart that was drawn but not read disqualifies only its card.** `parseOpener` records as
 *   `NaN` a card whose heart numeral the atlas cannot read; a non-finite value fails every floor
 *   comparison and is therefore ineligible. Nothing is substituted: the numeral might have been
 *   under the floor, and the card that fails is the one with the highest 陷阱解除 on the recorded
 *   panel — precisely where a fabricated value would do the most damage. Because the panel's cards
 *   sit at fixed slots (`OPENER_SLOTS`), losing one card's willpower never loses the panel.
 * - **A card that draws no willpower at all is the main character, and the floor does not apply.**
 *   The game never displays 心 for 主人公: the card carries no heart and no numeral, `parseOpener`
 *   records `null`, and this function accepts the member (operator rule 2026-10-31). That is not a
 *   claim that they sit at maximum — 陷阱恐惧 still applies to them in game; the panel simply never
 *   renders it for anybody, which is why the floor is a proxy for the fear check, not the check.
 * - **Never a feared member**, whatever the numbers: 陷阱恐惧 bars a character from opening chests
 *   (chest §5). `feared` is not visible in the one recorded panel, so `parseOpener` reports `false`
 *   for every member; the floor above is what actually protects the choice there.
 *
 * Ties go to the higher 陷阱发现, then to the lower index (the earlier card). Deterministic on
 * purpose: the same panel must always choose the same card — and a card is a **slot**, so the choice
 * this function returns is all the click needs.
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
 * position in `panel.members`, which is its fixed slot (`openerSlot`); `tapOpenerCard` turns that
 * index into the one point the loop taps.
 */
export function chooseOpener(panel: OpenerPanel, willpowerFloor: number = WILLPOWER_FLOOR): OpenerChoice | null {
  const floor = Number.isFinite(willpowerFloor) ? willpowerFloor : WILLPOWER_FLOOR;
  let best = -1;

  for (let index = 0; index < panel.members.length; index += 1) {
    const member = panel.members[index]!;
    if (member.feared) continue;
    // A heart the atlas could not read is `NaN` and can never be "at or above" any floor: the
    // member is ineligible, exactly as if the panel had not offered them (no substitution happens
    // anywhere). A card that draws **no heart at all** is `null` — the main character, whose
    // willpower the game never displays — so there is no number to hold against the floor and the
    // gate cannot apply: the member is eligible (operator rule 2026-10-31). 陷阱恐惧 still applies to
    // them in game; the panel does not render it for anybody, which is why the floor is a proxy and
    // not the fear test.
    const willpower = member.willpower;
    if (willpower !== null) {
      if (!Number.isFinite(willpower)) continue;
      if (willpower < floor) continue;
    }
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
