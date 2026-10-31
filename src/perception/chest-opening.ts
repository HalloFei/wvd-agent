/**
 * The chest's opening moment: the panel has been answered, the lid is lifting, the hands reach in —
 * and **no bar is up yet** (chest §3a: the bar arrives ~1.5-2 s later, and an untrapped chest never
 * draws one).
 *
 * Before this module the moment had no name: the bar's recogniser refused (`no-bar`), the panel had
 * left, and the HUD is **not drawn** during the opening, so the composite fell through to `unknown`
 * — and the loop's stall clock could escalate a screen that was working exactly as intended. Naming
 * it turns "a frame nothing understood" into "the chest is opening; wait", which is the route
 * policy's answer for it.
 *
 * Two measurements name it, both from `testdata/chest/2026-10-24-live-qte/open-*.jpg` (eight frames
 * of one opening, 1920x1080) against every other screen the corpus has:
 *
 * | screen        | bright HUD text px | warm mass, centre box |
 * | ---           | ---                | --- |
 * | opening       | 0-12               | 0.09-0.31 |
 * | 3-D view      | 8 040              | 0.01 |
 * | chest QTE     | 153-1 020          | 0.39 |
 * | opener panel  | 506                | 0.29 |
 * | loot          | 8                  | 0.03 |
 * | 打开 prompt    | 0                  | 0.27 |
 *
 * So: **the HUD is gone** (its bright text count is under 40) **and the chest fills the middle**
 * (warm pixels are at least 6 % of the central half-frame). The 打开 prompt also has no HUD, which
 * is why `ChestPromptPerceiver` must run before this one (it does, in the composite); the loot
 * screen is excluded by the warm floor.
 *
 * The two numbers are one-sample-per-screen and named as such; a second opening recording refines
 * them. Geometry is the 1920x1080 client (contracts §0.5); another size is refused, never rescaled.
 */
import type { Frame, Observation, Perceiver } from '../contracts.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The party HUD's text: the HP/MP numerals and names, in the lower-left of the client. */
const HUD_TEXT_BAND = { x0: 0.08, x1: 0.56, y0: 0.52, y1: 0.68 } as const;
/** Bright enough to be the HUD's white text; measured 0-12 px on the eight opening frames. */
const HUD_TEXT_BRIGHT = 205;
/** Under this the HUD is not drawn (measured: opening 0-12, every other screen ≥ 153 except loot). */
const HUD_TEXT_MAX = 40;

/** The chest's mass: the middle half of the frame, where the lid and hands fill the view. */
const CHEST_BOX = { x0: 0.25, x1: 0.75, y0: 0.25, y1: 0.75 } as const;
/** Warm: the chest's wood and the torchlight, against the grey stone. */
const WARM_MIN_RED = 85;
/** At least this share of the chest box is warm (measured: opening 0.09-0.31, 3-D view 0.01). */
const WARM_MIN_SHARE = 0.06;

/** A flat field is "nothing was drawn", not this screen (contracts §2). */
const FLAT_STD_DEV = 8;
/** Positive refusal: busy, but not the opening — above every act floor, below the named answer. */
const UNNAMED_CONFIDENCE = 0.2;
/** The answer's confidence: above the route's 0.5 act floor, below the bar's 1.0. */
const OPENING_CONFIDENCE = 0.6;

export class ChestOpeningPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: UNNAMED_CONFIDENCE };
    }
    let image;
    try {
      image = await frame.toRgba();
    } catch {
      return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    }
    if (isFlat(image)) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    if (hudTextCount(image) > HUD_TEXT_MAX) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: UNNAMED_CONFIDENCE };
    }
    if (warmShare(image) < WARM_MIN_SHARE) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: UNNAMED_CONFIDENCE };
    }
    return { screen: 'chest-opening', atMs: frame.atMs, confidence: OPENING_CONFIDENCE };
  }
}

/** Mean and spread over every eighth pixel: a flat or black frame is not this screen. */
function isFlat(image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): boolean {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += 8) {
    for (let x = 0; x < image.width; x += 8) {
      const o = (y * image.width + x) * 4;
      const luma = (image.data[o]! + image.data[o + 1]! + image.data[o + 2]!) / 3;
      sum += luma;
      sumSq += luma * luma;
      count += 1;
    }
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean)) < FLAT_STD_DEV;
}

/** Bright, near-white pixels in the party HUD's band: the HUD's text when it is drawn. */
function hudTextCount(image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): number {
  const x0 = Math.round(image.width * HUD_TEXT_BAND.x0);
  const x1 = Math.round(image.width * HUD_TEXT_BAND.x1);
  const y0 = Math.round(image.height * HUD_TEXT_BAND.y0);
  const y1 = Math.round(image.height * HUD_TEXT_BAND.y1);
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      const r = image.data[o]!;
      const g = image.data[o + 1]!;
      const b = image.data[o + 2]!;
      if (r > HUD_TEXT_BRIGHT && g > HUD_TEXT_BRIGHT && b > HUD_TEXT_BRIGHT) count += 1;
    }
  }
  return count;
}

/** The share of the central box that is warm (wood, torchlight) rather than stone or UI. */
function warmShare(image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): number {
  const x0 = Math.round(image.width * CHEST_BOX.x0);
  const x1 = Math.round(image.width * CHEST_BOX.x1);
  const y0 = Math.round(image.height * CHEST_BOX.y0);
  const y1 = Math.round(image.height * CHEST_BOX.y1);
  let warm = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const o = (y * image.width + x) * 4;
      const r = image.data[o]!;
      const g = image.data[o + 1]!;
      const b = image.data[o + 2]!;
      total += 1;
      if (r > WARM_MIN_RED && r > b * 1.35 && r > g * 1.05) warm += 1;
    }
  }
  return total === 0 ? 0 : warm / total;
}
