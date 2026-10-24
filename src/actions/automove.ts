/**
 * The commands that move the party (plan Task 5, navigation §3d).
 *
 * The chain is the one the live game answers:
 *
 * - from the 3D view, `G` opens the menu and a second `G` opens the dungeon map;
 * - on the map, `F` (移动至出口) is a command and the game does the walking;
 * - on the map, a **tile** is walked to in pointer mode: `R` (切换指针模式), a click on the walkable
 *   cell, and a click on the 自动移动 element that click raises.
 *
 * `L` (移动至宝箱) is **not** used here. It works on the map floors measured on 2026-10-24 night, but
 * it is inert on both FFXI collab floors even when the map shows three chests (measured 2026-10-24,
 * `docs/status.md`), and the FFXI 4F route is the one this World runs. Pointer mode is the path that
 * answers on every floor, so a walk is aimed at a tile rather than left to the game's own choice.
 *
 * The popup tap is the one blind gesture here: the 自动移动 element is not detected, it is assumed
 * where it was measured — 79–84 px above the clicked tile. A tile that is not walkable raises no
 * popup, so the second tap lands on the map and pointer mode ignores it: the walk simply does not
 * start, which the loop's in-flight rules already treat as "changed nothing". That is the deliberate
 * trade for not putting a second recogniser on the critical path.
 *
 * `Actuator` (contracts §4) is the only tie to the machine. Every function returns the actuator's
 * `ActionResult` unchanged: a `rejected` press (the game is not foreground) stops the chain and is
 * handed back as the answer, never retried and never thrown.
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';

/** The scan codes the dungeon map's legend prints (navigation §3d), as Windows set-1 codes. */
export const SCAN = {
  destination: 0x22, // G — 移动至目的地; from the 3D view this same key is the menu, then the map
  mark: 0x10,        // Q — 移动至标记 (part of the legend; no command here uses it)
  exit: 0x21,        // F — 移动至出口
  chest: 0x26,       // L — 移动至宝箱 (the legend's code; a task script may press it)
  pointer: 0x13,     // R — 切换指针模式
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

/**
 * The pause after `R` before the tile is clicked, and the pause after that click before the popup is.
 * Both are the same three frames as the menu's: a mode toggle and a click's hit test are drawn on a
 * frame boundary like the menu is. **Neither is measured** — a frame trace of one pointer-mode walk
 * would replace them.
 */
const POINTER_SETTLE_MS = 100;
const POPUP_SETTLE_MS = 100;

/**
 * How far above the clicked tile the 自动移动 element is drawn, in device pixels: 79–84 measured on
 * 2026-10-24. The mid-point keeps the tap inside the element for every measured instance.
 */
const POPUP_RISE_PX = 81;

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
 * Walk to one tile of the open dungeon map: `R` (切换指针模式), the tile, then the 自动移动 element
 * the game raises above it. The map closes and the party walks; the game does the pathing, fights what
 * it meets and never leaves the floor.
 *
 * `at` is the tile's **screen** point — the World converts the map's grid target once, through
 * `tileOnScreen` (contracts §3). A tile click in the default mode is ignored by the game, so the
 * pointer toggle is not optional and a rejected one ends the chain before anything is clicked.
 */
export async function automoveToTile(
  actuator: Actuator,
  at: Point,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  const pointer = await press(actuator, SCAN.pointer, holdMs);
  if (!pointer.ok) return pointer;
  await settle(POINTER_SETTLE_MS);

  const tile = await actuator.tap(at);
  if (!tile.ok) return tile;
  await settle(POPUP_SETTLE_MS);

  return actuator.tap({ x: at.x, y: at.y - POPUP_RISE_PX });
}

/**
 * Walk to the exit: `F` (移动至出口). One press. Unlike a tile walk, this one crosses down when the
 * destination is the next-floor tile (navigation §3d: `F` on B1F walked the party into B2F).
 */
export async function automoveToExit(
  actuator: Actuator,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  return press(actuator, SCAN.exit, holdMs);
}
