import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/contracts.ts';
import { CHEST_PROBE_MS, nextChestProbe } from '../src/policy/chest-probe.ts';

/** The FFXI farm floor's key, from the site descriptor. */
const FARM = '000000007f3ffe007ffeff00220bb600';
/** The site's other floor: not the farm, and the probe never asks there. */
const OTHER = '0c0280000deff0000d7ffc0008c37000';

const map = (chests: { x: number; y: number }[], titleKey = FARM): Observation => ({
  screen: 'dungeonmap',
  atMs: 1,
  confidence: 1,
  map: {
    floorTitle: '',
    titleKey,
    player: { x: 1, y: 1 },
    origin: { x: 0, y: 0 },
    icons: chests.map((at) => ({ kind: 'chest' as const, at })),
  },
});

const idle = { probe: null, done: null, farmFloor: FARM, chestsShown: 0 } as const;

describe('the last reachable-chest check', () => {
  it('starts on the farm floor s map only when the map draws no chest', () => {
    expect(nextChestProbe(map([]), idle, 1_000)).toEqual({ kind: 'start' });
    // The map draws a chest: the farm has one to claim, and the game need not be asked.
    expect(nextChestProbe(map([{ x: 4, y: 4 }]), idle, 1_000)).toEqual({ kind: 'skip' });
    // The farm's own read still sees a chest somewhere: the probe waits for the farm to finish.
    expect(nextChestProbe(map([]), { ...idle, chestsShown: 1 }, 1_000)).toEqual({ kind: 'skip' });
  });

  it('never asks on another floor, twice on the same floor, or without a farm floor', () => {
    expect(nextChestProbe(map([], OTHER), idle, 1_000)).toEqual({ kind: 'skip' });
    expect(nextChestProbe(map([]), { ...idle, farmFloor: null }, 1_000)).toEqual({ kind: 'skip' });
    expect(nextChestProbe(map([]), { ...idle, done: FARM }, 1_000)).toEqual({ kind: 'skip' });
  });

  it('is a yes on any chest screen, and the walk starts when the map closes', () => {
    const probe = { floor: FARM, atMs: 0 };
    for (const screen of ['chest-prompt', 'chest-open', 'chest-qte', 'combat'] as const) {
      expect(nextChestProbe({ screen, atMs: 1, confidence: 1 } as Observation, { ...idle, probe }, 1_000))
        .toEqual({ kind: 'found' });
    }
    for (const screen of ['dungeon', 'loading', 'unknown'] as const) {
      expect(nextChestProbe({ screen, atMs: 1, confidence: 1 } as Observation, { ...idle, probe }, 1_000))
        .toEqual({ kind: 'walking' });
    }
  });

  it('waits 5 s on a map that does not move, then says the game has no chest', () => {
    const probe = { floor: FARM, atMs: 1_000 };
    expect(nextChestProbe(map([]), { ...idle, probe }, 2_000)).toEqual({ kind: 'wait' });
    expect(nextChestProbe(map([]), { ...idle, probe }, 1_000 + CHEST_PROBE_MS - 1)).toEqual({ kind: 'wait' });
    expect(nextChestProbe(map([]), { ...idle, probe }, 1_000 + CHEST_PROBE_MS)).toEqual({ kind: 'none' });
  });
});
