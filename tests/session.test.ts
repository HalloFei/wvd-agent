import { describe, expect, it } from 'vitest';
import type { Observation, RouteState, ScreenId } from '../src/contracts.ts';
import { classify } from '../src/policy/session.ts';

const AT = 1_000;
const CONFIDENT = 0.9;

function state(observation: Observation, willpower: number[] = [80], chestsRemaining = 1): RouteState {
  return { observation, willpower, chestsRemaining };
}

/** A screen with no payload of its own, at any confidence. */
function screen(
  kind: 'town' | 'worldmap' | 'dungeon' | 'loot' | 'loading' | 'unknown',
  confidence = CONFIDENT,
): Observation {
  return { screen: kind, atMs: AT, confidence };
}

/** Every screen the perceptors can emit, with the payload its type owns. */
const identified: Record<Exclude<ScreenId, 'unknown'>, Observation> = {
  town: screen('town'),
  worldmap: screen('worldmap'),
  dungeon: screen('dungeon'),
  dungeonmap: {
    screen: 'dungeonmap',
    atMs: AT,
    confidence: CONFIDENT,
    map: { floorTitle: 'B1F', player: { x: 20, y: 14 }, icons: [] },
  },
  combat: { screen: 'combat', atMs: AT, confidence: CONFIDENT },
  'chest-open': {
    screen: 'chest-open',
    atMs: AT,
    confidence: CONFIDENT,
    opener: { members: [] },
  },
  'chest-qte': {
    screen: 'chest-qte',
    atMs: AT,
    confidence: CONFIDENT,
    qte: { zones: [], markerX: 0, button: { x: 0, y: 0 }, attempts: null },
  },
  loot: screen('loot'),
  loading: screen('loading'),
};

describe('the session classifier', () => {
  it('stops on a uniform or black frame: an unknown screen at confidence 0', () => {
    expect(classify(state(screen('unknown', 0)), 0)).toBe('stop');
  });

  it('escalates on an unknown screen with a non-zero confidence: the frame showed something', () => {
    expect(classify(state(screen('unknown', 0.11)), 0)).toBe('escalate');
  });

  it('escalates when the route will not act: an identified screen under the acting floor', () => {
    // the route's own floor is 0.5, below which it waits rather than clicks
    expect(classify(state(screen('dungeon', 0.3)), 0)).toBe('escalate');
  });

  it('does not mistake a named screen for a black frame', () => {
    // contracts §2: only `unknown` may sit at 0, so a named screen at 0 is a contract violation.
    // Asking a human is the safe direction: escalate is bounded by the hourly cap, a blind
    // continuation is not.
    expect(classify(state(screen('dungeon', 0)), 0)).toBe('escalate');
  });

  it('continues on a screen the route acts on', () => {
    expect(classify(state(screen('dungeon')), 0)).toBe('ok');
  });

  it('continues at the acting floor: 0.5 is enough to act', () => {
    expect(classify(state(screen('dungeon', 0.5)), 0)).toBe('ok');
  });

  it('continues on every identified screen at a confident observation', () => {
    // transient screens (loading, qte) and hand-offs (loot, worldmap, chest-open) are the loop's
    // stall counter's business, not a verdict from one observation.
    for (const [kind, observation] of Object.entries(identified)) {
      expect(classify(state(observation), 0), kind).toBe('ok');
    }
  });

  it('stops when the escalation budget is spent: the 20th escalation of 20 is the last', () => {
    expect(classify(state(screen('unknown', 0.11)), 19)).toBe('escalate');
    expect(classify(state(screen('unknown', 0.11)), 20)).toBe('stop');
  });

  it("takes the cap as the caller's argument, not from config", () => {
    expect(classify(state(screen('unknown', 0.11)), 2, 3)).toBe('escalate');
    expect(classify(state(screen('unknown', 0.11)), 2, 2)).toBe('stop');
    expect(classify(state(screen('unknown', 0.11)), 0, 0)).toBe('stop');
  });

  it('stops on a spent budget even when the screen is healthy', () => {
    // the budget is a property of the session, not of the current observation
    expect(classify(state(identified.combat), 20)).toBe('stop');
  });
});
