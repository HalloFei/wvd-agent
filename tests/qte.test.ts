import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, Observation, Perceiver, PixelRect, QteZone, RgbaImage } from '../src/contracts.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { ChestPerceiver, parseQte, qteWindow } from '../src/perception/chest.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { brakeAccelerationPxPerS2, brakeDistancePx, brakeTimeS, chooseQtePass, planTap, predictRest, qteVelocity, type QtePass } from '../src/policy/qte.ts';

/**
 * The six stills are one chest, recorded 2026-10-24 01:41 (`testdata/chest/2026-10-24-qte-0141/`).
 * They are JPEGs of the engine's own quality, so they are decoded here the way a `FrameSource`
 * decodes them: `jpeg-js` into RGBA, then a Frame whose `toRgba()` returns that image.
 *
 * The expected numbers are the measurements in `.superpowers/sdd/2026-10-24-wvd-world-v1/
 * research-qte-parser.md` §11, not numbers read back from the implementation: the zones' fill
 * interiors are 696–920 and 999–1223, the gap is 78 px, the marker's core sits at
 * 1072.5 … 768.5 across the six frames, and the 解除 control is at (960, 662).
 *
 * The recording itself (`…-qte-recorded/qte.mp4`, 250 frames) is not a unit fixture — extracting it
 * costs an `ffmpeg` run and the replay harness (Task 9) owns that. The six stills pin the geometry;
 * the recording's parse rate was measured out of band and is in the task report.
 */
const FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
/** A 3-D view: a real frame with no bar on it (peak warm in the band is 0). */
const NAV_FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

/** Marker core centres, frame-0 … frame-5 (research §11). The marker moves; the bar does not. */
const MARKER_X = [1072.5, 1011.5, 950.5, 889.5, 829.5, 768.5] as const;
const ZONES: readonly QteZone[] = [
  { from: 696, to: 920 },
  { from: 999, to: 1223 },
];
const BUTTON = { x: 960, y: 662 };

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Decoded once per fixture: `jpeg-js` spends ~150 ms on a 1080p frame, and 34 tests share six. */
const imageCache = new Map<string, Promise<RgbaImage>>();

function jpegImage(name: string, dir = FIXTURES): Promise<RgbaImage> {
  const key = `${dir.href}${name}`;
  let image = imageCache.get(key);
  if (!image) {
    image = readFile(new URL(name, dir)).then((bytes) => {
      const decoded = jpeg.decode(bytes, { useTArray: true });
      return { data: decoded.data, width: decoded.width, height: decoded.height };
    });
    imageCache.set(key, image);
  }
  return image;
}

function frameOf(image: RgbaImage, atMs: number): Frame {
  return { atMs, width: image.width, height: image.height, toRgba: async () => image };
}

async function jpegFrame(name: string, atMs = 1_000, dir = FIXTURES): Promise<Frame> {
  return frameOf(await jpegImage(name, dir), atMs);
}

function copyOf(image: RgbaImage): RgbaImage {
  return { data: Uint8Array.from(image.data), width: image.width, height: image.height };
}

/**
 * The full frame's `rect`, as a `Frame` of the rectangle's own size: the shape the engine's
 * `capture { crop }` reply has. `cropBgra` copies bytes and never interprets channels, so the decoded
 * RGBA buffer can go straight in.
 */
async function cropOf(frame: Frame, rect: PixelRect): Promise<Frame> {
  const image = await frame.toRgba();
  const cropped = cropBgra(image.data, image.width, image.height, rect);
  return frameOf(
    { data: cropped.pixels, width: cropped.width, height: cropped.height },
    frame.atMs,
  );
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function paint(image: RgbaImage, rect: Rect, rgb: readonly [number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
      image.data[offset + 3] = 255;
    }
  }
}

/** Copy columns `srcX …` over `dstX …`: used to erase the marker with the fill beside it. */
function copyColumns(
  image: RgbaImage,
  srcX: number,
  dstX: number,
  width: number,
  y0: number,
  y1: number,
): void {
  for (let y = y0; y <= y1; y += 1) {
    const from = (y * image.width + srcX) * 4;
    const to = (y * image.width + dstX) * 4;
    image.data.copyWithin(to, from, from + width * 4);
  }
}

function darken(image: RgbaImage, rect: Rect, factor: number): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = Math.round(image.data[offset] * factor);
      image.data[offset + 1] = Math.round(image.data[offset + 1] * factor);
      image.data[offset + 2] = Math.round(image.data[offset + 2] * factor);
    }
  }
}

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

type QteParseResult = Awaited<ReturnType<typeof parseQte>>;

/** Assert a parse happened and hand back its payload; a refusal fails the test with its reason. */
function read(result: QteParseResult): Extract<QteParseResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a parse, refused with '${result.reason}'`);
  return result;
}

function refusal(result: QteParseResult): string {
  if (result.ok) throw new Error('expected a refusal, got a parse');
  return result.reason;
}

// ---------------------------------------------------------------------------------------------
// parseQte — the bar and the marker
// ---------------------------------------------------------------------------------------------

describe('parseQte', () => {
  it('reads the two zones, the marker and the 解除 button from the first still', async () => {
    const parsed = read(await parseQte(await jpegFrame('frame-0.jpg')));

    expect(parsed.qte.zones).toEqual(ZONES);
    expect(parsed.qte.zones[1].from - parsed.qte.zones[0].to - 1).toBe(78);
    expect(parsed.qte.markerX).toBe(1072.5);
    expect(parsed.qte.button).toEqual(BUTTON);
    // Research §7: only the value 3 has ever been seen, so an attempt count would be a guess.
    expect(parsed.qte.attempts).toBeNull();
    expect(parsed.confidence).toBe(1);
    expect(parsed.enabled).toBe(true);
  });

  it('holds the bar fixed while the marker is the only white run that moves', async () => {
    const parsed = [];
    for (let index = 0; index < 6; index += 1) {
      parsed.push(read(await parseQte(await jpegFrame(`frame-${index}.jpg`))));
    }

    // The zones and the button are identical in all six frames (research §11).
    for (const entry of parsed) {
      expect(entry.qte.zones).toEqual(ZONES);
      expect(entry.qte.button).toEqual(BUTTON);
    }
    // Only the marker's x changes, and by the measured ~61 px per still.
    expect(parsed.map((entry) => entry.qte.markerX)).toEqual([...MARKER_X]);
  });

  it('refuses another frame size instead of mis-scaling the fixed anchors', async () => {
    let decodes = 0;
    const frame: Frame = {
      atMs: 1_000,
      width: 1280,
      height: 720,
      toRgba: async () => {
        decodes += 1;
        return uniformImage(1280, 720, 40);
      },
    };

    expect(refusal(await parseQte(frame))).toBe('unsupported-size');
    // Refused from the frame's declared size: a foreign frame never pays for its decode.
    expect(decodes).toBe(0);
  });

  it('refuses an image whose pixels are not the size the anchors were measured at', async () => {
    const frame: Frame = {
      atMs: 0,
      width: 1920,
      height: 1080,
      toRgba: async () => uniformImage(1280, 720, 40),
    };
    expect(refusal(await parseQte(frame))).toBe('unsupported-size');
  });

  it('refuses a frame with no bar and names the reason', async () => {
    const blank = frameOf(uniformImage(1920, 1080, 0), 1_000);
    expect(refusal(await parseQte(blank))).toBe('no-bar');

    // A real frame: the 3-D view has no bar (peak warm in the band measures 0).
    const hud = await jpegFrame('minimap-and-hud.jpg', 1_000, NAV_FIXTURES);
    expect(refusal(await parseQte(hud))).toBe('no-bar');
  });

  it('refuses when the marker is gone rather than reading a zone border as one', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    copyColumns(image, 1090, 1069, 8, 36, 82);
    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('no-marker');
  });

  it('refuses when two white runs could be the marker', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 950, y: 40, w: 8, h: 31 }, [255, 255, 255]);

    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('multi-marker');
  });

  it("uses the previous frame's marker to eliminate a static white run", async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 950, y: 40, w: 8, h: 31 }, [255, 255, 255]);

    // 953.5 is the painted run's centre; the survivor is the real marker at 1072.5.
    const parsed = read(await parseQte(frameOf(image, 1_000), 953.5));
    expect(parsed.qte.markerX).toBe(1072.5);
  });

  it('refuses when the zones merge into one run', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 921, y: 36, w: 78, h: 47 }, [255, 170, 30]);
    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('no-zones');
  });

  it('refuses a pair of zones whose gap is not a hazard gap', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 921, y: 36, w: 50, h: 47 }, [255, 170, 30]);
    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('bad-gap');
  });

  it('reads a narrow zone pair — the live chest with 陷阱解除 43 — without a width assumption', async () => {
    // Live 2026-10-25: choosing 爱丽丝 (陷阱解除 43) drew 39 px zones at 1920 with a 264 px hazard
    // gap. The zone width is set by the stat (chest spec §5), so it is a variable of the bar, not a
    // constant. Keep the measured 39 px at each zone's own centre and paint the rest as the gap;
    // the marker at 1072.5 is preserved between 1069 and 1076.
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 696, y: 36, w: 93, h: 47 }, [0, 0, 0]);    // 696–788: left zone's outer fill
    paint(image, { x: 828, y: 36, w: 93, h: 47 }, [0, 0, 0]);    // 828–920: left zone's inner fill
    paint(image, { x: 999, y: 36, w: 70, h: 47 }, [0, 0, 0]);    // 999–1068: right zone, before the marker
    paint(image, { x: 1077, y: 36, w: 15, h: 47 }, [0, 0, 0]);   // 1077–1091: right zone, after it
    paint(image, { x: 1131, y: 36, w: 93, h: 47 }, [0, 0, 0]);   // 1131–1223: right zone's outer fill

    const parsed = read(await parseQte(frameOf(image, 1_000)));

    expect(parsed.qte.zones).toEqual([{ from: 789, to: 827 }, { from: 1092, to: 1130 }]);
    expect(parsed.qte.zones.map((zone) => zone.to - zone.from + 1)).toEqual([39, 39]);
    expect(parsed.qte.zones[1].from - parsed.qte.zones[0].to - 1).toBe(264);
    expect(parsed.qte.markerX).toBe(1072.5);
    expect(parsed.qte.button).toEqual(BUTTON);
    expect(parsed.confidence).toBe(1);
  });

  it('refuses a gap that is not dark', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 921, y: 36, w: 78, h: 47 }, [200, 200, 200]);
    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('gap-not-dark');
  });

  it('refuses when the 解除 control is not on screen', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    paint(image, { x: 870, y: 572, w: 181, h: 181 }, [128, 128, 128]);
    expect(refusal(await parseQte(frameOf(image, 1_000)))).toBe('no-button');
  });

  it('reads a dimmed 解除 control as disabled, not as a live pass', async () => {
    const image = copyOf(await jpegImage('frame-0.jpg'));
    darken(image, { x: 929, y: 616, w: 63, h: 93 }, 0.7);

    const parsed = read(await parseQte(frameOf(image, 1_000)));
    expect(parsed.enabled).toBe(false);
    // Research §9: a dimmed control subtracts 0.20 and nothing else is wrong with this frame.
    expect(parsed.confidence).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------------------------
// parseQte — the QTE window crop (a sample reads the bar's own rectangle, not the whole frame)
// ---------------------------------------------------------------------------------------------

describe('parseQte from the QTE window', () => {
  it('returns the same QteState from a crop as from the full frame', async () => {
    for (let index = 0; index < MARKER_X.length; index += 1) {   // the six stills the file already loads
      const name = `frame-${index}.jpg`;
      const full = await jpegFrame(name, 1_000, FIXTURES);
      const fromFull = await parseQte(full);
      const rect = qteWindow(full);
      const origin = { x: rect.x, y: rect.y };
      const cropped = await cropOf(full, rect);     // decode once, cropBgra, re-encode as a Frame
      const fromCrop = await parseQte(cropped, undefined, origin);
      expect(fromCrop).toEqual(fromFull);
    }
  });

  it('refuses a crop whose size is not the QTE window', async () => {
    const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
    const cropped = await cropOf(full, { x: 645, y: 36, width: 631, height: 400 });
    expect(await parseQte(cropped, undefined, { x: 645, y: 36 })).toEqual({
      ok: false,
      reason: 'unsupported-size',
    });
  });

  it('refuses the full frame when asked to read it as a crop', async () => {
    const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
    expect(await parseQte(full, undefined, { x: 0, y: 0 })).toEqual({ ok: false, reason: 'unsupported-size' });
  });

  it('refuses a same-sized crop taken at another origin', async () => {
    // A 631x699 crop is only the QTE window if it was cut at the window's top-left. The same pixels
    // at another origin would parse at full confidence against the wrong columns, so the origin is
    // part of the size gate — and a foreign one is refused before the decode is paid for.
    const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
    const rect = qteWindow(full);
    const cropped = await cropOf(full, rect);
    let decodes = 0;
    const guarded: Frame = {
      ...cropped,
      toRgba: async () => {
        decodes += 1;
        return cropped.toRgba();
      },
    };

    expect(await parseQte(guarded, undefined, { x: rect.x + 8, y: rect.y }))
      .toEqual({ ok: false, reason: 'unsupported-size' });
    expect(await parseQte(guarded, undefined, { x: rect.x, y: rect.y + 8 }))
      .toEqual({ ok: false, reason: 'unsupported-size' });
    expect(decodes).toBe(0);
    // At the window's own origin the same crop parses, so the refusal above is the origin.
    expect((await parseQte(guarded, undefined, { x: rect.x, y: rect.y })).ok).toBe(true);
    expect(decodes).toBe(1);
  });

  it('keeps refusing a non-1080p full frame', async () => {
    const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
    const cropped = await cropOf(full, { x: 0, y: 0, width: 1280, height: 720 });
    expect(await parseQte(cropped)).toEqual({ ok: false, reason: 'unsupported-size' });
  });
});

// ---------------------------------------------------------------------------------------------
// ChestPerceiver
// ---------------------------------------------------------------------------------------------

describe('ChestPerceiver', () => {
  it('reports chest-qte with the parsed state and the frame time', async () => {
    const frame = await jpegFrame('frame-3.jpg', 4_321);
    const observation = await new ChestPerceiver().observe(frame);

    expect(observation.screen).toBe('chest-qte');
    expect(observation.atMs).toBe(4_321);
    if (observation.screen !== 'chest-qte') throw new Error('not a QTE observation');
    expect(observation.qte.zones).toEqual(ZONES);
    expect(observation.qte.markerX).toBe(889.5);
    expect(observation.confidence).toBe(1);
  });

  it('answers unknown, not a QTE guess, when the bar is not there', async () => {
    const observation = await new ChestPerceiver().observe(
      await jpegFrame('minimap-and-hud.jpg', 2_000, NAV_FIXTURES),
    );

    expect(observation.screen).toBe('unknown');
    expect(observation.confidence).toBe(0);
    expect(observation.atMs).toBe(2_000);
  });

  it('never answers a bar frame as the opener panel', async () => {
    // The panel parser runs first and gates on the modal's dark title band and the cards' borders;
    // the bar lives in rows 36–82 of the same frame format, so no bar frame can satisfy it. A bar
    // frame that is not the panel is still the bar — and the walking view is still `unknown`.
    const frames = await Promise.all(MARKER_X.map((_, index) => jpegFrame(`frame-${index}.jpg`)));
    for (const frame of frames) {
      expect((await new ChestPerceiver().observe(frame)).screen).toBe('chest-qte');
    }
    expect(
      (await new ChestPerceiver().observe(await jpegFrame('minimap-and-hud.jpg', 1_000, NAV_FIXTURES))).screen,
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// CompositePerceiver — the composition seam
// ---------------------------------------------------------------------------------------------

class StubPerceiver implements Perceiver {
  calls = 0;

  constructor(private readonly answer: (frame: Frame) => Observation | Promise<Observation>) {}

  async observe(frame: Frame): Promise<Observation> {
    this.calls += 1;
    return this.answer(frame);
  }
}

const qteState = { zones: ZONES, markerX: 889.5, button: BUTTON, attempts: null } as const;

describe('CompositePerceiver', () => {
  const frame = (): Frame => frameOf(uniformImage(8, 8, 0), 777);

  it('returns the first recogniser whose confidence clears its floor', async () => {
    const first = new StubPerceiver((f) => ({ screen: 'dungeon', atMs: f.atMs, confidence: 0.9 }));
    const second = new StubPerceiver(() => ({
      screen: 'chest-qte' as const,
      atMs: 0,
      confidence: 1,
      qte: qteState,
    }));
    const composite = new CompositePerceiver([
      { perceiver: first, floor: 0.5 },
      { perceiver: second, floor: 0.5 },
    ]);

    const observation = await composite.observe(frame());

    expect(observation.screen).toBe('dungeon');
    expect(observation.confidence).toBe(0.9);
    expect(second.calls).toBe(0);
  });

  it('skips a recogniser whose confidence is below its floor and tries the next', async () => {
    const weak = new StubPerceiver((f) => ({ screen: 'dungeon', atMs: f.atMs, confidence: 0.4 }));
    const strong = new StubPerceiver((f) => ({ screen: 'dungeon', atMs: f.atMs, confidence: 0.8 }));
    const composite = new CompositePerceiver([
      { perceiver: weak, floor: 0.5 },
      { perceiver: strong, floor: 0.5 },
    ]);

    const observation = await composite.observe(frame());

    expect(observation.confidence).toBe(0.8);
    expect(weak.calls).toBe(1);
    expect(strong.calls).toBe(1);
  });

  it('answers unknown at the strongest refusal when no recogniser clears its floor', async () => {
    // A name below its recogniser's floor is not trusted for acting, but it is still evidence that
    // the frame was drawn: the fallback repeats that confidence, so the session classifier escalates
    // (a stop is reserved for the all-zero answer, Task 10 review Critical 1).
    const composite = new CompositePerceiver([
      { perceiver: new StubPerceiver((f) => ({ screen: 'unknown', atMs: f.atMs, confidence: 0 })), floor: 0.5 },
      { perceiver: new StubPerceiver(() => ({ screen: 'dungeon' as const, atMs: 0, confidence: 0.3 })), floor: 0.5 },
    ]);

    const observation = await composite.observe(frame());

    expect(observation).toEqual({ screen: 'unknown', atMs: 777, confidence: 0.3 });
  });

  it('answers unknown at confidence 0 only when every recogniser saw nothing', async () => {
    const composite = new CompositePerceiver([
      { perceiver: new StubPerceiver((f) => ({ screen: 'unknown', atMs: f.atMs, confidence: 0 })), floor: 0.5 },
      { perceiver: new StubPerceiver((f) => ({ screen: 'unknown', atMs: f.atMs, confidence: 0 })), floor: 0.5 },
    ]);

    expect(await composite.observe(frame())).toEqual({ screen: 'unknown', atMs: 777, confidence: 0 });
  });

  it('decodes the frame once, however many recognisers read it', async () => {
    const image = uniformImage(8, 8, 0);
    let decodes = 0;
    const counting: Frame = {
      atMs: 9,
      width: 8,
      height: 8,
      toRgba: async () => {
        decodes += 1;
        return image;
      },
    };
    const reader = (confidence: number) =>
      new StubPerceiver(async (f) => {
        await f.toRgba();
        return { screen: 'dungeon', atMs: f.atMs, confidence };
      });
    const composite = new CompositePerceiver([
      { perceiver: reader(0.1), floor: 0.5 },
      { perceiver: reader(0.9), floor: 0.5 },
    ]);

    const observation = await composite.observe(counting);

    expect(observation.screen).toBe('dungeon');
    expect(decodes).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// planTap — contracts §7
// ---------------------------------------------------------------------------------------------

/** The configuration the chest policy will pass (contracts §8.4); 610 px/s is the video's speed. */
const TAP = { latencyMs: 75, decelPxPerS2: 3_000, horizonMs: 1_000 } as const;

describe('planTap', () => {
  it('plans a tap on the right zone for a rightward marker', async () => {
    const plan = planTap({ markerX: 800, v: 610, zones: ZONES, ...TAP });

    expect(plan).not.toBeNull();
    // No brake (the default): stop = 800 + 610·0.075 = 845.75 → (1111 − 845.75)/610 = 434.84 ms.
    expect(plan!.target).toBe(1111);
    expect(plan!.target).toBeGreaterThanOrEqual(ZONES[1].from);
    expect(plan!.target).toBeLessThanOrEqual(ZONES[1].to);
    expect(plan!.atMs).toBeCloseTo(434.84, 1);
  });

  it('carries the sign of motion into the latency lead', () => {
    // Mirrored geometry: 311 px to the target either way. `v·latency` has the sign of motion, so
    // both take 434.84 ms; a lead without the sign would take 584.75 ms leftward.
    const rightward = planTap({ markerX: 800, v: 610, zones: [{ from: 1101, to: 1121 }], ...TAP });
    const leftward = planTap({ markerX: 1200, v: -610, zones: [{ from: 879, to: 899 }], ...TAP });

    expect(rightward).not.toBeNull();
    expect(leftward).not.toBeNull();
    expect(leftward!.target).toBeCloseTo(889, 6);
    expect(leftward!.atMs).toBeCloseTo(434.84, 1);
    expect(leftward!.atMs).toBeCloseTo(rightward!.atMs, 6);
    // A negative lead: the plan aims behind a marker that is travelling left, and still waits.
    expect(leftward!.target).toBeLessThan(1200);
    expect(leftward!.atMs).toBeGreaterThan(0);
  });

  it('plans a tap on the left zone for a leftward marker', () => {
    // At 1 150 the right zone's centre (1 111) is already behind the no-brake stop (1 150 − 45.75 =
    // 1 104.25), so the plan takes the left zone's 808.
    const plan = planTap({ markerX: 1150, v: -610, zones: ZONES, ...TAP });

    expect(plan).not.toBeNull();
    expect(plan!.target).toBe(808);
    // No brake: (808 − 1 150 + 45.75)/(−610) = 485.66 ms.
    expect(plan!.atMs).toBeCloseTo(485.66, 1);
  });

  it('takes the soonest reachable zone', () => {
    const plan = planTap({ markerX: 650, v: 610, zones: ZONES, ...TAP });

    // (808 − 650 − 45.75)/610 = 184.02 ms, against 681 ms for the right zone.
    expect(plan!.target).toBe(808);
    expect(plan!.atMs).toBeCloseTo(184.02, 1);
  });

  it('refuses a target past the bounce in the direction of travel', () => {
    // Moving right, a centre beyond 1261.5 is on the other side of a reversal.
    expect(planTap({ markerX: 1200, v: 610, zones: [{ from: 1300, to: 1400 }], ...TAP })).toBeNull();
    // Moving left, a centre below 656.5 is.
    expect(planTap({ markerX: 700, v: -610, zones: [{ from: 500, to: 560 }], ...TAP })).toBeNull();
  });

  it('aims earlier by the measured carry of this bar', () => {
    // Operator rule 2026-11-05: the park says the bar carries 100 px after the press, so the plan
    // subtracts it from the delay. Without the carry the right zone would take 434.84 ms.
    const plan = planTap({ markerX: 800, v: 610, zones: ZONES, ...TAP, carryPx: 100 });
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe(1111);
    // (1111 - 800 - 45.75 - 100)/610 = 270.90 ms.
    expect(plan!.atMs).toBeCloseTo(270.9, 1);
  });

  it('returns the stop band it judged, and presses only a plan inside the zone', () => {
    // The band is |v|*0.015 + 20 + |delay + 0.075|*35 = 9.15 + 20 + 12.1 = 41.3 px on the wide zone.
    const plan = planTap({
      markerX: 800, v: 610, zones: ZONES, ...TAP, carryPx: 100,
      latencySpreadMs: 15, carrySpreadPx: 20, velocitySpreadPxPerS: 35, minOverlap: 0.95,
    });
    expect(plan).not.toBeNull();
    expect(plan!.bandPx).toBeCloseTo(41.3, 1);
    expect(plan!.overlap).toBeCloseTo(1, 6);

    // A 42 px zone cannot contain that band to 95 %: no plan, rather than a gamble.
    expect(planTap({
      markerX: 800, v: 610, zones: [{ from: 1_090, to: 1_132 }], ...TAP, carryPx: 100,
      latencySpreadMs: 15, carrySpreadPx: 20, velocitySpreadPxPerS: 35, minOverlap: 0.95,
    })).toBeNull();
  });

  it('refuses a pass the marker has already gone past', () => {
    // At 1200 moving right both zone centres are behind the predicted stop.
    expect(planTap({ markerX: 1200, v: 610, zones: ZONES, ...TAP })).toBeNull();
  });

  it('refuses a pass outside the prediction horizon', () => {
    expect(planTap({ markerX: 650, v: 610, zones: ZONES, ...TAP, horizonMs: 50 })).toBeNull();
  });

  it('refuses a marker that is not moving', () => {
    expect(planTap({ markerX: 800, v: 0, zones: ZONES, ...TAP })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// predictRest — where the marker lands if the press is issued now
// ---------------------------------------------------------------------------------------------

describe('predictRest', () => {
  it('carries the reading through its age and the input leg, with no brake by default', () => {
    // 610 px/s: 610·(0.050 + 0.075) = 76.25 px before the game sees the press, and nothing more —
    // the 2026-10-31 live presses had no post-press carry.
    expect(predictRest({ markerX: 700, v: 610, ageMs: 50, latencyMs: 75, decelPxPerS2: 3000 }))
      .toBeCloseTo(776.25, 1);
  });

  it('carries a leftward marker the other way', () => {
    expect(predictRest({ markerX: 700, v: -610, ageMs: 50, latencyMs: 75, decelPxPerS2: 3000 }))
      .toBeCloseTo(623.75, 1);
  });

  it('refuses an input it cannot answer', () => {
    const base = { markerX: 700, v: 610, ageMs: 50, latencyMs: 75, decelPxPerS2: 3000 };
    expect(predictRest({ ...base, v: 0 })).toBeNull();
    expect(predictRest({ ...base, markerX: Number.NaN })).toBeNull();
    expect(predictRest({ ...base, ageMs: -1 })).toBeNull();
    expect(predictRest({ ...base, latencyMs: Number.NaN })).toBeNull();
    expect(predictRest({ ...base, decelPxPerS2: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The brake switch — the 2026-10-24 model, still reachable behind brakeEnabled
// ---------------------------------------------------------------------------------------------

/**
 * The default is no brake, but the one recording with a stop measured a 68 px carry and the model
 * that reproduces it (`brakeDistancePx`) is still what a probe runs when it flips
 * `worlds.wvd.qteBrakeEnabled` on. These are the pre-switch expectations, kept under the switch so
 * the default change cannot silently delete the measured model.
 */
describe('brakeEnabled: the 2026-10-24 brake expectations', () => {
  it('plans with the carry at the recorded speed', () => {
    // stop = 800 + 610·0.075 + 61.02 = 907.77 → (1111 − 907.77)/610 = 333.17 ms.
    const plan = planTap({ markerX: 800, v: 610, zones: ZONES, ...TAP, brakeEnabled: true });
    expect(plan).not.toBeNull();
    expect(plan!.target).toBe(1111);
    expect(plan!.atMs).toBeCloseTo(333.17, 1);
  });

  it('mirrors the sign-corrected carry', () => {
    const rightward = planTap({ markerX: 800, v: 610, zones: [{ from: 1101, to: 1121 }], ...TAP, brakeEnabled: true });
    const leftward = planTap({ markerX: 1200, v: -610, zones: [{ from: 879, to: 899 }], ...TAP, brakeEnabled: true });
    expect(leftward).not.toBeNull();
    expect(leftward!.target).toBeCloseTo(889, 6);
    expect(leftward!.atMs).toBeCloseTo(333.17, 1);
    expect(leftward!.atMs).toBeCloseTo(rightward!.atMs, 6);
  });

  it('plans the left zone 465.96 ms out and takes the soonest zone at 82.35 ms', () => {
    expect(planTap({ markerX: 1200, v: -610, zones: ZONES, ...TAP, brakeEnabled: true })!.atMs)
      .toBeCloseTo(465.96, 1);
    expect(planTap({ markerX: 650, v: 610, zones: ZONES, ...TAP, brakeEnabled: true })!.atMs)
      .toBeCloseTo(82.35, 1);
  });

  it('predicts the braked rest', () => {
    // The same 76.25 px of age and input leg, then the drag brake's 62.02 px.
    expect(predictRest({ markerX: 700, v: 610, ageMs: 50, latencyMs: 75, decelPxPerS2: 3000, brakeEnabled: true }))
      .toBeCloseTo(838.27, 1);
    expect(predictRest({ markerX: 700, v: -610, ageMs: 50, latencyMs: 75, decelPxPerS2: 3000, brakeEnabled: true }))
      .toBeCloseTo(561.73, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// The live 2026-10-31 presses — why the switch defaults off
// ---------------------------------------------------------------------------------------------

/**
 * The two presses the live run recorded on 2026-10-31, as `QteTiming` reports them: the planning
 * reading's signed speed `v`, its marker `tapX`, and where the marker actually parked `restX`.
 * Each rest is a consistent no-brake landing: travelling at `v` for the whole interval from the
 * reading to the press's effect explains every pixel of the observed `tapX → restX` travel. The
 * spec records that these presses parked **~4 px** past the press (chest spec §3), so the press's
 * effect sits 4 px short of the rest; the brake model would add its carry on top and be tens of px
 * past the rest.
 */
describe('the live 2026-10-31 presses', () => {
  const PRESSES = [
    { v: -429.79, tapX: 1_088.5, restX: 856.5 },   // leftward, into the left zone
    { v: 802.0, tapX: 953.5, restX: 1_096.5 },      // rightward, into the right zone
  ] as const;
  const PARKED_PAST_PRESS_PX = 4;
  const LATENCY_MS = 75;
  const DECEL_PX_PER_S2 = 3_000;

  it('predicts each live rest without the brake, and the brake model misses by its carry', () => {
    for (const press of PRESSES) {
      const travel = Math.abs(press.restX - press.tapX);
      const pressTravel = travel - PARKED_PAST_PRESS_PX;
      const readingToPressMs = (pressTravel / Math.abs(press.v)) * 1_000;
      const ageMs = readingToPressMs - LATENCY_MS;
      expect(ageMs).toBeGreaterThan(0);

      const common = {
        markerX: press.tapX, v: press.v, ageMs, latencyMs: LATENCY_MS, decelPxPerS2: DECEL_PX_PER_S2,
      };
      const noBrake = predictRest({ ...common, brakeEnabled: false });
      const braked = predictRest({ ...common, brakeEnabled: true });
      expect(noBrake).not.toBeNull();
      expect(braked).not.toBeNull();

      // The no-brake model reproduces the ~4 px residual the live spec records ...
      const noBrakeError = Math.abs(noBrake! - press.restX);
      const brakeError = Math.abs(braked! - press.restX);
      expect(noBrakeError).toBeCloseTo(PARKED_PAST_PRESS_PX, 6);
      // ... while the brake model overshoots by its carry, less that same residual.
      expect(brakeError).toBeCloseTo(brakeDistancePx(press.v, 2 * DECEL_PX_PER_S2) - PARKED_PAST_PRESS_PX, 6);
      expect(noBrakeError).toBeLessThan(brakeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// qteVelocity — research §8: three frames, ≥ 66 ms, reversal-aware
// ---------------------------------------------------------------------------------------------

describe('qteVelocity', () => {
  it('measures a steady rightward speed from three samples 66 ms apart', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 1_020 },
      { atMs: 66, markerX: 1_040 },
    );
    expect(v).toBeCloseTo(606.06, 1);
  });

  it('returns a signed speed for a leftward marker', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 980 },
      { atMs: 66, markerX: 960 },
    );
    expect(v).toBeCloseTo(-606.06, 1);
  });

  it('refuses a duplicated frame instead of reporting 1215 px/s', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 1_000 },
      { atMs: 66, markerX: 1_040 },
    );
    expect(v).toBeNull();
  });

  it('refuses a pair that straddles a reversal', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 1_020 },
      { atMs: 66, markerX: 990 },
    );
    expect(v).toBeNull();
  });

  it('refuses a baseline shorter than 66 ms', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 1_020 },
      { atMs: 50, markerX: 1_040 },
    );
    expect(v).toBeNull();
  });

  it('refuses an eased marker near a bounce', () => {
    const v = qteVelocity(
      { atMs: 0, markerX: 1_000 },
      { atMs: 33, markerX: 1_002 },
      { atMs: 66, markerX: 1_004 },
    );
    expect(v).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The tick budget — contracts §0 rule 7 (observe() inside half a tick, 50 ms)
// ---------------------------------------------------------------------------------------------

describe('the half-tick budget', () => {
  it('keeps observe inside 50 ms for an already-decoded frame', async () => {
    const images = await Promise.all(MARKER_X.map((_, index) => jpegImage(`frame-${index}.jpg`)));
    const perceiver = new ChestPerceiver();
    const samples: number[] = [];

    for (let round = 0; round < 10; round += 1) {
      for (const image of images) {
        const start = performance.now();
        const observation = await perceiver.observe(frameOf(image, round * 100));
        samples.push(performance.now() - start);
        expect(observation.screen).toBe('chest-qte');
      }
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    expect(p50).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------------------------
// The attempt-vs-reroll policy (operator rule, 2026-10-31)
// ---------------------------------------------------------------------------------------------

/**
 * The rule as the operator stated it: **each open or reroll is judged on its own pass — press if
 * the pass can succeed, reroll if it cannot — and the budget is a ceiling, not a quota.** A pass can
 * succeed when the marker's time inside the aimed zone clears `qteMinWindowMs` (150 ms at default
 * settings), the same floor `timeQte` applies to the plan's lead time.
 *
 * The reroll is what makes this decidable at all: cancelling a floor chest's QTE costs no attempt
 * (chest §4), so an unacceptable bar is cancelled rather than gambled on, and the next card click
 * changes the marker's speed.
 */
describe('chooseQtePass', () => {
  const budget = 5;
  const floor = 150;
  const pass = (windowMs: number): QtePass => ({ windowMs, speedPxPerS: 600 });

  it('presses the first pass that clears the floor, without spending a reroll', () => {
    expect(chooseQtePass(pass(300), { rerolls: 0, budget }, floor)).toBe('press');
    expect(chooseQtePass(pass(150), { rerolls: 0, budget }, floor)).toBe('press');
  });

  it('rerolls a pass that cannot be pressed while budget remains', () => {
    expect(chooseQtePass(pass(149), { rerolls: 0, budget }, floor)).toBe('reroll');
    expect(chooseQtePass(pass(40), { rerolls: 4, budget }, floor)).toBe('reroll');
  });

  it('presses a good pass after rerolls, so the budget is never spent just because it exists', () => {
    expect(chooseQtePass(pass(220), { rerolls: 3, budget }, floor)).toBe('press');
  });

  it('gives up when the budget is spent and the bar still cannot be pressed', () => {
    expect(chooseQtePass(pass(60), { rerolls: budget, budget }, floor)).toBe('give-up');
    expect(chooseQtePass(pass(Number.NaN), { rerolls: budget, budget }, floor)).toBe('give-up');
  });

  it('treats a zero budget as "no rerolls", not as an unbounded one', () => {
    expect(chooseQtePass(pass(60), { rerolls: 0, budget: 0 }, floor)).toBe('give-up');
  });
});

// ---------------------------------------------------------------------------------------------
// The native 1920 narrow-zone QTE (captured live 2026-10-31)
// ---------------------------------------------------------------------------------------------

/**
 * The fixture the card owed: a **native 1920×1080** capture of a narrow-zone QTE, taken live on
 * 2026-10-31 02:50 from B1F-巨坑- with 拉纳维尔 (陷阱解除 38) as the opener. The zones measure 30 px
 * and 43 px — narrower than the 39 px the 1280 escalation frame implied — and the full frame plus the
 * engine's own 631×699 bar window are both committed. The width gate is gone (`ZONE_MIN_WIDTH` 4 px,
 * structure-gated), so both must read.
 */
describe('the native narrow-zone QTE (2026-10-31)', () => {
  const NARROW = new URL('../testdata/chest/2026-10-31-narrow-qte/', import.meta.url);

  it('reads the narrow zones from the full 1920 frame', async () => {
    const parsed = await parseQte(await jpegFrame('frame.jpg', 1_000, NARROW));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.qte.zones.map((zone) => zone.to - zone.from)).toEqual([30, 43]);
    expect(parsed.qte.button).toEqual({ x: 966, y: 662 });
    expect(parsed.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('reads the same zones from the 631x699 bar window at its origin', async () => {
    const origin = qteWindow({ width: 1920, height: 1080 });
    const parsed = await parseQte(await jpegFrame('bar.jpg', 1_000, NARROW), undefined, origin);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.qte.zones.map((zone) => zone.to - zone.from)).toEqual([30, 43]);
  });
});

// ---------------------------------------------------------------------------------------------
// The brake model (2026-10-31)
// ---------------------------------------------------------------------------------------------

/**
 * Measured from the one recording that contains a stop (`2026-10-24-qte-recorded/qte.mp4`, 30 fps,
 * extracted to `.tmp/qtefull/`): the marker ran at 600–630 px/s, then the speed collapsed — 240,
 * 240, 225, 180, 165, 135, 120, 120, 60, 60, 60, 30, 30, 0 px/s over 15 frames — and parked 68 px
 * past the press. Not a constant deceleration: the head is ~12 000 px/s² and the tail ~450 px/s².
 * The shape is exponential, so the acceleration is proportional to the speed (exponent 1), which
 * makes the brake time a constant τ and the carry proportional to speed.
 */
describe('the brake model', () => {
  it('keeps the recorded carry at the recorded speed', () => {
    expect(brakeDistancePx(610, 6000)).toBeCloseTo(62, 0);
    expect(brakeTimeS(610, 6000)).toBeCloseTo(0.1017, 3);
  });

  it('scales the carry with speed, not with its square (the exponential stop)', () => {
    expect(brakeDistancePx(305, 6000)).toBeCloseTo(brakeDistancePx(610, 6000) / 2, 1);
    expect(brakeTimeS(305, 6000)).toBeCloseTo(brakeTimeS(610, 6000), 6);
  });

  it('refuses a model it cannot evaluate instead of inventing a carry', () => {
    expect(brakeDistancePx(0, 6000)).toBe(0);
    expect(brakeDistancePx(610, 0)).toBe(0);
    expect(Number.isNaN(brakeAccelerationPxPerS2(610, Number.NaN))).toBe(true);
  });
});
