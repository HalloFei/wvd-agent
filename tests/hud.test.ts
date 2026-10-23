import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { HudPerceiver } from '../src/perception/hud.ts';

/**
 * The fixtures are the JPEGs the engine hands the World (`ffmpeg -q:v 6`; R26), decoded here the way
 * a `FrameSource` decodes them: `jpeg-js` into RGBA, then a Frame whose `toRgba()` returns that
 * image. The same three frames the map parser was measured on: two maps and one 3-D view.
 */
const FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

/** The HUD-only frame: party walking, minimap top-right, no map open. */
const HUD_FRAME = 'minimap-and-hud.jpg';
/** The open map. */
const MAP_FRAME = 'map.jpg';
/** The open map under the automove banner — also the map perceiver's business. */
const MAP_BANNER_FRAME = 'popup.jpg';

async function jpegImage(name: string): Promise<RgbaImage> {
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function jpegFrame(name: string, atMs: number): Promise<Frame> {
  const image = await jpegImage(name);
  return { atMs, width: image.width, height: image.height, toRgba: async () => image };
}

function frameOf(image: RgbaImage, atMs: number): Frame {
  return { atMs, width: image.width, height: image.height, toRgba: async () => image };
}

/** A copy of an image whose pixels a test may overwrite without touching the cached original. */
function copyOf(image: RgbaImage): RgbaImage {
  return { data: Uint8Array.from(image.data), width: image.width, height: image.height };
}

interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Fill a rect with one grey value, so that a HUD element is gone from the frame. */
function paint(image: RgbaImage, rect: Rect, value: number): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
}

/** Copy one rect of `source` into `target` at the same frame coordinates. */
function blit(target: RgbaImage, source: RgbaImage, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    const start = (y * target.width + rect.x) * 4;
    const end = start + rect.w * 4;
    target.data.set(source.data.subarray(start, end), start);
  }
}

/** A frame of one flat luma: what a faded capture, a black frame or a loading screen looks like. */
function uniformImage(width: number, height: number, luma: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = luma;
    data[offset + 1] = luma;
    data[offset + 2] = luma;
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

/** Lift every pixel towards white, as a combat flash's wash does; channels clamp at 255. */
function washOut(image: RgbaImage, amount: number): void {
  for (let offset = 0; offset < image.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      image.data[offset + channel] = Math.min(255, image.data[offset + channel] + amount);
    }
  }
}

const UNKNOWN_AT = (atMs: number) => ({ screen: 'unknown', atMs, confidence: 0 });

/**
 * Research §3: the eight measured readout runs (`X : d d Y : d d`), x spans inclusive, ink rows
 * 900–911. The extents vary by ±1 px between frames; the colon is placed one column right of the
 * table's 1106 so that it stays a separate run (the JPEG fixture measures `Y` 1094–1105, `:`
 * 1107–1110), which is what the eight-run structure means.
 */
const READOUT_RUNS: ReadonlyArray<readonly [number, number]> = [
  [1017, 1028],
  [1030, 1034],
  [1040, 1047],
  [1049, 1057],
  [1094, 1105],
  [1107, 1110],
  [1117, 1123],
  [1126, 1133],
];

describe('HudPerceiver', () => {
  it('names the 3-D exploration view from the HUD alone', async () => {
    const observation = await new HudPerceiver().observe(await jpegFrame(HUD_FRAME, 7_000));

    expect(observation.screen).toBe('dungeon');
    expect(observation.atMs).toBe(7_000);
    // the route acts on an identified screen only above its own 0.5 floor (contracts §6, §2)
    expect(observation.confidence).toBeGreaterThan(0.5);
    expect(observation.confidence).toBeLessThanOrEqual(1);
    // `dungeon` carries no payload (contracts §3)
    expect(observation).not.toHaveProperty('map');
  });

  it('leaves the open dungeon map to the map perceiver', async () => {
    expect(await new HudPerceiver().observe(await jpegFrame(MAP_FRAME, 11_111))).toEqual(
      UNKNOWN_AT(11_111),
    );
  });

  it('leaves the map under the automove banner to the map perceiver', async () => {
    expect(await new HudPerceiver().observe(await jpegFrame(MAP_BANNER_FRAME, 12_345))).toEqual(
      UNKNOWN_AT(12_345),
    );
  });

  it('reports unknown with confidence 0 for a uniform frame', async () => {
    const frame = frameOf(uniformImage(1920, 1080, 96), 3_333);

    expect(await new HudPerceiver().observe(frame)).toEqual(UNKNOWN_AT(3_333));
  });

  it('refuses a frame of another size, even with the HUD box filled in', async () => {
    // The fixed rects are measured at 1920x1080 (contracts §0.5: other sizes are unsupported, not
    // re-scaled). Bright ink sits exactly where the minimap is at 1920x1080; a 2560-wide capture
    // must still be refused rather than read through the wrong scale.
    const image = uniformImage(2560, 1440, 16);
    paint(image, { x: 1761, y: 18, w: 140, h: 150 }, 240);

    expect(await new HudPerceiver().observe(frameOf(image, 5_555))).toEqual(UNKNOWN_AT(5_555));
  });

  it('refuses a 3-D frame whose minimap is not drawn', async () => {
    // The same frame with the HUD anchor gone: a scene is not a screen. `unknown`, not `dungeon`.
    const image = copyOf(await jpegImage(HUD_FRAME));
    paint(image, { x: 1761, y: 18, w: 140, h: 150 }, 24);

    expect(await new HudPerceiver().observe(frameOf(image, 2_222))).toEqual(UNKNOWN_AT(2_222));
  });

  it('refuses a frame where the HUD and the map walls are both on screen', async () => {
    // A map caught before its readout renders, with the minimap of the view it opened from still
    // up: the readout is gone, but the wall lattice is not. That is still the map's frame, so this
    // perceiver must not claim it (the task's rule: a HUD-only frame that also shows a map is the
    // map perceiver's business).
    const image = copyOf(await jpegImage(MAP_FRAME));
    paint(image, { x: 1005, y: 894, w: 146, h: 24 }, 0);
    blit(image, await jpegImage(HUD_FRAME), { x: 1761, y: 18, w: 140, h: 150 });

    expect(await new HudPerceiver().observe(frameOf(image, 4_444))).toEqual(UNKNOWN_AT(4_444));
  });

  it('refuses a frame that carries only the readout structure', async () => {
    // G1 is the map's decisive structural gate (research §3: 0 of 198 non-map frames produced eight
    // runs — a structure test, not a brightness one). A frame with the eight runs is the map screen
    // even before its walls are drawn, so the HUD must not turn it into a 3-D view.
    const image = uniformImage(1920, 1080, 32);
    for (const [from, to] of READOUT_RUNS) {
      paint(image, { x: from, y: 900, w: to - from + 1, h: 12 }, 255);
    }
    blit(image, await jpegImage(HUD_FRAME), { x: 1761, y: 18, w: 140, h: 150 });

    expect(await new HudPerceiver().observe(frameOf(image, 6_666))).toEqual(UNKNOWN_AT(6_666));
  });

  it('refuses an over-bright frame, such as a combat flash', async () => {
    // Research §1: a measured 3-D frame carries ≤ 8 000 px of white panel ink and the combat flash
    // (精密攻击) reaches mean luma 242.5, far past the map's own ceiling. Washed towards white, the
    // HUD fixture is still the same screen — but it is no longer a view this perceiver can name.
    const image = copyOf(await jpegImage(HUD_FRAME));
    washOut(image, 150);

    expect(await new HudPerceiver().observe(frameOf(image, 8_888))).toEqual(UNKNOWN_AT(8_888));
  });

  it('returns unknown rather than throwing when the frame cannot be decoded', async () => {
    const frame: Frame = {
      atMs: 9_999,
      width: 1920,
      height: 1080,
      toRgba: async () => {
        throw new Error('decode failed');
      },
    };

    expect(await new HudPerceiver().observe(frame)).toEqual(UNKNOWN_AT(9_999));
  });
});
