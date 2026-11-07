import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';

async function frame(relative: string): Promise<Frame> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

const TOWN = [
  'testdata/frames/town-0.jpg',
  'testdata/frames/town-1.jpg',
  'testdata/frames/town-2.jpg',
  'testdata/frames/town-3.jpg',
  'testdata/frames/town-4.jpg',
  'testdata/frames/town-panel-down.jpg',
  // The live client's own capture, 2026-11-07 21:14: the panel chevron is drawn at 1:1 with art the
  // legacy mobile-art template does not carry (it scores 0.600), so this camera is the second sample.
  'testdata/screens/2026-11-07-town-live/town-1920.jpg',
];
const NOT_TOWN = [
  'testdata/screens/2026-10-24-ffxi/view.jpg',
  'testdata/screens/2026-10-24-ffxi/map.jpg',
  'testdata/screens/2026-10-24-ffxi/combat.jpg',
  'testdata/screens/2026-10-24-ffxi/prompt.jpg',
  'testdata/nav-2026-10-24-ffxi4f/third-floor.jpg',
  'testdata/worldmap/2026-10-24/14.jpg',
  'testdata/screens/2026-10-24-ffxi/dungeon-select.jpg',
];
const WORLD_MAP = [
  'testdata/worldmap/2026-10-24/07.jpg',
  'testdata/worldmap/2026-10-24/14.jpg',
  'testdata/worldmap/2026-10-24/20.jpg',
  'testdata/worldmap/2026-10-24/22.jpg',
];

describe('TownPerceiver', () => {
  it('names the town with the party panel up or down', async () => {
    for (const path of TOWN) {
      const observation = await new TownPerceiver().observe(await frame(path));
      expect(observation.screen, path).toBe('town');
      expect(observation.confidence, path).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('names the live 2026-11-07 camera, whose panel chevron the client redrew', async () => {
    const observation = await new TownPerceiver()
      .observe(await frame('testdata/screens/2026-11-07-town-live/town-1920.jpg'));
    expect(observation.screen).toBe('town');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('refuses every other committed screen at confidence 0', async () => {
    for (const path of NOT_TOWN) {
      const observation = await new TownPerceiver().observe(await frame(path));
      expect(observation.screen, path).toBe('unknown');
      expect(observation.confidence, path).toBe(0);
    }
  });
});

describe('WorldMapPerceiver', () => {
  it('names the world map by its letterboxed map field', async () => {
    for (const path of WORLD_MAP) {
      const observation = await new WorldMapPerceiver().observe(await frame(path));
      expect(observation.screen, path).toBe('worldmap');
      expect(observation.confidence, path).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('refuses the town, the dungeon and the map', async () => {
    for (const path of [...TOWN, ...NOT_TOWN.filter((item) => !WORLD_MAP.includes(item))]) {
      const observation = await new WorldMapPerceiver().observe(await frame(path));
      expect(observation.screen, path).toBe('unknown');
      expect(observation.confidence, path).toBe(0);
    }
  });
});

describe('the composite', () => {
  const composite = new CompositePerceiver([
    { perceiver: new HudPerceiver(), floor: 0.5 },
    { perceiver: new WorldMapPerceiver(), floor: 0.5 },
    { perceiver: new TownPerceiver(), floor: 0.5 },
  ]);

  it('reports the town instead of the HUD fallback', async () => {
    const observation = await composite.observe(await frame('testdata/frames/town-panel-down.jpg'));
    expect(observation.screen).toBe('town');
  });

  it('names the live town even with the battle perceiver ahead of it in the chain', async () => {
    // The World's order (src/main.ts): a battle answer that the frame's evidence rules out is dropped,
    // so the town's loss of its windows to the party panel no longer turns into a battle at 1.0.
    const world = new CompositePerceiver([
      { perceiver: new CombatPerceiver(), floor: 0.5 },
      { perceiver: new TownPerceiver(), floor: 0.5 },
    ]);
    const observation = await world.observe(
      await frame('testdata/screens/2026-11-07-town-live/town-1920.jpg'),
    );
    expect(observation.screen).toBe('town');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('still reports a black frame as unknown at confidence 0, so a session may stop', async () => {
    const image: RgbaImage = { data: new Uint8Array(1920 * 1080 * 4), width: 1920, height: 1080 };
    const observation = await composite.observe({ atMs: 0, width: 1920, height: 1080, toRgba: async () => image });
    expect(observation.screen).toBe('unknown');
    expect(observation.confidence).toBe(0);
  });
});
