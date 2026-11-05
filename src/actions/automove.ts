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
 * The 自动移动 element the tile click raises is **detected** (`perception/automove.ts`, measured
 * 2026-11-02) and tapped where the game drew it; the measured 79–84 px rise is only the fallback for a
 * caller with no frame source. A tile the game cannot walk to raises no element at all — the walk is
 * refused in so many words and the World skips that chest, instead of tapping the map blind.
 *
 * **How long the element may take.** A tile click is answered by the game's own animation, not by the
 * click: the element is drawn on a later frame, and on a map that has just opened the whole panel is
 * still settling. The operator's rule (2026-11-03) is to click first and then *wait several frames*
 * before deciding nothing was raised — the 2026-11-03 live run had two chests refused with the old
 * 450 ms window, both clicks on a map that had opened a second earlier.
 *
 * `Actuator` (contracts §4) is the only tie to the machine. Every function returns the actuator's
 * `ActionResult` unchanged: a `rejected` press (the game is not foreground) stops the chain and is
 * handed back as the answer, never retried and never thrown.
 */
import type { ActionResult, Actuator, Frame, Point } from '../contracts.ts';
import { findAutoMoveElement } from '../perception/automove.ts';

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
 * How far above the clicked tile the 自动移动 element was drawn, in device pixels: 79-84 measured on
 * 2026-10-24 on mid-panel tiles. It is only the fallback for a caller that cannot look now: the
 * command finds the element itself (perception/automove.ts, measured 2026-11-02).
 */
const POPUP_RISE_PX = 81;

/**
 * How the walk finds its target: **located at the moment of the tap**, never handed in as a pixel by
 * whoever decided to walk.
 *
 * Live 2026-11-06 02:05 (`t-mw3veimb-ppbm9u`): the World converted the route's cell with
 * `tileOnScreen` on the frame the decision came from, and by the time the tap landed the map's canvas
 * had moved — the same party cell was read 112 px (3.1 cells) apart in two reads — so two reachable
 * chests were tapped three cells off, raised no element, and went on the unreachable list. The cell is
 * pose-free; the pixel is not, so the pixel is read now, from a frame captured now.
 */
export interface AutoMoveAim {
  /**
   * The map marker's screen point, read from a frame captured now. `null` is "the map could not be
   * read" — which is not the same answer as "the cell has no path", and must never become one.
   */
  readonly locate: () => Promise<Point | null>;
  /**
   * A frame source for the 自動移動 element. Without one the walk taps the measured rise blind: it has
   * no way to look, and that is all it has.
   */
  readonly capture?: () => Promise<Frame>;
  /**
   * How long the pill may take to appear. Measured: present 120 ms after the tap on a settled map;
   * a map that has just opened is slower, so the default waits the operator's five frames many times
   * over (see `ELEMENT_WAIT_MS`).
   */
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/**
 * How long to look for the element, and how often. The operator's rule (2026-11-03): click the chest
 * icon, then wait five or so frames for the 自动移动 element before calling the cell unreachable. At
 * the contract's 30 fps a frame is ~33 ms and the loop's own tick is 100 ms, so this is twelve polls
 * over 1.2 s — generous enough for a map that is still settling, short enough that a genuinely
 * unreachable cell costs one second, not a stall.
 */
const ELEMENT_WAIT_MS = 1_200;
const ELEMENT_POLL_MS = 100;

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
 * Walk to one tile of the open dungeon map: `R` (切换指针模式), the marker for `cell` located on a
 * frame captured **now**, then the 自动移动 element the game raises above it. The map closes and the
 * party walks; the game does the pathing, fights what it meets and never leaves the floor.
 *
 * `cell` is the route's own grid cell — the only thing the decision carries. Where that cell is on the
 * screen is the map's answer, not the decision's, so `aim.locate` is asked after the mode toggle and
 * re-asked on the retry. A tile click in the default mode is ignored by the game, so the pointer
 * toggle is not optional and a rejected one ends the chain before anything is clicked.
 */
export async function automoveToTile(
  actuator: Actuator,
  cell: Point,
  holdMs: number = DEFAULT_HOLD_MS,
  aim?: AutoMoveAim,
): Promise<ActionResult> {
  if (aim === undefined) {
    // Without a map reader there is no point to tap, and a walk nobody aimed must not be read as a
    // cell the game refuses (2026-11-06). The wiring always hands one in.
    return unaimed(cell, 'no map reader');
  }
  const pointer = await press(actuator, SCAN.pointer, holdMs);
  if (!pointer.ok) return pointer;
  await settle(POINTER_SETTLE_MS);

  let at = await aim.locate();
  if (at === null) return unaimed(cell, 'the map could not be read');
  const tile = await actuator.tap(at);
  if (!tile.ok) return tile;
  if (aim.capture === undefined) {
    // A caller that cannot look keeps the measured rise: blind, but it is all it has.
    await settle(POPUP_SETTLE_MS);
    return actuator.tap({ x: at.x, y: at.y - POPUP_RISE_PX });
  }
  // The element's own position, not a fixed rise: a cell near the panel's top edge has no room
  // above it, and a cell the game cannot walk to raises no element at all (live, 2026-11-02). Both
  // answer the same way — the walk is refused, and the World skips that chest.
  let seen = await waitForElement(aim, at);
  if (seen.element === null) {
    // The pointer mode is a **toggle**, and the map remembers it: our R may have turned it *off* on a
    // map that was already in pointer mode, and the tap then selects nothing (live 2026-11-03 22:04: the
    // walk to the 楼梯-门 raised no element, and the same tap had raised one an hour earlier). One
    // retry in the other mode — **re-located**, never a re-tap of a point the map may have moved under.
    const again = await press(actuator, SCAN.pointer, holdMs);
    if (!again.ok) return again;
    await settle(POINTER_SETTLE_MS);
    at = await aim.locate();
    if (at === null) return unaimed(cell, 'the map could not be read again');
    const tapAgain = await actuator.tap(at);
    if (!tapAgain.ok) return tapAgain;
    seen = await waitForElement(aim, at);
  }
  if (seen.element === null) {
    // Nothing was ever looked at: the walk was blind, and blindness is not "no path" (2026-11-06).
    if (seen.frames === 0) {
      return { ok: false, reason: 'unavailable', detail: 'no frame arrived to look for the 自动移動 element' };
    }
    return { ok: false, reason: 'timeout', detail: 'the tile raised no 自动移動 element' };
  }
  return actuator.tap(seen.element);
}

/** The typed answer for a walk nobody could aim: never a claim about the cell's path. */
function unaimed(cell: Point, why: string): ActionResult {
  return { ok: false, reason: 'unavailable', detail: `${why}; the walk to ${cell.x},${cell.y} was not aimed` };
}

/**
 * The element the tap raised, how many frames were actually looked at, and whether one was drawn
 * before the deadline. `frames === 0` means the look never happened.
 */
async function waitForElement(
  aim: AutoMoveAim,
  near: Point,
): Promise<{ element: Point | null; frames: number }> {
  const capture = aim.capture;
  if (capture === undefined) return { element: null, frames: 0 };
  const deadline = Date.now() + Math.max(1, aim.waitMs ?? ELEMENT_WAIT_MS);
  const pollMs = Math.max(1, aim.pollMs ?? ELEMENT_POLL_MS);
  let frames = 0;
  for (;;) {
    try {
      const frame = await capture();
      frames += 1;
      const element = findAutoMoveElement(await frame.toRgba(), near);
      if (element !== null) return { element: element.at, frames };
    } catch {
      // A frame nobody could capture is not "no element": keep looking until the deadline.
    }
    if (Date.now() >= deadline) return { element: null, frames };
    await settle(pollMs);
  }
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
