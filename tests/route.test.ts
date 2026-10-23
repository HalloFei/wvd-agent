import { describe, expect, it } from 'vitest';
import type { MapIcon, Observation, Point, RouteState } from '../src/contracts.ts';
import { nextIntent, routePolicy } from '../src/policy/route.ts';

const AT = 1_000;
const CONFIDENCE = 0.9;

function routeState(observation: Observation, willpower: number[], chestsRemaining: number): RouteState {
  return { observation, willpower, chestsRemaining };
}

/** A screen with no payload, at any confidence. */
function screen(
  kind: 'town' | 'worldmap' | 'dungeon' | 'loot' | 'loading' | 'unknown',
  confidence = CONFIDENCE,
): Observation {
  return { screen: kind, atMs: AT, confidence };
}

function map(player: Point, icons: MapIcon[], confidence = CONFIDENCE): Observation {
  return {
    screen: 'dungeonmap',
    atMs: AT,
    confidence,
    map: { floorTitle: '第四区-城内2F深处-', player, icons },
  };
}

const combat: Observation = { screen: 'combat', atMs: AT, confidence: CONFIDENCE };
const chestOpen: Observation = {
  screen: 'chest-open',
  atMs: AT,
  confidence: CONFIDENCE,
  opener: { members: [] },
};
const chestQte: Observation = {
  screen: 'chest-qte',
  atMs: AT,
  confidence: CONFIDENCE,
  qte: { zones: [], markerX: 0, button: { x: 0, y: 0 }, attempts: null },
};
const chest: MapIcon = { kind: 'chest', at: { x: 19, y: 21 } };
const WAIT_SLOW = { kind: 'wait', ms: 250 };
const WAIT_SETTLE = { kind: 'wait', ms: 100 };

describe('the FFXI 4F route state machine', () => {
  it('is the contracts §9 FarmPolicy binding, and still exports nextIntent', () => {
    expect(routePolicy.next).toBe(nextIntent);
    expect(routePolicy.next(routeState(combat, [80], 3))).toEqual({ kind: 'fight' });
  });

  it('opens the map from the 3D dungeon view while chests remain', () => {
    expect(nextIntent(routeState(screen('dungeon'), [80], 1))).toEqual({ kind: 'open-map' });
  });

  it('leaves by the exit from the 3D dungeon view when the chest budget is spent', () => {
    expect(nextIntent(routeState(screen('dungeon'), [80], 0))).toEqual({ kind: 'exit' });
  });

  // the pair with the test above and the one below is the point: a screen that shows a HUD acts,
  // a frame that could not be identified waits
  it('waits on an unknown screen instead of opening the map', () => {
    expect(nextIntent(routeState(screen('unknown'), [80], 1))).toEqual(WAIT_SLOW);
  });

  it('waits on any screen below the confidence floor', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest], 0.49), [80], 1))).toEqual(WAIT_SLOW);
  });

  it('trusts a screen at the confidence floor', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest], 0.5), [80], 1)))
      .toEqual({ kind: 'move', target: { x: 19, y: 21 } });
  });

  it('moves to the chest shown on the open map', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest]), [80], 1)))
      .toEqual({ kind: 'move', target: { x: 19, y: 21 } });
  });

  it('breaks a distance tie by the lowest x, then the lowest y', () => {
    // equal distance 2: (12,10) and (10,12) -> lowest x wins
    const equalDistance = [
      { kind: 'chest', at: { x: 12, y: 10 } } as const,
      { kind: 'chest', at: { x: 10, y: 12 } } as const,
    ];
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, equalDistance), [80], 2)))
      .toEqual({ kind: 'move', target: { x: 10, y: 12 } });
    // equal distance 4 and equal x 8: (8,12) and (8,8) -> lowest y wins
    const equalX = [
      { kind: 'chest', at: { x: 8, y: 12 } } as const,
      { kind: 'chest', at: { x: 8, y: 8 } } as const,
    ];
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, equalX), [80], 2)))
      .toEqual({ kind: 'move', target: { x: 8, y: 8 } });
  });

  it('leaves by the exit when the chest budget is spent, even if icons remain', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest]), [80], 0)))
      .toEqual({ kind: 'exit' });
  });

  it('leaves by the exit when the map shows no chest although one is budgeted', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, []), [80], 1)))
      .toEqual({ kind: 'exit' });
  });

  it('fights on a combat screen', () => {
    expect(nextIntent(routeState(combat, [80], 3))).toEqual({ kind: 'fight' });
  });

  it('stops when every member has run out of willpower', () => {
    expect(nextIntent(routeState(combat, [0, 0, 0], 3)))
      .toEqual({ kind: 'stop', reason: 'willpower-exhausted' });
  });

  it('does not stop while one member can still open a chest', () => {
    expect(nextIntent(routeState(combat, [0, 42], 3))).toEqual({ kind: 'fight' });
  });

  it('treats an empty willpower list as unknown, not exhausted', () => {
    // deliberate: no members observed is not the same fact as every member at zero
    expect(nextIntent(routeState(combat, [], 3))).toEqual({ kind: 'fight' });
  });

  it('leaves town: this is a dungeon route', () => {
    expect(nextIntent(routeState(screen('town'), [80], 3))).toEqual({ kind: 'exit' });
  });

  it('waits on the loot screen, which the chest module owns', () => {
    expect(nextIntent(routeState(screen('loot'), [80], 3))).toEqual(WAIT_SLOW);
  });

  it('waits on the world map, which the loop owns', () => {
    expect(nextIntent(routeState(screen('worldmap'), [80], 3))).toEqual(WAIT_SLOW);
  });

  it('waits on the opener panel, which the chest module owns', () => {
    expect(nextIntent(routeState(chestOpen, [80], 3))).toEqual(WAIT_SLOW);
  });

  it('waits while a QTE is being timed by the loop', () => {
    expect(nextIntent(routeState(chestQte, [80], 3))).toEqual(WAIT_SETTLE);
  });

  it('waits while the screen is loading', () => {
    expect(nextIntent(routeState(screen('loading'), [80], 3))).toEqual(WAIT_SETTLE);
  });
});
