/**
 * The `drop-item-claim` screen: the chest's loot result — the brown contents card with its item icons,
 * the `获得了…` caption under it, and the small AUTO label at the frame's bottom left (the operator's
 * name for the screen, 2026-11-03; it was `loot` before).
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
import { DROP_ITEMS } from './drops.ts';
import { correlation, sampleRegion } from './reader.ts';

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

/**
 * The result banner's own gates, re-measured 2026-11-06 on the currency reward that stalled the 02:57
 * and 03:13 runs (`testdata/screens/2026-11-06-loot-currency/`). The old AUTO-box gate refused it: the
 * opened chest's glow lights the floor the box sits on, so it measured 6.3 % over luma 40 against a
 * 2.5 % bound, and the composite named the banner `chest-opening` 0.60 for 1 091 ticks.
 *
 * | fact | the drop screens | the nearest other frame |
 * | --- | --- | --- |
 * | caption ink, band x 0.30-0.70, y 0.78-0.86 | 395-1 232 | 1 964 (the dungeon map), 4 025+ (a battle) |
 * | caption rows carrying ink | 13-20 | 35 (the battle's slot panel) |
 * | caption x width | 0.130-0.166 | 0.181 (选项), 0.198 (the slot panel) |
 * | yellow continue mark, x 0.55-0.70, y 0.90-0.97 | 23-68 | 10 (one popup), 0 on every other frame |
 *
 * The mark is the claim's own affordance — the operator's rule is that a tap anywhere claims the drop,
 * and this is what the screen draws to say so — so a caption line above it is a drop. The battle's
 * `slot-panel-opening` is the frame this must not take: its ink (950) sits inside the band and its
 * width (0.198) nearly does; its 35 ink rows and its absent mark keep it out.
 */
const BANNER_CAPTION_INK_MIN = 150;
const BANNER_CAPTION_INK_MAX = 1_600;
const BANNER_CAPTION_ROWS_MAX = 24;
const CONTINUE_MARK_MIN = 20;
const CONTINUE_BOX = { x0: 0.55, x1: 0.70, y0: 0.90, y1: 0.97 } as const;

/**
 * How well a recorded drop's caption must match: the same currency answers 1.000 and 0.9999 on the
 * two banners and 0.996 on the older book frame, the nearest *different* drop 0.594 (rusty old coin),
 * and an unrelated screen at most 0.026. 0.8 sits between them with room on both sides.
 */
const DROP_NAME_FLOOR = 0.8;

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
    if (!isLootOverlay(image) && !isResultBanner(image)) return refusal(frame, UNNAMED_CONFIDENCE);
    // The drop's own name, when its caption was recorded: the World logs it, so an unfamiliar drop
    // still leaves a name in the run's record instead of an anonymous claim.
    const item = dropName(image);
    return {
      screen: 'drop-item-claim',
      atMs: frame.atMs,
      confidence: LOOT_CONFIDENCE,
      ...(item === null ? {} : { item }),
    };
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

/**
 * The contents card's frame: the two border lines, their gain, and the height between them. The card
 * gate below adds the interior and the caption; the banner gate needs the *absence* of this frame (the
 * card is already collected there).
 */
function hasCardFrame(image: RgbaImage): boolean {
  const top = borderLine(image, TOP_BAND);
  const bottom = borderLine(image, BOTTOM_BAND);
  if (top === null || bottom === null) return false;
  if (top.peak < BORDER_PEAK_MIN || bottom.peak < BORDER_PEAK_MIN) return false;
  if (top.gain < BORDER_GAIN_MIN || bottom.gain < BORDER_GAIN_MIN) return false;
  const cardHeight = bottom.at - top.at;
  if (cardHeight < CARD_HEIGHT_MIN || cardHeight > CARD_HEIGHT_MAX) return false;
  return lineSpanRatio(image, top.at) >= LINE_SPAN_RATIO && lineSpanRatio(image, bottom.at) >= LINE_SPAN_RATIO;
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
  // The operator's rule (2026-11-03): **a qualified loot frame carries the loot item's name AND its
  // image.** The name is the caption below the card; the image is the item's own art, drawn lit in the
  // middle of the card. The name alone was not enough: the battle's skill **detail panel** (关闭 / 队列
  // over the party panel) passes the border, interior and caption gates and was named `loot` live at
  // 03:17 — the loop then tapped the loot card's point ten times into the battle.
  //
  // The art is measured as **bright pixels in the card's centre**, not as colour: the second live loot
  // frame (2026-11-03 04:05, a grey book worth 10 000 拜恩纸币) has almost no saturation. Measured over
  // the centre box (0.45,0.44)-(0.55,0.56 of the frame), pixels over luma 120:
  //
  // | frame | centre bright px |
  // | --- | --- |
  // | the grey book (`2026-11-03-loot-book/loot-book.jpg`) | **4 069** |
  // | the gold goblet (`loot-00.jpg`) | **2 829** |
  // | the skill detail panel | 151 |
  // | a battle command phase | 238 |
  //
  // Floor 1 200. A dedicated loot-item database (the operator's plan) will replace this with a real
  // item-image match; until it exists, the name + image pair is the qualification.
  if (itemArtPixels(image) < ITEM_ART_MIN) return false;
  return captionInk(image) >= CAPTION_INK_MIN;
}

/** The loot item's art at the card's centre, as fractions of the frame (the card's 16:9 rule). */
const ITEM_ART_BOX = { x0: 0.45, y0: 0.44, x1: 0.55, y1: 0.56 } as const;
/** Luma above which a pixel is the lit item art rather than the card's dark fill. */
const ITEM_ART_LUMA = 120;
/** The floor the recorded frames support: the two loot frames 4 069 and 2 829, the rest at most 238. */
const ITEM_ART_MIN = 1_200;

/** Bright pixels at the card's centre: the loot item's own image. */
function itemArtPixels(image: RgbaImage): number {
  const x0 = Math.round(image.width * ITEM_ART_BOX.x0);
  const x1 = Math.round(image.width * ITEM_ART_BOX.x1);
  const y0 = Math.round(image.height * ITEM_ART_BOX.y0);
  const y1 = Math.round(image.height * ITEM_ART_BOX.y1);
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      const luma = (image.data[o]! * 299 + image.data[o + 1]! * 587 + image.data[o + 2]! * 114) / 1000;
      if (luma > ITEM_ART_LUMA) count += 1;
    }
  }
  return count;
}

/**
 * The result banner: the same `获得了…` caption, but the contents card's UI is gone and the opened
 * chest is 3-D art behind the text — one caption line over the yellow continue mark.
 *
 * Without this branch the composite named the banner `chest-opening` 0.60, the route waited, and the
 * farm stood on a screen that needs exactly one tap anywhere on the reward (operator, 2026-11-06).
 */
function isResultBanner(image: RgbaImage): boolean {
  // The card is *collected* on this screen, so its frame must be gone. Without this the battle's skill
  // detail panel - which draws a card-like border pair and a bright line of text - qualified as the
  // banner (live 2026-11-03 03:17: the loop tapped the loot card's point ten times into the battle).
  if (hasCardFrame(image)) return false;
  const line = captionLine(image);
  if (line.ink < BANNER_CAPTION_INK_MIN || line.ink > BANNER_CAPTION_INK_MAX) return false;
  if (line.rows > BANNER_CAPTION_ROWS_MAX) return false;
  return continueMark(image) >= CONTINUE_MARK_MIN;
}

/** The caption line's ink, its x width and the rows that carry any of it. */
function captionLine(image: RgbaImage): { readonly ink: number; readonly width: number; readonly rows: number } {
  const x0 = Math.round(image.width * CAPTION_BOX.x0);
  const x1 = Math.round(image.width * CAPTION_BOX.x1);
  const y0 = Math.round(image.height * CAPTION_BOX.y0);
  const y1 = Math.round(image.height * CAPTION_BOX.y1);
  const rowInk = new Uint32Array(Math.max(1, y1 - y0));
  let ink = 0;
  let minX = image.width;
  let maxX = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      if (image.data[o]! > CAPTION_BRIGHT && image.data[o + 1]! > CAPTION_BRIGHT && image.data[o + 2]! > CAPTION_BRIGHT) {
        ink += 1;
        rowInk[y - y0] += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  let rows = 0;
  for (const count of rowInk) if (count >= 3) rows += 1;
  return { ink, width: maxX < 0 ? 0 : (maxX - minX + 1) / image.width, rows };
}

/** The yellow continue mark under the caption: the claim's own affordance (operator, 2026-11-06). */
function continueMark(image: RgbaImage): number {
  const x0 = Math.round(image.width * CONTINUE_BOX.x0);
  const x1 = Math.round(image.width * CONTINUE_BOX.x1);
  const y0 = Math.round(image.height * CONTINUE_BOX.y0);
  const y1 = Math.round(image.height * CONTINUE_BOX.y1);
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const o = (y * image.width + x) * 4;
      const r = image.data[o]!;
      const g = image.data[o + 1]!;
      const b = image.data[o + 2]!;
      if (r > 150 && g > 110 && b < 90 && r - b > 80) count += 1;
    }
  }
  return count;
}

/**
 * The drop's own name, when the caption matches a recorded one; null when it does not.
 *
 * The floor is measured on the committed frames: the same currency on two banners answers 1.000 and
 * 0.9999, the same currency on the older book frame 0.996, the nearest *different* drop 0.594
 * (`loot-00`, 锈迹斑斑的古钱), and an unrelated screen at most 0.026. 0.8 sits between them.
 */
function dropName(image: RgbaImage): string | null {
  let best: { readonly item: string; readonly score: number } | null = null;
  for (const entry of DROP_ITEMS) {
    const sample = sampleRegion(image, entry.region, entry.width, entry.height);
    const score = correlation(sample, entry);
    if (best === null || score > best.score) best = { item: entry.item, score };
  }
  return best !== null && best.score >= DROP_NAME_FLOOR ? best.item : null;
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
