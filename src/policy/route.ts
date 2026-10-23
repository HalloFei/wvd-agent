/**
 * The FFXI 4F route as a state machine (contracts §6, plan Task 7): one pure decision from an
 * `Observation` to the next `Intent`.
 *
 * It only knows what the contracts declare — the screen and its payload, the remaining willpower and
 * how many chests are left — never a parser's internals. The route procedure it encodes:
 *
 * - out of willpower is a stop: no member can open another chest;
 * - a battle is fought, not avoided;
 * - a chest's opener panel is opened; the QTE is the loop's business (it has the timing), so the
 *   route just waits while the bar is on screen;
 * - with the map open, walk to the nearest chest shown on it; once the chest budget is spent, leave
 *   by the exit (the cross-floor command, `移动至出口`);
 * - the map is the decision surface, so any other screen opens it while chests remain.
 *
 * Grid distance is Manhattan: the map's tiles are square and the command walks the grid.
 */
import type { Intent, Point, RouteState } from '../contracts.ts';

/** How long to wait for a screen that is still settling: loading, or a QTE the loop is timing. */
const SETTLE_MS = 100;

/**
 * The next thing to do. Pure and total: every `RouteState` yields an `Intent`; a condition the
 * route cannot act on is a `stop`, never a throw (contracts §0.6).
 */
export function nextIntent(state: RouteState): Intent {
  if (state.willpower.length > 0 && state.willpower.every((willpower) => willpower <= 0)) {
    return { kind: 'stop', reason: 'willpower-exhausted' };
  }

  const observation = state.observation;
  switch (observation.screen) {
    case 'combat':
      return { kind: 'fight' };
    case 'loading':
      return { kind: 'wait', ms: SETTLE_MS };
    case 'chest-open':
      return { kind: 'open-chest' };
    case 'chest-qte':
      // the QTE needs the loop's measured tap timing; the route never guesses it
      return { kind: 'wait', ms: SETTLE_MS };
    case 'dungeonmap': {
      if (state.chestsRemaining <= 0) return { kind: 'exit' };
      const chests = observation.map.icons
        .filter((icon) => icon.kind === 'chest')
        .map((icon) => icon.at);
      if (chests.length > 0) return { kind: 'move', target: nearest(observation.map.player, chests) };
      // the floor shows no chest although one is budgeted: the exit is the next information source
      return { kind: 'exit' };
    }
    default:
      // the 3D view, town, world map, loot or an unknown screen: the map is the decision surface
      return state.chestsRemaining > 0 ? { kind: 'open-map' } : { kind: 'exit' };
  }
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function nearest(from: Point, points: readonly Point[]): Point {
  let best = points[0]!;
  let bestDistance = manhattan(from, best);
  for (const point of points) {
    const distance = manhattan(from, point);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}
