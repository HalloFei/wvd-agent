import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/contracts.ts';
import { CHEST_PROBE_MS, nextChestProbe } from '../src/policy/chest-probe.ts';
import { floorKeyDistance } from '../src/tasks/steps.ts';

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

  it('remembers the floor, not the string it was read as', () => {
    // The map reader's title key drifts on the same floor — measured 9 bits of 128 on this very one
    // (src/tasks/steps.ts:44-54), against the loop's 16-bit tolerance — so the re-read of a floor the
    // probe already answered for is a different string. It must still read as asked: a second E press
    // walks the party out of the farm the leave did not ask for, 5 s each time.
    const reRead = '600004007f3ffe007ffefe0002032200';
    expect(floorKeyDistance(FARM, reRead)).toBe(9);
    expect(nextChestProbe(map([], reRead), { ...idle, done: FARM }, 1_000)).toEqual({ kind: 'skip' });
  });

  it('starts on the farm floor after answering for a different floor', () => {
    // The site's other colliery floor (ffxi-fourth-2f): **32 bits** of 128 from the farm — the pair
    // src/perception/sites/ffxi-gcn.ts:18-19 records — beyond the loop's 16-bit tolerance, so a "done"
    // there says nothing about this floor.
    expect(floorKeyDistance(FARM, OTHER)).toBe(32);
    expect(nextChestProbe(map([]), { ...idle, done: OTHER }, 1_000)).toEqual({ kind: 'start' });
  });

  it('treats a malformed remembered key as no floor at all, and asks', () => {
    // floorKeyDistance is Infinity off the 32-hex shape (src/tasks/steps.ts:56-57), so a damaged key
    // matches nothing. Re-asking is the safe reading: a key that matched everything would silence the
    // probe on that floor for good, and the chests it exists to catch would be walked past.
    for (const done of ['', 'ff', '600004007f3ffe007ffefe000203220', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
      expect(nextChestProbe(map([]), { ...idle, done }, 1_000)).toEqual({ kind: 'start' });
    }
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
