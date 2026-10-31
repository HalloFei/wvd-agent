import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { travelTo, type WorldMapEnv } from '../src/actions/worldmap.ts';
import { DungeonSelectPerceiver } from '../src/perception/dungeon-select.ts';

async function frame(relative: string): Promise<Frame> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

/** A frame the perceiver cannot name (the Dungeon Select screen) and an actuator that records taps. */
function envFor(image: Frame): WorldMapEnv & { taps: Point[] } {
  const taps: Point[] = [];
  let clock = 0;
  const actuator: Actuator = {
    tap: async (at) => { taps.push(at); return { ok: true }; },
    doubleTap: async () => ({ ok: true }),
    holdKey: async () => ({ ok: true }),
    drag: async () => ({ ok: true }),
  };
  return {
    actuator,
    taps,
    capture: async () => image,
    observe: async (): Promise<Observation> => ({ screen: 'unknown', atMs: clock, confidence: 0.2 }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
}


describe('the Dungeon Select screen', () => {
  it('names the live select list and not the town', async () => {
    const select = new DungeonSelectPerceiver();
    const onSelect = await select.observe(await frame('testdata/screens/2026-10-24-ffxi/dungeon-select.jpg'));
    expect(onSelect.screen).toBe('dungeon-select');
    expect(onSelect.confidence).toBeGreaterThanOrEqual(0.5);
    const inTown = await select.observe(await frame('testdata/frames/town-0.jpg'));
    expect(inTown.screen).toBe('unknown');
  });
});

describe('the Dungeon Select row', () => {
  it('taps the 第三区 row where its label matched, not a fixed point', async () => {
    const env = envFor(await frame('testdata/screens/2026-10-24-ffxi/dungeon-select.jpg'));
    const result = await travelTo('ffxi-zone3', env);
    expect(result.ok).toBe(true);
    expect(env.taps).toHaveLength(1);
    const tap = env.taps[0]!;
    // The label matches at (1017,521), 162×27 at scale 0.70: its centre is (1098,534).
    expect(tap.y).toBeGreaterThan(515);
    expect(tap.y).toBeLessThan(555);
    expect(tap.x).toBeGreaterThan(1020);
    expect(tap.x).toBeLessThan(1180);
  });

  it('refuses a frame without the row instead of tapping a coordinate', async () => {
    const env = envFor(await frame('testdata/frames/town-0.jpg'));
    const result = await travelTo('ffxi-zone3', env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('location-not-found');
    expect(env.taps).toHaveLength(0);
  });
});
