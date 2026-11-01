/**
 * The party's one-key heal (一键恢复), the game's own quick-heal.
 *
 * **Measured live 2026-11-01 (1920x1080 client), on the 第四区 map's 3-D view with the party at
 * 57/467 and 1/547 HP:**
 *
 * 1. Tap any party HUD card — the six cards are fixed at the bottom of the 3-D view — and the
 *    clicked member's page opens. (1009, 900) opened 本杰明's.
 * 2. The page's stat panel carries three round buttons at its top right, in this order: the armour
 *    page (shield + sword), 协同技能 (the linked arrows), and the auto-heal sparkle. The sparkle is
 *    the rightmost: (1220, 574). The arrow one is (1156, 574) and opens a 协同技能 dialog instead.
 * 3. The sparkle opens the 一键恢复 dialog — 恢复量 on the first/second row, 异常状态, 恢复方式, and
 *    the two buttons. 关闭 is (854, 813); **恢复 is (1070, 813)**.
 * 4. Confirming prints 「已恢复。」 and leaves the character page up; X 关闭 at the page's bottom left
 *    (699, 1012) returns to the 3-D view.
 *
 * Every function here is one tap: the spacing between them is the caller's (the World sends one
 * command per tick and lets the frame answer), and a rejected tap is returned unchanged, never
 * retried.
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';

/** A party HUD card in the 3-D view: tapping one opens that member's character page. */
export const CHARACTER_PAGE_AT: Point = { x: 1_009, y: 900 };

/** The auto-heal sparkle, right of the 协同技能 arrows on the character page's stat panel. */
export const AUTO_HEAL_AT: Point = { x: 1_220, y: 574 };

/** 恢复 in the 一键恢复 dialog: the right-hand button (关闭 is at 854, 813). */
export const AUTO_HEAL_CONFIRM_AT: Point = { x: 1_070, y: 813 };

/** X 关闭 at the character page's bottom left, back to the 3-D view. */
export const CHARACTER_PAGE_CLOSE_AT: Point = { x: 699, y: 1_012 };

/** Open the character page from the 3-D view. */
export async function openCharacterPage(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(CHARACTER_PAGE_AT);
}

/** Open the 一键恢复 dialog from the character page. */
export async function openAutoHeal(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(AUTO_HEAL_AT);
}

/** Confirm the heal: the dialog's 恢复. */
export async function confirmAutoHeal(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(AUTO_HEAL_CONFIRM_AT);
}

/** Close the character page; the toast 「已恢复。」 rides over it. */
export async function closeCharacterPage(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(CHARACTER_PAGE_CLOSE_AT);
}
