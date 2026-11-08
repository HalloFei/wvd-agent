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
 *    the two buttons. 关闭 is (854, 813); **恢复 is (1070, 813)**. The dialog's screen name is
 *    **`quick-heal`** (operator, 2026-11-03); it is not perceived yet, so its taps are still blind.
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

/**
 * 恢复 in the 一键恢复 dialog: the right-hand button, measured live 2026-11-09 at **(1087, 802)**
 * (the dialog's button row sits 36 px above the 2026-11-01 coordinate, which is why the old press
 * could be "sent" and do nothing). The heal uses the point the dialog reader **matched**; this is the
 * fallback for a caller with no frame.
 */
export const AUTO_HEAL_CONFIRM_AT: Point = { x: 1_087, y: 802 };
/** 关闭 in the same dialog: the left-hand button, measured 2026-11-09. */
export const AUTO_HEAL_CANCEL_AT: Point = { x: 850, y: 802 };

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

/**
 * Close the character page; the toast 「已恢复。」 rides over it. **One tap**, and it works — measured
 * live 2026-11-03 03:47: the tap at (699,1012) dropped the page and the frame answered `dungeon` 0.88.
 *
 * The 03:18 failure was timing, not the point: the close was sent 900 ms after 恢复, while the dialog
 * was still being retired, and was swallowed. The settle before the close is now its own, longer one.
 *
 * A **second** tap is *not* harmless: on the 3-D view the same point opens another member's page
 * (measured the same night), so a blind re-close would trade one page for another.
 */
export async function closeCharacterPage(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(CHARACTER_PAGE_CLOSE_AT);
}

/** How long each screen of the heal needs before the next tap lands on it (measured live ~1 s). */
export const HEAL_STEP_SETTLE_MS = 900;

/**
 * The pause between 恢复 and the close. Longer than a step: the dialog animates out and the toast rides
 * over the page, and the close sent inside that window is swallowed (live 2026-11-03 03:18 — the page
 * stayed up and the loop stalled on it). Measured 2026-11-03 03:47: a close after the dialog was gone
 * dropped the page in one tap.
 */
export const HEAL_CLOSE_SETTLE_MS = 1_500;

/**
 * The whole heal in one command: party card -> sparkle -> 恢复 -> close, one tap per screen with the
 * measured settle between them. The caller owns the decision (when a heal is due) and the guard
 * (only from the 3-D view); a refused tap stops the sequence and is returned unchanged.
 */
export async function healParty(
  actuator: Actuator,
  sleep: (ms: number) => Promise<void>,
): Promise<ActionResult> {
  // The page, the sparkle, 恢复 — then the close after the dialog has retired (HEAL_CLOSE_SETTLE_MS).
  for (const at of [CHARACTER_PAGE_AT, AUTO_HEAL_AT, AUTO_HEAL_CONFIRM_AT]) {
    const result = await actuator.tap(at);
    if (!result.ok) return result;
    await sleep(HEAL_STEP_SETTLE_MS);
  }
  await sleep(HEAL_CLOSE_SETTLE_MS - HEAL_STEP_SETTLE_MS);
  return closeCharacterPage(actuator);
}
