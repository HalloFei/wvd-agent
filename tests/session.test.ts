import { describe, expect, it } from 'vitest';
import type { Observation, RouteState, ScreenId } from '../src/contracts.ts';
import { nextIntent } from '../src/policy/route.ts';
import { classify } from '../src/policy/session.ts';

const AT = 1_000;
const CONFIDENT = 0.9;
/** The §8.5 default, passed explicitly: the classifier has no default of its own (review, Important 1). */
const CAP = 20;

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

/** The map screen at any confidence; one chest budgeted but no chest icon shown, so it exits. */
function dungeonMap(confidence = CONFIDENT): Observation {
  return {
    screen: 'dungeonmap',
    atMs: AT,
    confidence,
    map: { floorTitle: 'B1F', player: { x: 20, y: 14 }, icons: [] },
  };
}

/** Every screen the perceptors can emit, with the payload its type owns. */
const identified: Record<Exclude<ScreenId, 'unknown'>, Observation> = {
  town: screen('town'),
  worldmap: screen('worldmap'),
  dungeon: screen('dungeon'),
  dungeonmap: dungeonMap(),
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

/** The route's acting floor from both sides, plus the out-of-contract zero and a negative. */
const CONFIDENCES = [0, 0.1, 0.2, 0.3, 0.4, 0.49, 0.5, 0.9];

describe('the session classifier', () => {
  it('stops on a uniform or black frame: an unknown screen at confidence 0', () => {
    expect(classify(state(screen('unknown', 0)), 0, CAP)).toBe('stop');
  });

  it('escalates on an unknown screen with a non-zero confidence: the frame showed something', () => {
    expect(classify(state(screen('unknown', 0.11)), 0, CAP)).toBe('escalate');
  });

  it('escalates when the route will not act: an identified screen under the acting floor', () => {
    // the route's own floor is 0.5, below which it waits rather than clicks
    expect(classify(state(screen('dungeon', 0.3)), 0, CAP)).toBe('escalate');
  });

  it('stops on any screen with no confidence: a frame nobody identified never continues', () => {
    // contracts §2 lets only `unknown` sit at 0, so a named screen at 0 is a perceiver bug; the
    // answer is the same as for a black frame rather than a budget-burning escalation.
    expect(classify(state(screen('dungeon', 0)), 0, CAP)).toBe('stop');
    expect(classify(state(screen('unknown', -0.2)), 0, CAP)).toBe('stop');
    expect(classify(state({ screen: 'combat', atMs: AT, confidence: -0.2 }), 0, CAP)).toBe('stop');
  });

  it('continues on a screen the route acts on', () => {
    expect(classify(state(screen('dungeon')), 0, CAP)).toBe('ok');
  });

  it('continues at the acting floor: 0.5 is enough to act', () => {
    expect(classify(state(screen('dungeon', 0.5)), 0, CAP)).toBe('ok');
  });

  it('continues on every identified screen at a confident observation', () => {
    for (const [kind, observation] of Object.entries(identified)) {
      expect(classify(state(observation), 0, CAP), kind).toBe('ok');
    }
  });

  it('stops when the escalation budget is spent: the 20th escalation of 20 is the last', () => {
    expect(classify(state(screen('unknown', 0.11)), 19, CAP)).toBe('escalate');
    expect(classify(state(screen('unknown', 0.11)), 20, CAP)).toBe('stop');
    expect(classify(state(screen('unknown', 0.11)), 21, CAP)).toBe('stop');
  });

  it('stops at the cap however small it is', () => {
    expect(classify(state(screen('unknown', 0.11)), 0, 1)).toBe('escalate');
    expect(classify(state(screen('unknown', 0.11)), 1, 1)).toBe('stop');
    expect(classify(state(screen('unknown', 0.11)), 0, 0)).toBe('stop');
  });

  it('stops on a spent budget even when the screen is healthy', () => {
    // the budget is a property of the session, not of the current observation
    expect(classify(state(identified.combat), 20, CAP)).toBe('stop');
  });

  it('agrees with the route about when confidence is too low to act', () => {
    // The two modules each own a copy of the 0.5 acting floor (contracts are closed, and a module
    // may not import another's implementation), so only behaviour keeps them from drifting. For a
    // screen the route can act on, it must wait exactly where the classifier refuses to say ok.
    const acting: Array<[string, (confidence: number) => Observation]> = [
      ['town', (confidence) => screen('town', confidence)],
      ['dungeon', (confidence) => screen('dungeon', confidence)],
      ['combat', (confidence) => ({ screen: 'combat', atMs: AT, confidence })],
      ['dungeonmap', (confidence) => dungeonMap(confidence)],
    ];
    for (const [kind, at] of acting) {
      for (const confidence of CONFIDENCES) {
        const observation = at(confidence);
        const label = `${kind}@${confidence}`;
        if (nextIntent(state(observation)).kind === 'wait') {
          expect(classify(state(observation), 0, CAP), label).not.toBe('ok');
        } else {
          expect(classify(state(observation), 0, CAP), label).toBe('ok');
        }
      }
    }
    // `unknown` can never act, so its wait is a refusal at every confidence, including a negative.
    for (const confidence of [...CONFIDENCES, -0.2]) {
      expect(classify(state(screen('unknown', confidence)), 0, CAP), `unknown@${confidence}`).not.toBe('ok');
    }
  });

  it('continues where the route waits by design rather than from doubt', () => {
    // loading, a QTE, loot, the world map and the opener panel are hand-offs: the route waits for
    // another module or for the screen to settle at full confidence. Escalating those would spend
    // the hourly budget on loading screens, so the loop's stall counter, not this verdict, owns
    // their persistence (controller ruling).
    for (const kind of ['loading', 'chest-qte', 'loot', 'worldmap', 'chest-open'] as const) {
      expect(nextIntent(state(identified[kind])).kind, kind).toBe('wait');
      expect(classify(state(identified[kind]), 0, CAP), kind).toBe('ok');
    }
  });
});
