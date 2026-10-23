/**
 * The three key commands that move the party (plan Task 5, navigation §3d).
 *
 * This is the live-verified command chain, not the older click path:
 *
 * - from the 3D view, `G` opens the menu and a second `G` opens the dungeon map;
 * - on the map, `L` (移动至宝箱) and `F` (移动至出口) are commands, and the game does the walking.
 *
 * The game chooses the chest when `L` is pressed, so `automoveToChest` means "go to a chest", not
 * "go to the chest a policy named". Nothing here reads the screen: the route policy decides when to
 * call these, and the loop checks what happened afterwards.
 *
 * `Actuator` (contracts §4) is the only tie to the machine. Every function returns the actuator's
 * `ActionResult` unchanged: a `rejected` press (the game is not foreground) stops the chain and is
 * handed back as the answer, never retried and never thrown.
 */
import type { ActionResult, Actuator } from '../contracts.ts';

/** The scan codes the dungeon map's legend prints (navigation §3d), as Windows set-1 codes. */
export const SCAN = {
  destination: 0x22, // G — 移动至目的地; from the 3D view this same key is the menu, then the map
  mark: 0x10,        // Q — 移动至标记 (part of the legend; no command here uses it)
  exit: 0x21,        // F — 移动至出口
  chest: 0x26,       // L — 移动至宝箱
} as const;

/**
 * A press is held at least 60 ms (contracts §4): a 0 ms press is dropped at 30 fps. This is only the
 * fallback for a caller that hands no configured hold — `worlds.wvd.pressHoldMs` (§8.2) is the real
 * value, and the composition root passes it in, so a tuned press is not silently ignored.
 */
const DEFAULT_HOLD_MS = 60;

/**
 * The pause between the two `G` presses of `openMap`. The menu is drawn on a frame boundary, not
 * synchronously, so a second `G` pressed back-to-back lands while the menu is not there yet: the
 * menu closes and the map never opens (navigation §3d). At the contract's 30 fps floor a frame is
 * ~33 ms, so 100 ms is three frames — enough for the menu to be drawn and the key after it accepted,
 * and still short enough that no player would notice the pause.
 */
const MENU_SETTLE_MS = 100;

/** Resolve after `ms`. The only timing this module owns; it reads no clock and imports none. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Press one key once for `holdMs` (contracts §4's floor is the default). */
function press(actuator: Actuator, scan: number, holdMs: number): Promise<ActionResult> {
  return actuator.holdKey(scan, holdMs);
}

/**
 * Open the dungeon map from the 3D view: `G` opens the menu, `G` again opens the map.
 * A failed menu press is returned unchanged and the second press never happens.
 *
 * `holdMs` is the configured press (`worlds.wvd.pressHoldMs`); omitting it falls back to the
 * contract's 60 ms floor rather than inventing a duration here.
 */
export async function openMap(
  actuator: Actuator,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  const menu = await press(actuator, SCAN.destination, holdMs);
  if (!menu.ok) return menu;
  await settle(MENU_SETTLE_MS);
  return press(actuator, SCAN.destination, holdMs);
}

/**
 * Walk to a chest: `L` (移动至宝箱). The map closes and the game walks the party; the game chooses
 * the chest, and battles on the way resolve themselves.
 */
export async function automoveToChest(
  actuator: Actuator,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  return press(actuator, SCAN.chest, holdMs);
}

/**
 * Walk to the exit: `F` (移动至出口). One press. Unlike a chest move, this one crosses down when the
 * destination is the next-floor tile (navigation §3d: `F` on B1F walked the party into B2F).
 */
export async function automoveToExit(
  actuator: Actuator,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  return press(actuator, SCAN.exit, holdMs);
}
