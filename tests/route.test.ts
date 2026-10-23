import { describe, expect, it } from 'vitest';
import type { Intent, MapIcon, Observation, Point, RouteState } from '../src/contracts.ts';
import { nextIntent } from '../src/policy/route.ts';

const AT = 1_000;
const CONFIDENCE = 0.9;

function routeState(observation: Observation, willpower: number[], chestsRemaining: number): RouteState {
  return { observation, willpower, chestsRemaining };
}

function view(): Observation {
  // the 3D dungeon view: not the map, not a chest screen, not combat
  return { screen: 'unknown', atMs: AT, confidence: CONFIDENCE };
}

function map(player: Point, icons: MapIcon[]): Observation {
  return {
    screen: 'dungeonmap',
    atMs: AT,
    confidence: CONFIDENCE,
    map: { floorTitle: '第四区-城内2F深处-', player, icons },
  };
}

const combat: Observation = { screen: 'combat', atMs: AT, confidence: CONFIDENCE };
const chest: MapIcon = { kind: 'chest', at: { x: 19, y: 21 } };

describe('the FFXI 4F route state machine', () => {
  it('opens the map when a chest remains and the map is not open', () => {
    expect(nextIntent(routeState(view(), [80], 1))).toEqual({ kind: 'open-map' });
  });

  it('moves to the chest shown on the open map', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest]), [80], 1)))
      .toEqual({ kind: 'move', target: { x: 19, y: 21 } });
  });

  it('picks the nearest of several chests', () => {
    const far = { kind: 'chest', at: { x: 20, y: 20 } } as const;
    const near = { kind: 'chest', at: { x: 12, y: 10 } } as const;
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [far, near]), [80], 2)))
      .toEqual({ kind: 'move', target: { x: 12, y: 10 } });
  });

  it('leaves by the exit when no chests remain', () => {
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, [chest]), [80], 0)))
      .toEqual({ kind: 'exit' });
    expect(nextIntent(routeState(map({ x: 10, y: 10 }, []), [80], 0)))
      .toEqual({ kind: 'exit' });
  });

  it('fights on a combat screen', () => {
    expect(nextIntent(routeState(combat, [80], 3))).toEqual({ kind: 'fight' });
  });

  it('stops when every member has run out of willpower', () => {
    const intent: Intent = nextIntent(routeState(combat, [0, 0, 0], 3));
    expect(intent.kind).toBe('stop');
    if (intent.kind === 'stop') expect(intent.reason).not.toBe('');
  });

  it('does not stop while one member can still open a chest', () => {
    expect(nextIntent(routeState(combat, [0, 42], 3))).toEqual({ kind: 'fight' });
  });
});
