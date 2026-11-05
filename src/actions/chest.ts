/**
 * The chest's fixed inputs: the two taps before its panel, the disarm key, and the one tap that
 * collects the loot (design §7, chest §3b).
 *
 * The taps are fixed UI points of the 1920×1080 client area, measured on the live game:
 *
 * - the party standing next to a chest is offered `打开` at (955, 858); `什么也不做` sits below it
 *   and is never tapped;
 * - a battle carries `倍速` at (691, 708) and `自动` at (1231, 708). Pressing them once per battle is
 *   what makes an unattended fight end; pressing them again toggles nothing off because the game
 *   ignores a tap on an active button;
 * - the loot overlay collects with one tap at (960, 510), measured live on 2026-10-31: the contents
 *   card itself is the target and no control is drawn under the point.
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

/**
 * The QTE's cancel control: the round ✕ left of the hotbar, at (738, 758) on the 1920×1080 client.
 *
 * **Scaled, not natively measured.** The live 2026-10-31 QTE frame was saved at 1280 wide
 * (`.tmp/qte-now.jpg`: the ✕ centre is (492, 505) there), so this point is that reading × 1.5. The
 * chest spec §4 makes the cancellation free (no attempt is spent on a floor chest), which is what
 * makes the attempt-vs-reroll policy possible at all; a native 1920 capture of the QTE replaces this
 * number with a measured one (the same capture the narrow-bar fixture is owed).
 */
export const QTE_CANCEL_AT: Point = { x: 738, y: 758 };

/** Leave the QTE without spending an attempt (chest §4). */
export async function cancelQte(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(QTE_CANCEL_AT);
}

/**
 * The step that re-engages a chest after a cancel: **S (Windows set-1 `0x1f`), held long enough to
 * leave the tile** — the operator's rule (2026-10-31): after a cancel the party stands *on* the
 * chest's tile, so the chest cannot be seen and no prompt is offered; one step back makes it
 * adjacent again, and the game draws 打开. Measured live: a 300 ms hold moved the party one tile
 * back and the chest prompt appeared on the next frame. WASD is camera-relative, and the cancel
 * leaves the party facing the chest it just opened, so S is the step away from it.
 *
 * The hold is the navigation key `hazardEscapeHoldMs` (250 ms), the same "one WASD step" the
 * contracts already own; the caller passes the configured value.
 */
export const CHEST_STEP_BACK_SCAN = 0x1f;

/** The WASD step hold when a caller has no configured one (contracts §8 navigation floor). */
const STEP_HOLD_MS = 250;

/** Step one tile away from the chest (the first half of the reroll's re-engage). */
export async function stepBackFromChest(actuator: Actuator, holdMs: number = STEP_HOLD_MS): Promise<ActionResult> {
  return actuator.holdKey(CHEST_STEP_BACK_SCAN, Math.max(1, holdMs));
}

/** The step back onto the chest's tile: **W**, Windows set-1 `0x11`. */
export const CHEST_FORWARD_SCAN = 0x11;

/**
 * Re-engage a chest after a QTE cancel: **S then W**, one step each.
 *
 * Measured live 2026-10-31: the cancel leaves the party on the chest's own tile, and the 打开 prompt
 * comes back only when the party *enters* a tile beside the chest. Stepping off alone was silent —
 * two attempts, ten seconds of 3-D view each — while the step off followed by the step back on drew
 * the prompt on the next frame. WASD is camera-relative and the cancel leaves the party facing the
 * chest it just opened, so S is the step away and W the step back in.
 *
 * The two holds are the navigation key `hazardEscapeHoldMs`; the caller passes the configured value.
 */
export async function reenterChest(actuator: Actuator, holdMs: number = STEP_HOLD_MS): Promise<ActionResult> {
  const away = await stepBackFromChest(actuator, holdMs);
  if (!away.ok) return away;
  return actuator.holdKey(CHEST_FORWARD_SCAN, Math.max(1, holdMs));
}

/** The pause between two UI taps: the game draws the first button's state before the second lands. */
const TAP_SETTLE_MS = 300;

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Accept the chest the party is standing at. */
export async function acceptChestPrompt(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(CHEST_OPEN_AT);
}

/**
 * The battle's two toggles, one press each. The operator's battle order (2026-11-03) is
 * **speed → opener → auto → finish**, and each of the two is a toggle: the World presses one only
 * when the frame says it is off (`BattleToggleReader`, contracts §2), never blindly — a second press
 * would turn it back off.
 */
export async function pressBattleSpeed(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(BATTLE_SPEED_AT);
}

/** 自动, one press: the battle plays itself from here (the loop only watches it end). */
export async function pressBattleAuto(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(BATTLE_AUTO_AT);
}

/**
 * Both toggles in one command, kept for the callers that want them together (a one-off script, a
 * measurement): 倍速, a settle, 自动. The World does not use it — the battle order needs the opener
 * cast between the two presses.
 */
export async function enableBattleAuto(actuator: Actuator): Promise<ActionResult> {
  const speed = await actuator.tap(BATTLE_SPEED_AT);
  if (!speed.ok) return speed;
  await settle(TAP_SETTLE_MS);
  return actuator.tap(BATTLE_AUTO_AT);
}

/**
 * The loot overlay's collect: the centre of the **reward rectangle** — the contents card — at
 * (960, 510) on the 1920×1080 client.
 *
 * **Measured live (2026-10-31).** The operator's manual tap at this point collected the loot and
 * dismissed the card; no control is drawn under it, so the card itself is the target — the same rule
 * the banner follows (operator rule 2026-11-06: a tap anywhere on the reward claims it; the bottom
 * controls do not). The perceiver that names the screen is `LootPerceiver`
 * (`src/perception/loot.ts`); this point has nothing to do with that capture's 1280×720 size — the
 * action always speaks the client's pixels.
 *
 * One tap per call. A caller that wants to repeat a tap until the card leaves owns that repetition
 * (it is a policy fact, not an action's), and a rejected tap is returned unchanged, never retried.
 */
export const LOOT_COLLECT_AT: Point = { x: 960, y: 510 };

/** Collect the loot on screen: one tap at the measured card centre. */
export async function tapLoot(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(LOOT_COLLECT_AT);
}

/**
 * The result banner's claim: a tap **on the banner itself**, (960, 880) — the caption line the game
 * draws over the opened chest (`获得了…！！`).
 *
 * The operator's rule (2026-11-06): *in the chest claim scene a tap anywhere on the screen claims the
 * item and moves to the next item or scene; only the bottom controls — AUTO and the others — cannot
 * resolve the claim.* So this point is the reward area and never a button. The old point, (1203,1040),
 * sat in the bottom strip where the AUTO control is drawn: its 2026-11-01 'it dismissed it' was a tap
 * on empty screen at the bottom, not a control, and a claim scene that offers a button there is one
 * tap away from pressing it.
 *
 * **Measured 2026-11-06** on two live frames (`testdata/screens/2026-11-06-loot-currency/`, the
 * currency banner and the item card): the caption band's ink sits at y 871–888 at 1920×1080, i.e.
 * 880 here, and at y 581–591 in the 1280-wide escalation frame (586 → 879 at the client scale). The
 * card and the banner are one screen (`drop-item-claim`); this is the banner's place on it.
 */
export const LOOT_DISMISS_AT: Point = { x: 960, y: 880 };

/** Claim the loot result banner: one tap on the caption's own line, never a bottom control. */
export async function dismissLoot(actuator: Actuator): Promise<ActionResult> {
  return actuator.tap(LOOT_DISMISS_AT);
}
