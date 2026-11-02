/**
 * The orientation policy (contracts §10, the goal form): where to send the party from whatever
 * screen it is on, until it stands on the farm floor.
 *
 * A scripted entry assumes the screen it starts on — `expect town` — which is exactly why a farm
 * could not be resumed: a stop or a crash that left the party inside the dungeon refused the next
 * session at step 0. A goal task instead says *where* the farm is, and this module answers one
 * question per tick: what is the next command, if any.
 *
 * The table is small because the screens are:
 *
 * - `dungeon` — open the map. It is the only surface that prints the floor, and the floor decides
 *   whether the party is already home.
 * - `dungeonmap` — the farm floor is home; the climb floor has one measured detour up; any other
 *   floor is a stop, because this task has no measured way off it and a blind tile tap is how a
 *   party changes floor by accident (navigation §3c).
 * - `dungeon-select` — pick the zone row; `town` / `worldmap` — travel to the site.
 * - `loading` / `unknown` — wait; the session classifier owns the stall and escalates it.
 * - everything else (a chest, a bar, the loot card, a battle) **yields to the farm route**: the
 *   orientation must never abandon a chest or a fight to make progress, and those screens are the
 *   ones the route already knows how to finish.
 *
 * Pure and total: one observation in, one decision out; no clock and no memory. The World owns the
 * retry budgets, because a budget is a count across ticks and this module has none.
 */
import type { Observation, Point, TaskOrient } from '../contracts.ts';
import { tileOnScreen } from '../perception/map.ts';
import { isExpectedFloor } from '../tasks/steps.ts';

/** The one command the orientation sends, if any. */
export type OrientCommand =
  /** Travel on the world map to a catalogued node (the site, or one of its zone rows). */
  | { readonly kind: 'travel'; readonly to: string }
  /** G twice from the 3-D view: the dungeon map. */
  | { readonly kind: 'open-map' }
  /** F on the map: 移動至出口. */
  | { readonly kind: 'exit' }
  /** Run the task's own climb script: the measured stair-up from the climb floor. */
  | { readonly kind: 'climb' }
  /**
   * Tap the map's **楼梯-门** icon (`MapIcon.kind === 'stair-door'`) at this screen point: the stair
   * entrance to the next floor. The operator's rule (2026-11-03): the farm's area is beside the stair
   * entrance, while the harken teleports far from it — so a climb walks to this glyph, never to the
   * harken, and never to a measured tile.
   */
  | { readonly kind: 'stairs'; readonly at: Point };

export type OrientDecision =
  /** The party stands on the farm floor: hand the loop to the farm route. */
  | { readonly kind: 'arrived' }
  | { readonly kind: 'wait'; readonly reason: 'loading' | 'unnamed' }
  /** A screen the farm route owns: let the route act on it. */
  | { readonly kind: 'yield' }
  | { readonly kind: 'command'; readonly command: OrientCommand }
  | { readonly kind: 'stop'; readonly reason: string };

/** The next step toward the goal, from the frame the loop has already observed. */
export function nextOrientStep(observation: Observation, orient: TaskOrient): OrientDecision {
  switch (observation.screen) {
    case 'dungeonmap': {
      const floor = observation.map.titleKey;
      if (isExpectedFloor(orient.floor, floor)) return { kind: 'arrived' };
      // The operator's rule (2026-11-03): the farm's area is beside the **stair entrance** — the
      // door-with-arrow icon (楼梯-门) — while the harken teleports somewhere far from the farm. So the
      // way up is the icon: tap it and the game walks the party to the stairs from wherever it stands.
      // The task's own climb script stays as the fallback for a floor without that icon.
      const stairDoor = observation.map.icons.find((icon) => icon.kind === 'stair-door');
      if (stairDoor !== undefined) {
        return { kind: 'command', command: { kind: 'stairs', at: tileOnScreen(observation.map, stairDoor.at) } };
      }
      const climb = orient.goal.climb;
      if (climb !== undefined && isExpectedFloor(climb.from, floor)) {
        return { kind: 'command', command: { kind: 'climb' } };
      }
      return {
        kind: 'stop',
        reason: `the map is neither the farm floor (${orient.floor}) nor the climb floor (${climb?.from ?? 'none'}): read ${floor}`,
      };
    }
    case 'dungeon':
      return { kind: 'command', command: { kind: 'open-map' } };
    case 'dungeon-select':
      // One site may open a zone list (the FFXI colliery) or the dungeon itself; the goal names which.
      return { kind: 'command', command: { kind: 'travel', to: orient.goal.zone ?? orient.goal.site } };
    case 'town':
    case 'worldmap':
      return { kind: 'command', command: { kind: 'travel', to: orient.goal.site } };
    case 'loading':
      return { kind: 'wait', reason: 'loading' };
    case 'unknown':
      // A transition resolves by itself; one that does not is the stall clock's business, and the
      // session classifier escalates it. The orientation never guesses over an unnamed frame.
      return { kind: 'wait', reason: 'unnamed' };
    default:
      // chest-prompt, chest-open, chest-qte, chest-opening, loot, combat: the farm route finishes
      // what the party is already doing. Adding a screen to `ScreenId` lands here — a yield, never
      // a blind command.
      return { kind: 'yield' };
  }
}
