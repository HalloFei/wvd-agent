/**
 * The chest's loot result: the brown contents card with its item icons, the `获得了…` caption under
 * it, and the small AUTO label at the frame's bottom left.
 *
 * Before this module the overlay had no name. The party HUD is not drawn on it, the bar is gone (or
 * was never drawn), and the opener panel has left — so the composite fell through to `unknown`, and
 * the route's answer to an unnamed screen is `wait`. The farm would stand on the one screen that
 * needs a single tap.
 *
 * One capture names it, `testdata/chest/2026-10-31-loot/loot-00.jpg` (1280×720): the loot overlay
 * after 锈迹斑斑的古钱. The card is a screen-anchored UI panel, so it is measured as **fractions of a
 * 16:9 frame** — the same geometry then serves the World's 1920×1080 client (contracts §0.5) without
 * the perceiver resizing anything. That is the one place this repository's fixed-pixel rule bends,
 * and it is what the two frame sizes require; a native 1920 capture would refine the fractions, not
 * change their shape.
 *
 * | fact (fractions of a 16:9 frame)          | loot                | the closest non-loot frame                 |
 * | ---                                       | ---                 | ---                                        |
 * | card border rows: top / bottom            | 0.335 / 0.664       | no other screen draws this pair            |
 * | top border gain over its neighbourhood    | +76                 | +62 on an opening frame's lid edge         |
 * | bottom border gain                        | +65                 | +76 on the same frame (`open-07`)          |
 * | border row spans the card, not the frame  | 3.2× / 2.6× central-over-flank | 1.6× on that frame              |
 * | card interior strip spread (sd)           | 7.9 / 5.2           | 20.8 on that frame; 47–61 on dialogs       |
 * | `获得了…` bright ink px, y 0.78–0.86       | 407                 | 12 on that frame                           |
 * | AUTO label px over luma 40, bottom left   | 46                  | ordinary HUD text overlaps that region     |
 *
 * The counterexample that matters is `open-07.jpg`: the lifting lid's edge draws horizontal rows
 * with *comparable* gains (62/76 against the card's 76/65), so the border test alone cannot tell an
 * opening from the loot. What does is **the card's flat interior** — a UI panel's fill, sd under 8,
 * where the lid and the hands are textured (sd 21–30) — and **the caption**: the result line is only
 * drawn once the loot is up (407 px against 12). The dialogs that also draw bright lines (the dungeon
 * map, the popup) clear the caption test and fail the interior test by a wide margin (sd 47+).
 *
 * AUTO is drawn — 46 px over luma 40 in a 39×12 box at 1280 — but it is dim (max luma 75) and small
 * enough that mistaking ordinary HUD text for it is likelier than the evidence it adds; it is
 * recorded here and deliberately not a gate. One capture is one sample: a second loot frame refines
 * the numbers, and a native 1920 capture pins the fractions.
 *
 * The size rule: a 16:9 frame at least 640 px wide is measured in fractions; anything else is
 * refused, because the overlay is laid out against the client and a crop would move every fraction
 * while the frame's own size says nothing about the client it came from.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

/** The narrowest frame this geometry is stated for: half the measured capture's width. */
const MIN_WIDTH = 640;

/** 16:9, the client's shape (contracts §0.5); a frame within 2 % of it is measured as one. */
const TARGET_ASPECT = 16 / 9;
const ASPECT_TOLERANCE = 0.02;

/** The card's horizontal extent: 0.314–0.684 measured; the detection band stays inside it. */
const CARD_X0 = 0.34;
const CARD_X1 = 0.66;

/** The card's border rows: 0.335 top and 0.664 bottom on the capture, with a few pixels of drift. */
const TOP_BAND = { y0: 0.30, y1: 0.38 } as const;
const BOTTOM_BAND = { y0: 0.62, y1: 0.72 } as const;

/** How far outside a band the baseline is sampled: 0.04 of the frame's height. */
const BASELINE_FRACTION = 0.04;

/** A border line is a bright row — measured peak 134 top, 107 bottom — far above its neighbours. */
const BORDER_PEAK_MIN = 85;
const BORDER_GAIN_MIN = 45;

/** The card is 0.329 of the frame's height tall (0.664 − 0.335), plus or minus a few pixels. */
const CARD_HEIGHT_MIN = 0.28;
const CARD_HEIGHT_MAX = 0.38;

/** The line must span the card: central band over the brightest flank, measured 3.2× and 2.6×. */
const LINE_SPAN_RATIO = 1.4;
/** The flanks a card-width line must outshine; the card itself spans 0.314–0.684. */
const LEFT_FLANK = { x0: 0.10, x1: 0.24 } as const;
const RIGHT_FLANK = { x0: 0.76, x1: 0.90 } as const;

/** The card's interior, two strips clear of the item icons: flat, and darker than the caption. */
const INTERIOR_STRIPS = [
  { x0: 0.345, x1: 0.41, y0: 0.375, y1: 0.62 },
  { x0: 0.59, x1: 0.655, y0: 0.375, y1: 0.62 },
] as const;
const INTERIOR_MEAN_MIN = 25;
const INTERIOR_MEAN_MAX = 90;
const INTERIOR_SPREAD_MAX = 15;

/** The `获得了…` caption under the card: bright, neutral ink (measured 407 px at 1280×720). */
const CAPTION_BOX = { x0: 0.30, x1: 0.70, y0: 0.78, y1: 0.86 } as const;
const CAPTION_BRIGHT = 120;
const CAPTION_INK_MIN = 100;

/** A flat field is "nothing was drawn", not this screen (contracts §2). */
const FLAT_STD_DEV = 8;

/** The answer's confidence: above the route's 0.5 act floor, below the bar's 1.0. */
const LOOT_CONFIDENCE = 0.6;
/** Positive refusal: something is drawn and it is not this overlay. */
const UNNAMED_CONFIDENCE = 0.2;

export class LootPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    if (!isClientShape(frame.width, frame.height)) return refusal(frame, UNNAMED_CONFIDENCE);
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return refusal(frame, 0);
    }
    if (isFlat(image)) return refusal(frame, 0);
    if (!isLootOverlay(image)) return refusal(frame, UNNAMED_CONFIDENCE);
    return { screen: 'loot', atMs: frame.atMs, confidence: LOOT_CONFIDENCE };
  }
}

/** A 16:9 frame wide enough to carry the measured fractions. */
function isClientShape(width: number, height: number): boolean {
  if (width < MIN_WIDTH || height <= 0) return false;
  return Math.abs(width / height - TARGET_ASPECT) <= ASPECT_TOLERANCE;
}

function refusal(frame: Frame, confidence: number): Observation {
  return { screen: 'unknown', atMs: frame.atMs, confidence };
}

/** Mean and spread over every eighth pixel: a flat or black frame is not this screen. */
function isFlat(image: RgbaImage): boolean {
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

/** The card's two border lines and the flat field between them, then its caption. */
function isLootOverlay(image: RgbaImage): boolean {
  const top = borderLine(image, TOP_BAND);
  const bottom = borderLine(image, BOTTOM_BAND);
  if (top === null || bottom === null) return false;
  if (top.peak < BORDER_PEAK_MIN || bottom.peak < BORDER_PEAK_MIN) return false;
  if (top.gain < BORDER_GAIN_MIN || bottom.gain < BORDER_GAIN_MIN) return false;
  const cardHeight = bottom.at - top.at;
  if (cardHeight < CARD_HEIGHT_MIN || cardHeight > CARD_HEIGHT_MAX) return false;
  if (lineSpanRatio(image, top.at) < LINE_SPAN_RATIO) return false;
  if (lineSpanRatio(image, bottom.at) < LINE_SPAN_RATIO) return false;
  for (const box of INTERIOR_STRIPS) {
    const interior = strip(image, box);
    if (interior.mean < INTERIOR_MEAN_MIN || interior.mean > INTERIOR_MEAN_MAX) return false;
    if (interior.spread > INTERIOR_SPREAD_MAX) return false;
  }
  return captionInk(image) >= CAPTION_INK_MIN;
}

/** One border line: its row as a fraction of the height, its brightness, and its gain over the band's surroundings. */
interface BorderLine {
  readonly at: number;
  readonly peak: number;
  readonly gain: number;
}

/** The brightest row in `band`, and how far it stands above the rows around the band. */
function borderLine(image: RgbaImage, band: { readonly y0: number; readonly y1: number }): BorderLine | null {
  const y0 = Math.max(1, Math.round(image.height * band.y0));
  const y1 = Math.min(image.height - 2, Math.round(image.height * band.y1));
  if (y1 <= y0) return null;
  let peak = -1;
  let peakY = -1;
  for (let y = y0; y <= y1; y++) {
    const mean = rowMean(image, y, CARD_X0, CARD_X1);
    if (mean > peak) {
      peak = mean;
      peakY = y;
    }
  }
  if (peakY < 0) return null;
  const margin = Math.max(2, Math.round(image.height * BASELINE_FRACTION));
  const neighbourhood: number[] = [];
  for (let y = Math.max(0, y0 - margin); y < y0; y++) neighbourhood.push(rowMean(image, y, CARD_X0, CARD_X1));
  for (let y = y1 + 1; y <= Math.min(image.height - 1, y1 + margin); y++) neighbourhood.push(rowMean(image, y, CARD_X0, CARD_X1));
  if (neighbourhood.length === 0) return null;
  return { at: peakY / image.height, peak, gain: peak - median(neighbourhood) };
}

/** A row's mean luma across an x band, as fractions of the frame's width. */
function rowMean(image: RgbaImage, y: number, x0: number, x1: number): number {
  const row = Math.min(image.height - 1, Math.max(0, y));
  const from = Math.round(image.width * x0);
  const to = Math.round(image.width * x1);
  if (to <= from) return 0;
  let sum = 0;
  for (let x = from; x < to; x++) {
    const o = (row * image.width + x) * 4;
    sum += (image.data[o]! + image.data[o + 1]! + image.data[o + 2]!) / 3;
  }
  return sum / (to - from);
}

/** How much brighter the line's central band is than the brighter flank at the same row. */
function lineSpanRatio(image: RgbaImage, at: number): number {
  const y = Math.min(image.height - 1, Math.max(0, Math.round(image.height * at)));
  const central = rowMean(image, y, CARD_X0, CARD_X1);
  const flank = Math.max(
    rowMean(image, y, LEFT_FLANK.x0, LEFT_FLANK.x1),
    rowMean(image, y, RIGHT_FLANK.x0, RIGHT_FLANK.x1),
  );
  return central / Math.max(1, flank);
}

/** A box's mean luma and spread: the card's fill is flat, every scene behind the lid is not. */
function strip(image: RgbaImage, box: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }): { readonly mean: number; readonly spread: number } {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const x0 = Math.round(image.width * box.x0);
  const x1 = Math.round(image.width * box.x1);
  const y0 = Math.round(image.height * box.y0);
  const y1 = Math.round(image.height * box.y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      const luma = (image.data[o]! + image.data[o + 1]! + image.data[o + 2]!) / 3;
      sum += luma;
      sumSq += luma * luma;
      count += 1;
    }
  }
  if (count === 0) return { mean: 0, spread: Infinity };
  const mean = sum / count;
  return { mean, spread: Math.sqrt(Math.max(0, sumSq / count - mean * mean)) };
}

/** The caption's bright, neutral ink: the result line is white text under the card. */
function captionInk(image: RgbaImage): number {
  const x0 = Math.round(image.width * CAPTION_BOX.x0);
  const x1 = Math.round(image.width * CAPTION_BOX.x1);
  const y0 = Math.round(image.height * CAPTION_BOX.y0);
  const y1 = Math.round(image.height * CAPTION_BOX.y1);
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      if (image.data[o]! > CAPTION_BRIGHT && image.data[o + 1]! > CAPTION_BRIGHT && image.data[o + 2]! > CAPTION_BRIGHT) {
        ink += 1;
      }
    }
  }
  return ink;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
