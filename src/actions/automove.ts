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
}

/**
 * The second look's extra wait. Measured: the pill is present 120 ms after the tap on a settled map;
 * a map that has just opened draws it later. Two looks are enough because the answer is a frame, not
 * a race, and the operator's rule (2026-11-03) is about not calling a cell unreachable too early.
 */
const POPUP_LATE_MS = 250;

/** Resolve after `ms`. The only timing this module owns; it reads no clock and imports none. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Press one key once for `holdMs` (contracts §4's floor is the default). */
function press(actuator: Actuator, scan: number, holdMs: number): Promise<ActionResult> {
  return actuator.holdKey(scan, holdMs);
}

/**
 * Open the dungeon map from the 3D view: **one** `G`.
 *
 * The module used to press `G` twice, on the reading that `G` opens a menu and `G` again the map
 * (2026-10-24, the JPEG-capture era). Measured live 2026-11-08: from the walking view a single `G`
 * opens the map in 8 of 8 trials, every frame readable at 0.85 — and the second press is not free.
 * On the map, `G` is 移動至目的地: it orders a walk to the cursor, and the frame then carries the
 * destination marker instead of the party's chevron. Live 12:12 the exit script's pair did exactly
 * that and the map stopped reading (`no-chevron`) for the whole 8 s the step waited, which stopped
 * the run at exit step 2. An action that is already answered must not press again.
 *
 * `holdMs` is the configured press (`worlds.wvd.pressHoldMs`); omitting it falls back to the
 * contract's 60 ms floor rather than inventing a duration here.
 */
export async function openMap(
  actuator: Actuator,
  holdMs: number = DEFAULT_HOLD_MS,
): Promise<ActionResult> {
  return press(actuator, SCAN.destination, holdMs);
}

/**
 * Walk to one tile of the open dungeon map: `R` (切换指针模式), the marker for `cell` located on a
 * frame captured **now**, then the 自动移动 element the game raises above it. The map closes and the
 * party walks; the game does the pathing, fights what it meets and never leaves the floor.
 *
 * `cell` is the route's own grid cell — the only thing the decision carries. Where that cell is on the
 * screen is the map's answer, not the decision's, so `aim.locate` is asked after the mode toggle.
 * The selection then has to be *verified*: the frame after the tap says whether the game raised the
 * pill, opened a prompt or did nothing — and a frame nobody could read is never "no path".
 * A tile click in the default mode is ignored by the game, so the pointer toggle is not optional;
 * it is also a **toggle**, so the caller says whether it is already on (`pointerOn`) and R is not
 * pressed blindly (2026-11-07).
 */
export async function automoveToTile(
  actuator: Actuator,
  cell: Point,
  holdMs: number = DEFAULT_HOLD_MS,
  aim?: AutoMoveAim,
  pointerOn: boolean | null = null,
): Promise<ActionResult> {
  if (aim === undefined) {
    // Without a map reader there is no point to tap, and a walk nobody aimed must not be read as a
    // cell the game refuses (2026-11-06). The wiring always hands one in.
    return unaimed(cell, 'no map reader');
  }
  // Pointer mode is a **toggle**, not a switch: pressing R when it is already on turns it off, and the
  // tile click then selects nothing (live 2026-11-03 22:04). The caller tracks the state — the World
  // resets it whenever the map closes — so R is pressed only when it is known off or unknown.
  if (pointerOn !== true) {
    const pointer = await press(actuator, SCAN.pointer, holdMs);
    if (!pointer.ok) return pointer;
    await settle(POINTER_SETTLE_MS);
  }

  const at = await aim.locate();
  if (at === null) return unaimed(cell, 'the map could not be read');
  const tile = await actuator.tap(at);
  if (!tile.ok) return tile;
  if (aim.capture === undefined) {
    // A caller that cannot look keeps the measured rise: blind, but it is all it has.
    await settle(POPUP_SETTLE_MS);
    return actuator.tap({ x: at.x, y: at.y - POPUP_RISE_PX });
  }
  // The selection's own frames answer, in order: the pill, a prompt the tap opened, or nothing. There
  // is **no second R** — the old retry toggled pointer mode off behind a tap that had worked, and a
  // failed capture during its 1.2 s poll was indistinguishable from "the cell has no path" (live
  // 2026-11-07 00:10: the chest at 11,4 was skipped while the JPEG worker was dying).
  const first = await lookForElement(aim, at);
  if (first.kind === 'unreadable') return unreadableAfterTap();
  if (first.element !== null) return actuator.tap(first.element);
  await settle(POPUP_LATE_MS);
  const late = await lookForElement(aim, at);
  if (late.kind === 'unreadable') return unreadableAfterTap();
  if (late.element !== null) return actuator.tap(late.element);
  return { ok: false, reason: 'timeout', detail: 'the selection raised no 自動移動 element' };
}

/** One look after the tap: the element, or a frame nobody could read — which is not "no element". */
async function lookForElement(
  aim: AutoMoveAim,
  near: Point,
): Promise<{ readonly kind: 'looked'; readonly element: Point | null } | { readonly kind: 'unreadable' }> {
  const capture = aim.capture;
  if (capture === undefined) return { kind: 'looked', element: null };
  try {
    const frame = await capture();
    const element = findAutoMoveElement(await frame.toRgba(), near);
    return { kind: 'looked', element: element === null ? null : element.at };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** A tap whose answer could not be read is **unaimed**, never a cell without a path (2026-11-07). */
function unreadableAfterTap(): ActionResult {
  return { ok: false, reason: 'unavailable', detail: 'the frame after the tap could not be read' };
}

/** The typed answer for a walk nobody could aim: never a claim about the cell's path. */
function unaimed(cell: Point, why: string): ActionResult {
  return { ok: false, reason: 'unavailable', detail: `${why}; the walk to ${cell.x},${cell.y} was not aimed` };
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
