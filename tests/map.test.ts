import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, MapState, RgbaImage } from '../src/contracts.ts';
import { MapPerceiver, readMap, tileOnScreen } from '../src/perception/map.ts';
import { floorKeyDistance } from '../src/tasks/steps.ts';

/**
 * R26: the engine hands the World JPEG, not PNG, so the fixtures under test are the JPEGs the
 * engine would produce (`ffmpeg -q:v 6`, measured as the q75-equivalent; see the report). Decoding
 * here mirrors the source: `jpeg-js` into RGBA, then a Frame whose `toRgba()` returns that image.
 */
const FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

async function jpegFrame(name: string, atMs = 4_000): Promise<Frame> {
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return {
    atMs,
    width: decoded.width,
    height: decoded.height,
    toRgba: async () => image,
  };
}

const cell = (point: { x: number; y: number }) => `${point.x},${point.y}`;

describe('readMap', () => {
  it('reads the floor token, the party cell and the icons from map.jpg', async () => {
    const map = await readMap(await jpegFrame('map.jpg'));

    expect(map).not.toBeNull();
    // R27: the Latin token only — the localized half is a one-sample atlas entry and is not read.
    expect(map!.floorTitle).toBe('B1F');
    // The readout says X: 20 Y: 14 (research §3, §13); the old 19/21 is popup.png's reading.
    expect(map!.player).toEqual({ x: 20, y: 14 });

    const chests = map!.icons
      .filter((icon) => icon.kind === 'chest')
      .map((icon) => cell(icon.at))
      .sort();
    expect(chests).toEqual(['18,9', '23,13', '8,8']);

    // The hazard is the cell directly north of the party (research §6).
    expect(map!.icons.filter((icon) => icon.kind === 'hazard').map((icon) => cell(icon.at))).toEqual([
      '20,15',
    ]);

    // One sample, unproven (research §6, §9): the template is exact here because it came from this
    // floor, so this asserts the pipeline, not that the glyph generalizes.
    expect(map!.icons.some((icon) => icon.kind === 'stairs')).toBe(true);

    // `haken` is not identifiable in any fixture and must never be emitted (research §6).
    expect(map!.icons.some((icon) => icon.kind === 'haken')).toBe(false);

    // contracts §3 `origin`: the chevron's own screen point, the anchor every tile click is placed
    // from. The canvas scrolls, so this is the only absolute position a walk may use. It is a blob
    // centroid, hence fractional: a half pixel is nothing against a 36 px cell.
    expect(map!.origin.x).toBeCloseTo(1_212.7, 0);
    expect(map!.origin.y).toBeCloseTo(569.3, 0);
  });

  it('reads the map behind the automove banner', async () => {
    const map = await readMap(await jpegFrame('popup.jpg'));

    expect(map).not.toBeNull();
    expect(map!.floorTitle).toBe('B1F');
    expect(map!.player).toEqual({ x: 19, y: 21 });
    expect(map!.icons.filter((icon) => icon.kind === 'chest')).toHaveLength(2);
    expect(map!.icons.some((icon) => icon.kind === 'hazard')).toBe(true);
  });

  it('refuses the HUD-only frame instead of misreading it as a map', async () => {
    expect(await readMap(await jpegFrame('minimap-and-hud.jpg'))).toBeNull();
  });

  it('refuses a readout glyph that the template atlas cannot match', async () => {
    const frame = await jpegFrame('map.jpg');
    const image = await frame.toRgba();
    const data = Uint8Array.from(image.data);

    // Overwrite the X tens digit (x 1041–1046, y 900–911) with a pattern no digit template covers.
    for (let y = 900; y < 912; y += 1) {
      for (let x = 1041; x < 1047; x += 1) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        const offset = (y * image.width + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    const mutated: Frame = {
      ...frame,
      toRgba: async () => ({ data, width: image.width, height: image.height }),
    };

    expect(await readMap(mutated)).toBeNull();
  });

  it('refuses a frame of another size rather than mis-scaling the fixed rects', async () => {
    const image: RgbaImage = { data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 };
    const frame: Frame = { atMs: 1, width: 64, height: 64, toRgba: async () => image };

    expect(await readMap(frame)).toBeNull();
  });
});

describe('MapPerceiver', () => {
  it('reports a dungeonmap observation with its confidence and the frame time', async () => {
    const frame = await jpegFrame('map.jpg', 12_345);
    const observation = await new MapPerceiver().observe(frame);

    expect(observation.screen).toBe('dungeonmap');
    if (observation.screen !== 'dungeonmap') return;
    expect(observation.atMs).toBe(12_345);
    expect(observation.confidence).toBeGreaterThanOrEqual(0.7);
    expect(observation.confidence).toBeLessThanOrEqual(1);
    expect(observation.map.floorTitle).toBe('B1F');
  });

  it('reports unknown with confidence 0 for the HUD-only frame', async () => {
    const frame = await jpegFrame('minimap-and-hud.jpg', 7_000);
    const observation = await new MapPerceiver().observe(frame);

    expect(observation).toEqual({ screen: 'unknown', atMs: 7_000, confidence: 0 });
  });
});

/**
 * R27a: the floor's title fingerprint. The FFXI collab floors print a Chinese title where the
 * Latin slots expect `B1F`; the fingerprint is what makes those floors nameable at all. Measured
 * 2026-10-24 on the live game (1920×1080, `第四区-城内2F深处-`).
 */
describe('readMap — the floor title fingerprint', () => {
  const FFXI = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);

  async function ffxiFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, FFXI));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads a map whose title is not Latin, with the measured key', async () => {
    const map = await readMap(await ffxiFrame('map.jpg'));

    expect(map).not.toBeNull();
    expect(map!.floorTitle).toBe('');
    expect(map!.titleKey).toBe('000000007f3ffe007f7efe00220ba600');
    // The readout is still the gate that proves this is a map: X: 11 Y: 23 on the captured frame.
    expect(map!.player).toEqual({ x: 11, y: 23 });
  });

  it('keeps the Latin token and gives it a key too', async () => {
    const map = await readMap(await jpegFrame('map.jpg'));

    expect(map!.floorTitle).toBe('B1F');
    expect(map!.titleKey).toBe('0000c00003e6c00003efe00003874000');
  });

  it('gives two floors different keys', async () => {
    const latin = await readMap(await jpegFrame('map.jpg'));
    const ffxi = await readMap(await ffxiFrame('map.jpg'));

    expect(latin!.titleKey).not.toBe(ffxi!.titleKey);
  });

  it('still refuses the HUD frame at the title ink gate', async () => {
    expect(await readMap(await jpegFrame('minimap-and-hud.jpg'))).toBeNull();
  });
});

/**
 * The FFXI collab floors are translucent over the 3D view, so the map panel carries the scene's
 * glow; the readout band also picks up the panel's scrollbar. Both are handled (R28, R29) and this
 * is the frame class that first exposed them.
 */
describe('readMap — the FFXI third floor', () => {
  const FFXI = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);

  async function ffxiFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, FFXI));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads the floor, the party cell and three chests', async () => {
    const map = await readMap(await ffxiFrame('third-floor.jpg'));

    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 13, y: 23 });
    const chests = map!.icons.filter((icon) => icon.kind === 'chest').map((icon) => cell(icon.at)).sort();
    expect(chests).toEqual(['5,16', '6,17', '9,13']);
    // The floor the route farms: its chevron is what a tile walk is aimed from.
    expect(map!.origin.x).toBeCloseTo(959.5, 0);
    expect(map!.origin.y).toBeCloseTo(264.7, 0);
  });

  it('keeps the floor key under the harken glow, within the gate tolerance', async () => {
    const clean = await readMap(await ffxiFrame('third-floor.jpg'));
    const glow = await readMap(await ffxiFrame('third-floor-glow.jpg'));

    expect(glow).not.toBeNull();
    expect(glow!.player).toEqual({ x: 7, y: 24 });
    // R27b: the glow shifts a couple of bits; the task's gate compares with a small tolerance.
    expect(floorKeyDistance(clean!.titleKey, glow!.titleKey)).toBeLessThanOrEqual(8);
  });
});
/**
 * The grid→screen transform a tile walk is aimed with (contracts §3 `origin`): exactly the inverse
 * of `findIcons`' own `toGrid`, so the cell the parser names and the cell a tap lands on are one
 * cell.
 */
describe('tileOnScreen', () => {
  /** The shape of one `map.jpg` readout: the party on (20,14), its chevron at (1213,569). */
  const map: MapState = {
    floorTitle: 'B1F',
    titleKey: '0000',
    player: { x: 20, y: 14 },
    origin: { x: 1_213, y: 569 },
    icons: [],
  };

  it("puts the party's own cell back on the chevron", () => {
    expect(tileOnScreen(map, map.player)).toEqual({ x: 1_213, y: 569 });
  });

  it('steps one 36 px cell per grid step, with y inverted', () => {
    // Grid y counts upward and the screen's downward: north of the party is a smaller screen y.
    expect(tileOnScreen(map, { x: 21, y: 14 })).toEqual({ x: 1_249, y: 569 });
    expect(tileOnScreen(map, { x: 20, y: 15 })).toEqual({ x: 1_213, y: 533 });
    expect(tileOnScreen(map, { x: 18, y: 9 })).toEqual({ x: 1_141, y: 749 });
  });

  it('rounds to a pixel, because the chevron is a centroid and a tap has no fractions', () => {
    expect(tileOnScreen({ ...map, origin: { x: 1_212.7, y: 569.3 } }, map.player)).toEqual({ x: 1_213, y: 569 });
  });

  it("aims the FFXI third floor's nearest chest inside the map panel", () => {
    // player 13,23; chevron (959.5,264.7); the chests are (6,17), (5,16), (9,13) and the nearest by
    // the route's Manhattan proxy is (6,17). The map panel's icon window is x 460-1710, y 140-920,
    // so an aim that leaves it means the transform, not the route, is wrong.
    const ffxi: MapState = {
      floorTitle: '',
      titleKey: '000000007f3ffe007f7efe00220ba600',
      player: { x: 13, y: 23 },
      origin: { x: 959.476, y: 264.726 },
      icons: [],
    };
    const aim = tileOnScreen(ffxi, { x: 6, y: 17 });
    expect(aim).toEqual({ x: 707, y: 481 });
    expect(aim.x).toBeGreaterThan(460);
    expect(aim.x).toBeLessThan(1_710);
    expect(aim.y).toBeGreaterThan(140);
    expect(aim.y).toBeLessThan(920);
  });
});
