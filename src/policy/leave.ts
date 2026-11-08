/**
 * The leave goal (contracts §10, goal form): out of the dungeon, to the rest town.
 *
 * The exit used to be a **script** — a cursor of steps that assumed every earlier step had run from
 * the floor the script was written for. That is the defect the operator named (2026-11-09): an
 * interrupted stage must never assume its action executed; it must **infer from the current frame and
 * the state the game is in**. On this floor the legal orders are few, and they are the frame's:
 *
 * - `town` → arrived: the cycle's rest gate takes over.
 * - `worldmap` / `dungeon-select` → travel to the leave destination.
 * - `dungeonmap` on the **farm floor** → `exit` (F, 移動至出口). The farm floor's way out is its own
 *   exit (the stair down); the harken page is **not** this floor's order — 归还 from here would leave
 *   the party somewhere no route has measured.
 * - `dungeonmap` on **another floor of the site** → `exit`. On the entry floor this is what walks the
 *   party to the harken; the floor, not a step number, is what chooses the order.
 * - `dungeonmap` on a floor the site does not know → **stop**: no measured way off it (the same rule
 *   the orientation keeps).
 * - `dungeon` → `open-map`: only the map prints the floor, so the floor is the map's to say.
 * - `harken-menu` → tap the **matched** 归还 row (a perceptual tap, never a fixed coordinate). On the
 *   farm floor the page is backed out instead — the party may not leave the floor it farms.
 * - `loading` / `unknown` → wait: a transition resolves by itself.
 * - every other screen → **yield**: a battle, a chest, a loot card, a page or the heal is the loop's
 *   to finish, and this asks again from the next frame.
 *
 * There is no cursor, no step counter and no "current step": every tick starts from the frame. That
 * is the whole contract, and it is why an interrupted leave cannot resume on a stale assumption.
 */
import type { Observation, Point } from '../contracts.ts';
import { isExpectedFloor } from '../tasks/steps.ts';

/** What the leave may do, as the frame allows it. */
export type LeaveCommand =
  /** Travel on the world map (or from the Dungeon Select list) to the leave destination. */
  | { readonly kind: 'travel'; readonly to: string }
  /** G from the walking view: the dungeon map, so the next frame can say which floor this is. */
  | { readonly kind: 'open-map' }
  /** F on the map (移動至出口): the game walks the party to this floor's exit. */
  | { readonly kind: 'exit' }
  /** A tap on the row a reader **matched** — never a fixed coordinate. */
  | { readonly kind: 'tap-row'; readonly at: Point; readonly label: string }
  /** One Esc: back out of a page this floor may not use (the harken menu on the farm floor). */
  | { readonly kind: 'back' };

export type LeaveDecision =
  | { readonly kind: 'arrived' }
  | { readonly kind: 'yield' }
  | { readonly kind: 'wait'; readonly reason: 'loading' | 'unnamed' }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'command'; readonly command: LeaveCommand };

/** The goal plus the floor book the loop keeps: where to go, what it farms, and what it may cross. */
export interface LeaveContext {
  /** The catalogue id the leave travels to once the party is out of the dungeon. */
  readonly to: string;
  /** The task's own floor: the one the farm works, and the one a harken page may never return from. */
  readonly farmFloor: string;
  /** Every floor of the site the loop can recognise, the farm floor included. */
  readonly knownFloors: readonly string[];
  /**
   * The floor the last readable map showed, or null before one was read this session. Used by the
   * harken page: a page whose floor is unknown is treated as the farm's (the conservative side).
   */
  readonly floor: string | null;
}

/** Which floor this key is, judged against the site's own list. */
function floorKind(key: string, context: LeaveContext): 'farm' | 'known' | 'unknown' {
  if (isExpectedFloor(context.farmFloor, key)) return 'farm';
  return context.knownFloors.some((floor) => isExpectedFloor(floor, key)) ? 'known' : 'unknown';
}

/** The one order this frame allows, or a reason to wait / stop / let the loop act. */
export function nextLeaveStep(observation: Observation, context: LeaveContext): LeaveDecision {
  switch (observation.screen) {
    case 'town':
      return { kind: 'arrived' };
    case 'worldmap':
    case 'dungeon-select':
      return { kind: 'command', command: { kind: 'travel', to: context.to } };
    case 'dungeonmap': {
      const kind = floorKind(observation.map.titleKey, context);
      // The farm floor and the site's other floors have the same order on this frame: F is the
      // game's own exit. What differs is *where it leads*, and the next frame says that; a party that
      // guessed it would be the blind script this module replaces.
      if (kind === 'farm' || kind === 'known') return { kind: 'command', command: { kind: 'exit' } };
      return {
        kind: 'stop',
        reason: 'the map is not a floor this site knows (read ' + observation.map.titleKey + '); no measured way off it',
      };
    }
    case 'dungeon':
      return { kind: 'command', command: { kind: 'open-map' } };
    case 'harken-menu': {
      // The harken page's legal orders depend on the floor the party stands on, not on the page.
      const onFarm = context.floor === null || floorKind(context.floor, context) === 'farm';
      if (onFarm) {
        // Operator rule 2026-11-09: on the farm floor the party never takes 归还. Back out and let
        // the farm work; the floor's own exit is the way off it, not the harken.
        return { kind: 'command', command: { kind: 'back' } };
      }
      const back = observation.rows.find((row) => row.label === '归还');
      if (back === undefined) {
        return { kind: 'stop', reason: 'the harken menu offers no 归还 row (rows: ' + describeRows(observation.rows) + ')' };
      }
      return { kind: 'command', command: { kind: 'tap-row', at: back.at, label: '归还' } };
    }
    case 'loading':
      return { kind: 'wait', reason: 'loading' };
    case 'unknown':
      return { kind: 'wait', reason: 'unnamed' };
    default:
      // combat, chest-prompt/open/qte/opening, drop-item-claim, skill-panel, character-page,
      // main-character-dead, revive-qte, inn, inn-rest, message, ui-menu: the loop owns these.
      return { kind: 'yield' };
  }
}

/** The menu's known labels, for a failure that says what the page actually offered. */
function describeRows(rows: readonly { readonly label: string | null }[]): string {
  const named = rows.map((row) => row.label).filter((label): label is string => label !== null);
  return named.length === 0 ? 'none named' : named.join(', ');
}
