/**
 * The numerals reader's rule tier: the game's numeral font read from the **shape** of its glyphs.
 *
 * `number.ts` classifies a digit from what every numeral carries — holes, bars, and where the ink
 * sits — so this tier needs no data and no committed atlas. Its job is only to hand that reader
 * glyphs: segment the region into column runs, cut each run into one glyph, and refuse the read when
 * the strip cannot be segmented. A number the rules cannot name is `null`, never a guess.
 *
 * The segmentation constants are the opener's measured ones (opener.ts, 2026-10-31/11-07): the
 * narrowest digit is three columns and the widest twelve, two digits whose JPEG halo closed the gap
 * split at a 9.4 px pitch, and a card carries at most three digits. They live here rather than in
 * `number.ts` because a glyph reader must not know how a frame's ink is found.
 *
 * The read covers the contract's `region ∪ hint.label` for the **containment** check — a crop that
 * would clip is a refusal, like every tier. It segments only `region`: the label is context for the
 * OCR tier, and swallowing its CJK glyphs would make every labelled field refuse before the fast
 * tiers could answer.
 */
import type { RgbaImage } from '../../contracts.ts';
import { readInteger, type GlyphMask } from '../number.ts';
import {
  readCoverage,
  withinHint,
  type Numerals,
  type NumeralsReader,
  type ReadHint,
  type Region,
} from './contract.ts';

/**
 * What a rule read is worth. The rules are categorical — a glyph is placed in a shape class — so
 * there is no correlation score to report; this is the tier's own claim, like `OCR_CONFIDENCE`, not
 * a measurement. A caller that needs certainty keeps its own floors; the health metric is the
 * reported `tier`.
 */
export const RULE_CONFIDENCE = 0.8;

/** Below this luma span the band is flat (a fill, not numerals): nothing to segment. */
const MIN_CONTRAST = 24;
/** Three lit columns is a digit, not a halo: the narrowest glyph is a `1`'s stem. */
const MIN_GLYPH_COLUMNS = 3;
/** A run wider than this is two digits whose gap closed; it is split at the measured pitch. */
const MAX_GLYPH_COLUMNS = 12;
const DIGIT_PITCH = 9.4;
/** The widest field the seam's `hint.digits` can name. More runs is noise, not a number. */
const MAX_GLYPH_DIGITS = 3;

/** The tier as the seam sees it: `read` is the whole contract. */
export const ruleReader: NumeralsReader = { read: readNumeralsViaRules };

/**
 * The number the game's numeral font spells in `region`, or null: the region (or the hint's label)
 * is not wholly inside the frame, the band is flat, the glyph segmentation is empty or too wide for a
 * field, any glyph cannot be named by the shape rules, or the answer contradicts the hint's expected
 * length or sanity bounds.
 */
export async function readNumeralsViaRules(
  image: RgbaImage,
  region: Region,
  hint?: ReadHint,
): Promise<Numerals | null> {
  if (readCoverage(image, region, hint) === null) return null;
  const band = lumaHistogram(image, region);
  if (band.max - band.min < MIN_CONTRAST) return null;
  const threshold = otsuThreshold(band);
  if (threshold === null) return null;
  const atoms = glyphAtoms(columnRuns(image, region, (x, y) => pixelLuma(image, x, y) > threshold));
  if (atoms.length === 0 || atoms.length > MAX_GLYPH_DIGITS) return null;
  const glyphs = atoms.map(([from, to]) => glyphMask(image, region, from, to, threshold));
  const read = readInteger(glyphs);
  if (read === null) return null;
  if (hint?.digits !== undefined && read.digits.length !== hint.digits) return null;
  if (!withinHint(read.value, hint)) return null;
  return { value: read.value, confidence: RULE_CONFIDENCE, tier: 'rule' };
}

/** Rec. 601 luma, the opener's arithmetic: the luma the numeral atlases were measured in. */
function pixelLuma(image: RgbaImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (77 * image.data[offset]! + 150 * image.data[offset + 1]! + 29 * image.data[offset + 2]!) >> 8;
}

interface BandHistogram {
  /** 256 bins of luma; the tier's threshold is chosen from these. */
  readonly counts: Uint32Array;
  readonly total: number;
  readonly min: number;
  readonly max: number;
}

function lumaHistogram(image: RgbaImage, region: Region): BandHistogram {
  const counts = new Uint32Array(256);
  let total = 0;
  let min = 255;
  let max = 0;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      const luma = pixelLuma(image, region.x + x, region.y + y);
      counts[luma]! += 1;
      total += 1;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
    }
  }
  return { counts, total, min, max };
}

/**
 * Otsu's split: the luma level whose two classes are furthest apart in mean, weighted by their size.
 * The numeral is the **bright** class (the game draws white/yellow numerals on a dark fill), so ink
 * is `luma > level`. Null when the band has one class only — nothing to read.
 */
function otsuThreshold(band: BandHistogram): number | null {
  let sum = 0;
  for (let level = 0; level < 256; level += 1) sum += level * band.counts[level]!;
  let belowWeight = 0;
  let belowSum = 0;
  let best: number | null = null;
  let bestVariance = 0;
  for (let level = 0; level < 255; level += 1) {
    belowWeight += band.counts[level]!;
    belowSum += level * band.counts[level]!;
    const aboveWeight = band.total - belowWeight;
    if (belowWeight === 0 || aboveWeight === 0) continue;
    const belowMean = belowSum / belowWeight;
    const aboveMean = (sum - belowSum) / aboveWeight;
    const variance = belowWeight * aboveWeight * (belowMean - aboveMean) ** 2;
    // Strictly greater keeps the first level of a plateau: the first split that separates the classes.
    if (variance > bestVariance) {
      bestVariance = variance;
      best = level;
    }
  }
  return bestVariance > 0 ? best : null;
}

/** Maximal runs of columns that carry ink. */
function columnRuns(
  image: RgbaImage,
  region: Region,
  ink: (x: number, y: number) => boolean,
): Array<readonly [number, number]> {
  const lit = new Uint16Array(region.width);
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) {
      if (ink(region.x + x, region.y + y)) lit[x]! += 1;
    }
  }
  const runs: Array<readonly [number, number]> = [];
  let start = -1;
  for (let column = 0; column <= region.width; column += 1) {
    const on = column < region.width && lit[column]! > 0;
    if (on && start < 0) start = column;
    else if (!on && start >= 0) {
      runs.push([region.x + start, region.x + column - 1] as const);
      start = -1;
    }
  }
  return runs;
}

/** Filter slivers and split a run that is two digits wide, at the measured pitch. */
function glyphAtoms(runs: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const atoms: Array<readonly [number, number]> = [];
  for (const [from, to] of runs) {
    const width = to - from + 1;
    if (width < MIN_GLYPH_COLUMNS) continue;
    if (width <= MAX_GLYPH_COLUMNS) {
      atoms.push([from, to] as const);
      continue;
    }
    const count = Math.max(2, Math.round(width / DIGIT_PITCH));
    for (let k = 0; k < count; k += 1) {
      atoms.push([
        from + Math.round((k * width) / count),
        from + Math.round(((k + 1) * width) / count) - 1,
      ] as const);
    }
  }
  return atoms;
}

/** One atom's binarised glyph; `number.ts` crops the band's empty rows itself. */
function glyphMask(image: RgbaImage, region: Region, from: number, to: number, threshold: number): GlyphMask {
  const width = to - from + 1;
  const ink: boolean[] = [];
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      ink.push(pixelLuma(image, from + x, region.y + y) > threshold);
    }
  }
  return { width, height: region.height, ink };
}
