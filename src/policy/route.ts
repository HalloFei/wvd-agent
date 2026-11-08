/**
 * The FFXI 4F route as a state machine (contracts §6, plan Task 7): one pure decision from an
 * `Observation` to the next `Intent`.
 *
 * It only knows what the contracts declare — the screen and its payload, the remaining willpower and
 * how many chests are left — never a parser's internals. The procedure it encodes:
 *
 * - out of willpower is a stop: no member can open another chest;
 * - a battle is fought, not avoided;
 * - in the 3D dungeon view, open the map while a chest remains, else leave;
 * - the map is the one movement surface: with it open, walk to the nearest chest shown on it; once
 *   the chest budget is spent, leave by the exit (the cross-floor command, `移动至出口`);
 * - every other screen is a wait or a hand-off, never a click. The policy only acts on screens it
 *   has identified: a blind click can silently move the party to another floor (navigation §3c).
 */
import type { FarmPolicy, Intent, Point, RouteState } from '../contracts.ts';

/**
 * Below this the screen is not identified well enough to act on. 0.5, not 0: a parser that is half
 * sure of a screen must not become a click, and only the `unknown` sentinel is allowed to sit at 0
 * (contracts §2: `unknown` is a real answer, not a fallback to be smoothed over).
 */
const CONFIDENCE_FLOOR = 0.5;

/** A wait that hands the decision back to the loop; the session classifier counts repeats. */
const HANDOFF_MS = 250;

/** A screen that is still settling: loading, or a QTE the loop is timing with its own clock. */
const SETTLE_MS = 100;

/**
 * The next thing to do. Pure and total: every `RouteState` yields an `Intent`; a condition the
 * route cannot act on is a `wait` or a `stop`, never a throw (contracts §0.6).
 */
export function nextIntent(state: RouteState): Intent {
  // The hard stop is <= 0, the only threshold RouteState supports. The chest spec bars any member
  // below 60 willpower from opening, and this state carries no usable-opener signal — so between 0
  // and 60 the chest module refuses the opener while the route cannot see why. That gap is not
  // closed by widening a contract here: the loop must bound the retries and hand the stall to the
  // session classifier (Task 10's obligation, recorded in the Task 7 report).
  if (state.willpower.length > 0 && state.willpower.every((willpower) => willpower <= 0)) {
    return { kind: 'stop', reason: 'willpower-exhausted' };
  }

  const observation = state.observation;
  // A screen we did not identify is a wait, never a click.
  if (observation.screen === 'unknown' || observation.confidence < CONFIDENCE_FLOOR) {
    return { kind: 'wait', ms: HANDOFF_MS };
  }

  switch (observation.screen) {
    case 'combat':
      return { kind: 'fight' };
    case 'dungeon':
      // the 3D view: the map is the decision surface, and only while there is something to farm
      return state.chestsRemaining > 0 ? { kind: 'open-map' } : { kind: 'exit' };
    case 'dungeonmap': {
      if (state.chestsRemaining <= 0) return { kind: 'exit' };
      // A chest the farm already tried and could not walk to is not a target: the tap raised no
      // 自动移動 element and the party never moved, so the game has no path there (operator rule
      // 2026-11-02). Skipping it is what turns one unreachable chest from a wedge into a detour.
      const unreachable = new Set(state.unreachable.map((cell) => `${cell.x},${cell.y}`));
      const chests = observation.map.icons
        .filter((icon) => icon.kind === 'chest')
        .map((icon) => icon.at)
        .filter((at) => !unreachable.has(`${at.x},${at.y}`));
      if (chests.length > 0) return { kind: 'move', target: nearest(observation.map.player, chests) };
      // No reachable chest left — the floor shows none, or every one it shows is unreachable: the
      // exit is the next stage, exactly as it is when the chest budget is spent.
      return { kind: 'exit' };
    }
    case 'town':
      // a dungeon route: nothing in town to farm
      return { kind: 'exit' };
    case 'drop-item-claim':
      // The item-claim overlay is the chest module's moment: tap its measured centre and let the
      // next screen move the route on. A card that stays is the stall clock's business.
      return { kind: 'loot' };
    case 'dungeon-select':
    case 'worldmap':
      // the loop owns the world map; the task/travel owns the Dungeon Select list
      return { kind: 'wait', ms: HANDOFF_MS };
    case 'chest-prompt':
      // The party is standing at a chest and the game is asking. Accepting is the chest step's
      // first half; the 由谁打开? panel is its second.
      return { kind: 'open-chest' };
    case 'main-character-dead':
      // Named, and nothing more (operator, 2026-11-05): *just name it*. There is no recovery module
      // here — the game's own revive changes the screen, and the loop waits for it. A session that
      // cannot come back is the stall clock's business, not a click's.
      return { kind: 'wait', ms: HANDOFF_MS };
    case 'message':
      // The game's one-off message box is the World's (contracts §2 message): one tap advances it.
      return { kind: 'wait', ms: HANDOFF_MS };
    case 'inn':
      // The inn dialog is the rest plug-in's (operator, 2026-11-06): the World chooses the room and
      // presses its row before the route is asked, so this case is a wait, never a second press.
      return { kind: 'wait', ms: HANDOFF_MS };
    case 'revive-qte':
      // A party member is down (operator, 2026-11-05): the revive QTE names the moment, and the
      // World owns the decision — stop the session (`stopOnDeath`) or ask Coo once. Nothing here
      // presses into the ring; playing it is t-mvy6dvsw's open work.
      return { kind: 'wait', ms: HANDOFF_MS };
    case 'chest-open':
      // The chest module owns the opener panel, and the panel is readable now (Task 12): the World
      // reads the members, chooses one and clicks that card. Not a blind click — the choice comes from
      // `chooseOpener`, and with no qualifying member the World escalates instead of clicking.
      return { kind: 'open-chest' };
    case 'chest-qte':
    case 'chest-opening':
    // The skill panel is the battle sequence's to press (its 確定), not the route's: the route sends
    // nothing and lets the battle branch act on the same tick.
    case 'skill-panel':
    case 'loading':
      // The opening is the chest module's moment (the lid and the hands, no bar yet): the loop sends
      // nothing and re-perceives — the bar or the loot is what comes next.
      return { kind: 'wait', ms: SETTLE_MS };
    default:
      // every ScreenId above has a rule; a newly added screen lands here as a wait, never a click
      return { kind: 'wait', ms: HANDOFF_MS };
  }
}

/** The contracts §9 binding: Task 10 consumes this, not a free function. */
export const routePolicy: FarmPolicy = { next: nextIntent };

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Nearest by Manhattan distance — a proxy for ordering only: the map contract carries no walls or
 * reachability, so this is not "the command can walk there". Ties go to the lowest x, then the
 * lowest y, so the same map always chooses the same chest.
 */
function nearest(from: Point, points: readonly Point[]): Point {
  let best = points[0]!;
  let bestDistance = manhattan(from, best);
  for (const point of points) {
    const distance = manhattan(from, point);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    } else if (distance === bestDistance && (point.x < best.x || (point.x === best.x && point.y < best.y))) {
      best = point;
    }
  }
  return best;
}
