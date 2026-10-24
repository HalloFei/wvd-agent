/**
 * The chest's fixed inputs: the two taps before its panel, and the disarm key (design §7, chest §3b).
 *
 * The taps are fixed UI points of the 1920×1080 client area, measured on the live game (2026-10-24):
 *
 * - the party standing next to a chest is offered `打开` at (955, 858); `什么也不做` sits below it
 *   and is never tapped;
 * - a battle carries `倍速` at (691, 708) and `自动` at (1231, 708). Pressing them once per battle is
 *   what makes an unattended fight end; pressing them again toggles nothing off because the game
 *   ignores a tap on an active button.
 *
 * Every function returns the actuator's `ActionResult` unchanged: a `rejected` tap (the game is not
 * foreground) is the answer, never retried here.
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';

/** `打开` on the chest prompt. `什么也不做` is at (955, 925) and is deliberately not exported. */
export const CHEST_OPEN_AT: Point = { x: 955, y: 858 };

/** The battle buttons, in the order they are pressed: speed first, then auto. */
export const BATTLE_SPEED_AT: Point = { x: 691, y: 708 };
export const BATTLE_AUTO_AT: Point = { x: 1231, y: 708 };

/**
 * The key that disarms a trapped chest's QTE: **Space**, Windows set-1 scan code `0x39`.
 *
 * The disarm is a key, not a click (chest spec §3b, recorded 2026-10-24): the on-screen 解除 hand at
 * (960, 662) is a touch target, and the keyboard does the same thing at the planner's instant. So
 * the QTE action needs no coordinate and no button detection — one press of this scan code, held for
 * `pressHoldMs`. It lives here, beside the chest's other actions, because the chest owns the fact.
 */
export const DISARM_SCAN = 0x39;

/** The pause between two UI taps: the game draws the first button's state before the second lands. */
const TAP_SETTLE_MS = 300;

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Accept the chest the party is standing at. */
export async function acceptChestPrompt(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(CHEST_OPEN_AT);
}

/** Turn on 倍速 and 自动 for the battle on screen. */
export async function enableBattleAuto(actuator: Actuator): Promise<ActionResult> {
  const speed = await actuator.tap(BATTLE_SPEED_AT);
  if (!speed.ok) return speed;
  await settle(TAP_SETTLE_MS);
  return actuator.tap(BATTLE_AUTO_AT);
}
