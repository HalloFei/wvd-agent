import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, Observation, RouteState, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver, UNNAMED_CONFIDENCE } from '../src/perception/hud.ts';
import { classify } from '../src/policy/session.ts';

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

/** The HUD the perceiver looks for: the minimap box, and the 2x2 command grid beneath it. */
const MINIMAP_BOX: Rect = { x: 1761, y: 18, w: 140, h: 150 };
const HUD_AREA: Rect = { x: 1761, y: 18, w: 140, h: 237 };

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

/** Copy one rect of `source` into `target` at the same frame coordinates (widths may differ). */
function blit(target: RgbaImage, source: RgbaImage, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    const from = (y * source.width + rect.x) * 4;
    const to = (y * target.width + rect.x) * 4;
    target.data.set(source.data.subarray(from, from + rect.w * 4), to);
  }
}

/** Scale a rect's channels down, as a dimmer rendering of the same UI element. */
function dim(image: RgbaImage, rect: Rect, factor: number): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        image.data[offset + channel] = Math.round(image.data[offset + channel] * factor);
      }
    }
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

/**
 * A dark, non-uniform field standing in for a 3-D scene (luma 24–79, deterministic). It tests no
 * gate; it exists so a synthetic frame is not itself a uniform frame, which would be refused first.
 */
function sceneImage(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = 24 + ((x * 7 + y * 13) % 56);
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
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

/** Nothing was drawn at all — the only refusal that may stop a session (contracts §2). */
const NOTHING_AT = (atMs: number): Observation => ({ screen: 'unknown', atMs, confidence: 0 });
/** Something is drawn and this perceiver cannot name it: positive, and below any act floor. */
const UNNAMED_AT = (atMs: number): Observation => ({ screen: 'unknown', atMs, confidence: UNNAMED_CONFIDENCE });

/** The route's act floor (contracts §6), the floor the composition root gives this recogniser. */
const ACTING_FLOOR = 0.5;

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
  it('names the 3-D exploration view from the HUD structure', async () => {
    const observation = await new HudPerceiver().observe(await jpegFrame(HUD_FRAME, 7_000));

    expect(observation.screen).toBe('dungeon');
    expect(observation.atMs).toBe(7_000);
    // the route acts on an identified screen only above its own 0.5 floor (contracts §6, §2)
    expect(observation.confidence).toBeGreaterThan(0.5);
    expect(observation.confidence).toBeLessThanOrEqual(1);
    // `dungeon` carries no payload (contracts §3)
    expect(observation).not.toHaveProperty('map');
  });

  it('leaves the open dungeon map to the map perceiver, but says a frame was drawn', async () => {
    // Not this perceiver's answer, and also not an empty screen: contract §2's two refusals differ
    // in confidence, and the map perceiver is the one that will name it.
    expect(await new HudPerceiver().observe(await jpegFrame(MAP_FRAME, 11_111))).toEqual(
      UNNAMED_AT(11_111),
    );
  });

  it('leaves the map under the automove banner to the map perceiver', async () => {
    expect(await new HudPerceiver().observe(await jpegFrame(MAP_BANNER_FRAME, 12_345))).toEqual(
      UNNAMED_AT(12_345),
    );
  });

  it('reports unknown with confidence 0 for a uniform frame the HUD ink threshold would admit', async () => {
    // Luma 160 is above every HUD ink threshold (L > 150), so without the uniform gate the whole
    // frame would read as a bright minimap. A flat field is `unknown` at 0 (contracts §2).
    expect(await new HudPerceiver().observe(frameOf(uniformImage(1920, 1080, 160), 3_333))).toEqual(
      NOTHING_AT(3_333),
    );
  });

  it('reports unknown with confidence 0 for a black frame', async () => {
    expect(await new HudPerceiver().observe(frameOf(uniformImage(1920, 1080, 0), 2_000))).toEqual(
      NOTHING_AT(2_000),
    );
  });

  it('reports a busy frame it cannot name at a positive confidence', async () => {
    // A 3-D scene with no HUD at all (a battle, a loading screen, the opener panel): the frame is
    // not flat, so this is not "nothing was perceived". It must be positive — a stop is the answer
    // for a black frame, not for a screen nobody has a recogniser for (contracts §2) — and below
    // the act floor, so it can never be acted on.
    const observation = await new HudPerceiver().observe(frameOf(sceneImage(1920, 1080), 2_750));

    expect(observation).toEqual(UNNAMED_AT(2_750));
    // asserted as numbers, not through the constant: setting the constant to 0 must fail here
    expect(observation.confidence).toBeGreaterThan(0);
    expect(observation.confidence).toBeLessThan(ACTING_FLOOR);
  });

  it('refuses a flat frame carrying one bright box where the minimap would be', async () => {
    // The uniform gate's mean/std cannot see a patch this size as flat (std ≈ 8 > 6), so this case
    // must die on the HUD *structure*: a solid bright box is brightness without line work.
    const image = uniformImage(1920, 1080, 160);
    paint(image, MINIMAP_BOX, 255);

    expect(await new HudPerceiver().observe(frameOf(image, 2_500))).toEqual(UNNAMED_AT(2_500));
  });

  it('refuses a frame whose decoded pixels are not the size the frame declares', async () => {
    // contracts §0.5: dimensions come from the frame. A source that hands back a smaller image
    // would have the fixed rects read off the end of it, so it is refused, not read — and refused
    // as a drawn frame (the pixels are not flat), so the loop asks instead of stopping.
    const image = sceneImage(960, 540);
    const frame: Frame = { atMs: 4_242, width: 1920, height: 1080, toRgba: async () => image };

    expect(await new HudPerceiver().observe(frame)).toEqual(UNNAMED_AT(4_242));
  });

  it('refuses a frame of another size, even with a real HUD drawn on it', async () => {
    // The fixed rects are measured at 1920x1080 (contracts §0.5: other sizes are unsupported, not
    // re-scaled). This frame carries the real HUD at the 1920x1080 coordinates, so every other gate
    // would pass; the declared size alone must refuse it rather than read through the wrong scale.
    const image = sceneImage(2560, 1440);
    blit(image, await jpegImage(HUD_FRAME), HUD_AREA);

    expect(await new HudPerceiver().observe(frameOf(image, 5_555))).toEqual(UNNAMED_AT(5_555));
  });

  it('refuses a 3-D frame whose minimap is not drawn', async () => {
    // The same frame with the HUD anchor gone: a scene is not a screen. `unknown`, not `dungeon`.
    const image = copyOf(await jpegImage(HUD_FRAME));
    paint(image, MINIMAP_BOX, 24);

    expect(await new HudPerceiver().observe(frameOf(image, 2_222))).toEqual(UNNAMED_AT(2_222));
  });

  it('refuses a frame where the HUD and the map walls are both on screen', async () => {
    // A map caught before its readout renders, with the minimap of the view it opened from still
    // up: the readout is gone, but the wall lattice is not. That is still the map's frame, so this
    // perceiver must not claim it (the task's rule: a HUD-only frame that also shows a map is the
    // map perceiver's business).
    const image = copyOf(await jpegImage(MAP_FRAME));
    paint(image, { x: 1005, y: 894, w: 146, h: 24 }, 0);
    blit(image, await jpegImage(HUD_FRAME), HUD_AREA);

    expect(await new HudPerceiver().observe(frameOf(image, 4_444))).toEqual(UNNAMED_AT(4_444));
  });

  it('refuses a frame that carries only the readout structure', async () => {
    // G1 is the map's decisive structural gate (research §3: 0 of 198 non-map frames produced eight
    // runs — a structure test, not a brightness one). A frame with the eight runs is the map screen
    // even before its walls are drawn, so the HUD must not turn it into a 3-D view.
    const image = sceneImage(1920, 1080);
    for (const [from, to] of READOUT_RUNS) {
      paint(image, { x: from, y: 900, w: to - from + 1, h: 12 }, 255);
    }
    blit(image, await jpegImage(HUD_FRAME), HUD_AREA);

    expect(await new HudPerceiver().observe(frameOf(image, 6_666))).toEqual(UNNAMED_AT(6_666));
  });

  it('refuses an over-bright frame, such as a combat flash', async () => {
    // Research §1: a measured 3-D frame carries ≤ 8 000 px of white panel ink and the combat flash
    // (精密攻击) reaches mean luma 242.5, far past the map's own ceiling. Washed towards white, the
    // HUD fixture is still the same screen — but it is no longer a view this perceiver can name.
    const image = copyOf(await jpegImage(HUD_FRAME));
    washOut(image, 150);

    expect(await new HudPerceiver().observe(frameOf(image, 8_888))).toEqual(UNNAMED_AT(8_888));
  });

  it('refuses a bright block filling the minimap box', async () => {
    // The HUD anchor is a *structure*: a dark opaque panel carrying sparse line work. A solid block
    // in that box is brightness without structure, and must not become `dungeon`.
    const image = sceneImage(1920, 1080);
    paint(image, MINIMAP_BOX, 240);

    expect(await new HudPerceiver().observe(frameOf(image, 3_100))).toEqual(UNNAMED_AT(3_100));
  });

  it('refuses a mostly-bright block over a real minimap', async () => {
    // Bright ink is a bounded minority of the panel (12.5 % measured): a frame whose minimap area is
    // mostly bright ink is some other screen drawn over it, not the walking view.
    const image = copyOf(await jpegImage(HUD_FRAME));
    paint(image, { x: 1825, y: 35, w: 65, h: 105 }, 240);

    expect(await new HudPerceiver().observe(frameOf(image, 3_200))).toEqual(UNNAMED_AT(3_200));
  });

  it('refuses a small bright patch where a HUD would have a command grid', async () => {
    // A bright patch in the minimap box on a dark scene passes the dark-panel and ink-density tests;
    // the 2x2 command grid beneath the minimap is what a HUD also has and a stray bright shape does
    // not. One-sample structure, measured from the fixture.
    const image = sceneImage(1920, 1080);
    paint(image, { x: 1790, y: 40, w: 60, h: 60 }, 240);

    expect(await new HudPerceiver().observe(frameOf(image, 3_400))).toEqual(UNNAMED_AT(3_400));
  });

  it('interpolates confidence with how densely the panel is drawn', async () => {
    // A dimmer minimap is weaker evidence than the measured one: confidence must move with the ink
    // rather than sitting at 1.0. The dimmed box still carries the structure (dark surface, sparse
    // ink, command grid), so the answer stays `dungeon` — above the route's 0.5 floor.
    const image = copyOf(await jpegImage(HUD_FRAME));
    dim(image, MINIMAP_BOX, 0.77);
    const observation = await new HudPerceiver().observe(frameOf(image, 7_777));

    expect(observation.screen).toBe('dungeon');
    expect(observation.confidence).toBeGreaterThan(0.5);
    expect(observation.confidence).toBeGreaterThan(0.8);
    expect(observation.confidence).toBeLessThan(1);
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

    expect(await new HudPerceiver().observe(frame)).toEqual(NOTHING_AT(9_999));
  });
});

/**
 * The rule the whole finding rests on (Task 10 review, Critical 1): a dead frame and an unrecognised
 * live frame must not reach the same verdict. The chain is the real one — the HUD recogniser behind
 * the composite the composition root builds — and the classifier is the real one.
 */
describe('a black frame and a busy frame it cannot name reach different verdicts', () => {
  const perceiver = new CompositePerceiver([{ perceiver: new HudPerceiver(), floor: ACTING_FLOOR }]);
  const state = (observation: Observation): RouteState => ({ observation, willpower: [], chestsRemaining: 1 });

  it('stops on a black frame: nothing was perceived', async () => {
    const black = await perceiver.observe(frameOf(uniformImage(1920, 1080, 0), 1_000));

    expect(black).toEqual(NOTHING_AT(1_000));
    expect(classify(state(black), 0, 20)).toBe('stop');
  });

  it('escalates on a busy frame nobody can name: something is on screen', async () => {
    const busy = await perceiver.observe(frameOf(sceneImage(1920, 1080), 1_000));

    expect(busy.screen).toBe('unknown');
    expect(busy.confidence).toBeGreaterThan(0);
    // never an act floor: an unnamed frame is asked about, never clicked
    expect(busy.confidence).toBeLessThan(ACTING_FLOOR);
    expect(classify(state(busy), 0, 20)).toBe('escalate');
  });

  it('keeps the strongest positive refusal when recognisers disagree about how much they saw', async () => {
    // A recogniser can only say "I saw something" below its own floor. The composite must not throw
    // that evidence away and answer 0 — that would be a stop on a frame two recognisers saw.
    const sawSomething = { observe: async (): Promise<Observation> => UNNAMED_AT(5) };
    const sawNothing = { observe: async (): Promise<Observation> => NOTHING_AT(5) };
    const composite = new CompositePerceiver([
      { perceiver: sawNothing, floor: ACTING_FLOOR },
      { perceiver: sawSomething, floor: ACTING_FLOOR },
    ]);

    const observation = await composite.observe(frameOf(uniformImage(1, 1, 0), 5));

    expect(observation.confidence).toBeGreaterThan(0);
    expect(observation.confidence).toBe(UNNAMED_CONFIDENCE);
    expect(classify(state(observation), 0, 20)).toBe('escalate');
  });
});
