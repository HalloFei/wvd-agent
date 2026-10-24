import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { MapPerceiver, readMap } from '../src/perception/map.ts';
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
