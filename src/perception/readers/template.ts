/**
 * The numerals reader's template tier: today's digit atlases, matched as glyph features.
 *
 * **It takes its templates as an input and never imports the opener** (plan ruling R1). The opener's
 * atlases are private, codec-sensitive means of recorded glyphs; the factory hands them through as
 * `DigitTemplate`s, and this tier only knows the geometry they were recorded in.
 *
 * The atlas contract, therefore, is more than "a digit and 80 numbers":
 *
 * - each glyph is cropped to its ink rows, scaled by its own peak, centred in a 10 x 14 cell and
 *   bilinearly resized to **8 x 10**, then mean-subtracted and unit-normalised for NCC (the opener's
 *   feature, 2026-10-31);
 * - the ink rule is the opener's measured one: a pixel is ink when its luma is at least
 *   `INK_LUMA_DELTA` above the region's median luma, and the region's median is the background the
 *   cell is normalised against;
 * - a digit may occur several times (an atlas of observed instances, e.g. the heart's), so scores are
 *   grouped by digit before the runner-up margin is taken: the runner-up is the best **other** digit,
 *   never another instance of the winner.
 *
 * That coupling is why this tier is the one the spec calls codec-sensitive: a capture-pipeline change
 * invalidates the atlases, and the tier's answer is the atlas's answer. The seam hedges it by order —
 * `rule` first, then this tier, then OCR.
 */
import type { RgbaImage } from '../../contracts.ts';
import {
  readCoverage,
  withinHint,
  type Numerals,
  type NumeralsReader,
  type ReadHint,
  type Region,
} from './contract.ts';

/** One digit's normalised glyph feature. See the module header for the geometry it must be in. */
export interface DigitTemplate {
  /** The digit this template names, one character of `0`–`9`. */
  readonly digit: string;
  /** `TEMPLATE_FEATURE_WIDTH * TEMPLATE_FEATURE_HEIGHT` values, mean-subtracted and unit-norm. */
  readonly values: Float64Array;
}

export interface TemplateReaderOptions {
  /** The atlas. Several entries may share a digit (observed instances, not just its mean). */
  readonly templates: ReadonlyArray<DigitTemplate>;
  /** The minimum NCC a glyph must reach for its best digit. Default `TEMPLATE_MATCH_FLOOR`. */
  readonly matchFloor?: number;
  /** The minimum NCC lead the best digit must have over the runner-up. Default `TEMPLATE_MARGIN_FLOOR`. */
  readonly marginFloor?: number;
}

/** The feature's shape. The atlases are recorded in it; a template of another size is a bug. */
export const TEMPLATE_FEATURE_WIDTH = 8;
export const TEMPLATE_FEATURE_HEIGHT = 10;
export const TEMPLATE_FEATURE_SIZE = TEMPLATE_FEATURE_WIDTH * TEMPLATE_FEATURE_HEIGHT;

/** The opener's wide floor for a complete mean atlas (lowest true score 0.921, margin 0.133). */
export const TEMPLATE_MATCH_FLOOR = 0.7;
export const TEMPLATE_MARGIN_FLOOR = 0.1;

/** The cell the glyph is centred in before the feature resize (the opener's measured cell). */
const GLYPH_CELL_WIDTH = 10;
const GLYPH_CELL_HEIGHT = 14;
/** The opener's measured ink rule: on a dark fill the numerals are >= 55 luma above it. */
const INK_LUMA_DELTA = 55;
/** The opener's measured glyph geometry: 3 columns is the narrowest digit, 12 the widest. */
const MIN_GLYPH_COLUMNS = 3;
const MAX_GLYPH_COLUMNS = 12;
const DIGIT_PITCH = 9.4;
/** The widest field the seam's `hint.digits` can name. More runs is noise, not a number. */
const MAX_GLYPH_DIGITS = 3;

/**
 * A reader over one atlas. A template that is not one digit with an 8 x 10 feature is a **caller's
 * bug**, not a runtime refusal, so the constructor throws instead of silently disabling the tier
 * (which would quietly push every field onto OCR). `read` itself never throws.
 */
export function createTemplateReader(options: TemplateReaderOptions): NumeralsReader {
  for (const template of options.templates) {
    if (!/^[0-9]$/.test(template.digit)) {
      throw new TypeError(`a template's digit must be one character of 0-9, not "${template.digit}"`);
    }
    if (template.values.length !== TEMPLATE_FEATURE_SIZE) {
      throw new TypeError(
        `digit ${template.digit} carries ${template.values.length} values, not the ${TEMPLATE_FEATURE_SIZE} of a ${TEMPLATE_FEATURE_WIDTH} x ${TEMPLATE_FEATURE_HEIGHT} feature`,
      );
    }
  }
  const templates = options.templates.slice();
  return {
    read: (image, region, hint) => readNumeralsViaTemplates(image, region, hint, {
      templates,
      matchFloor: options.matchFloor,
      marginFloor: options.marginFloor,
    }),
  };
}

/**
 * The number `region` carries under `options.templates`, or null: no templates, the region (or the
 * hint's label) is not wholly inside the frame, no glyph can be segmented, a glyph's best digit is
 * below the match floor or too close to the runner-up, or the answer contradicts the hint's expected
 * length or sanity bounds. Only `region` is matched; the label is OCR's context (see `rule.ts`).
 */
export async function readNumeralsViaTemplates(
  image: RgbaImage,
  region: Region,
  hint: ReadHint | undefined,
  options: TemplateReaderOptions,
): Promise<Numerals | null> {
  const templates = options.templates;
  if (templates.length === 0) return null;
  if (readCoverage(image, region, hint) === null) return null;
  const background = medianLuma(image, region);
  const ink = (x: number, y: number): boolean => pixelLuma(image, x, y) - background >= INK_LUMA_DELTA;
  const atoms = glyphAtoms(columnRuns(image, region, ink));
  if (atoms.length === 0 || atoms.length > MAX_GLYPH_DIGITS) return null;
  const matchFloor = options.matchFloor ?? TEMPLATE_MATCH_FLOOR;
  const marginFloor = options.marginFloor ?? TEMPLATE_MARGIN_FLOOR;
  let text = '';
  let worst = Number.POSITIVE_INFINITY;
  for (const [from, to] of atoms) {
    const feature = glyphFeature(image, region, from, to, ink, background);
    if (feature === null) return null;
    const byDigit = new Map<string, number>();
    for (const template of templates) {
      let score = 0;
      for (let index = 0; index < feature.length; index += 1) score += feature[index]! * template.values[index]!;
      if (score > (byDigit.get(template.digit) ?? -2)) byDigit.set(template.digit, score);
    }
    let best: string | null = null;
    let bestScore = -2;
    let secondScore = -2;
    for (const [digit, score] of byDigit) {
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = digit;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    // Never a guess: an unreadable or ambiguous digit refuses the whole read.
    if (best === null || bestScore < matchFloor || bestScore - secondScore < marginFloor) return null;
    text += best;
    if (bestScore < worst) worst = bestScore;
  }
  if (hint?.digits !== undefined && text.length !== hint.digits) return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  if (!withinHint(value, hint)) return null;
  return { value, confidence: Math.max(0, Math.min(1, worst)), tier: 'template' };
}

/**
 * The 8 x 10 normalised feature of the **one** glyph `region` carries, or null when it carries none
 * or more than one.
 *
 * Exported because recording an atlas is the caller's job under R1, and this is the geometry the
 * tier matches in: a caller that records templates from pixels (a synthetic atlas, a new capture)
 * builds them here rather than re-deriving the cell and the resize. The opener's own atlases are
 * recorded with the same geometry and handed in directly.
 */
export function templateFeatureOf(image: RgbaImage, region: Region): Float64Array | null {
  if (readCoverage(image, region) === null) return null;
  const background = medianLuma(image, region);
  const ink = (x: number, y: number): boolean => pixelLuma(image, x, y) - background >= INK_LUMA_DELTA;
  const atoms = glyphAtoms(columnRuns(image, region, ink));
  if (atoms.length !== 1) return null;
  const [from, to] = atoms[0]!;
  return glyphFeature(image, region, from, to, ink, background);
}

/** Rec. 601 luma — the opener's arithmetic: the luma the atlases were recorded in. */
function pixelLuma(image: RgbaImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (77 * image.data[offset]! + 150 * image.data[offset + 1]! + 29 * image.data[offset + 2]!) >> 8;
}

/** The band's median luma: the fill under the numerals, robust to the numerals themselves. */
function medianLuma(image: RgbaImage, region: Region): number {
  const values = new Float64Array(region.width * region.height);
  let index = 0;
  for (let y = 0; y < region.height; y += 1) {
    for (let x = 0; x < region.width; x += 1) values[index++] = pixelLuma(image, region.x + x, region.y + y);
  }
  values.sort();
  return values[values.length >> 1]!;
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

/**
 * One atom's normalised 8 x 10 feature, or null when the atom carries no ink rows. This is the
 * opener's `glyphFeature` (opener.ts) reproduced in the tier, because the atlases are means of
 * features computed exactly this way: the ink rows cropped, scaled by the glyph's own peak, centred
 * in a 10 x 14 cell, bilinearly resized to 8 x 10, mean-subtracted and unit-normalised.
 */
function glyphFeature(
  image: RgbaImage,
  region: Region,
  from: number,
  to: number,
  ink: (x: number, y: number) => boolean,
  background: number,
): Float64Array | null {
  let top = -1;
  let bottom = -1;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    let any = false;
    for (let x = from; x <= to; x += 1) {
      if (ink(x, y)) {
        any = true;
        break;
      }
    }
    if (any) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;

  const glyphWidth = to - from + 1;
  const glyphHeight = bottom - top + 1;
  const cell = new Float64Array(GLYPH_CELL_WIDTH * GLYPH_CELL_HEIGHT);
  let peak = 1;
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const value = pixelLuma(image, from + x, top + y) - background;
      if (value > peak) peak = value;
    }
  }
  const offsetX = Math.floor((GLYPH_CELL_WIDTH - glyphWidth) / 2);
  const offsetY = Math.floor((GLYPH_CELL_HEIGHT - glyphHeight) / 2);
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const cellX = offsetX + x;
      const cellY = offsetY + y;
      if (cellX < 0 || cellX >= GLYPH_CELL_WIDTH || cellY < 0 || cellY >= GLYPH_CELL_HEIGHT) continue;
      cell[cellY * GLYPH_CELL_WIDTH + cellX] = Math.max(0, pixelLuma(image, from + x, top + y) - background) / peak;
    }
  }

  const feature = new Float64Array(TEMPLATE_FEATURE_WIDTH * TEMPLATE_FEATURE_HEIGHT);
  for (let ty = 0; ty < TEMPLATE_FEATURE_HEIGHT; ty += 1) {
    const sy = ((ty + 0.5) * GLYPH_CELL_HEIGHT) / TEMPLATE_FEATURE_HEIGHT - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const ya = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0));
    const yb = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0 + 1));
    for (let tx = 0; tx < TEMPLATE_FEATURE_WIDTH; tx += 1) {
      const sx = ((tx + 0.5) * GLYPH_CELL_WIDTH) / TEMPLATE_FEATURE_WIDTH - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const xa = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0));
      const xb = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0 + 1));
      const upper = cell[ya * GLYPH_CELL_WIDTH + xa]! * (1 - fx) + cell[ya * GLYPH_CELL_WIDTH + xb]! * fx;
      const lower = cell[yb * GLYPH_CELL_WIDTH + xa]! * (1 - fx) + cell[yb * GLYPH_CELL_WIDTH + xb]! * fx;
      feature[ty * TEMPLATE_FEATURE_WIDTH + tx] = upper * (1 - fy) + lower * fy;
    }
  }

  let mean = 0;
  for (const value of feature) mean += value;
  mean /= feature.length;
  let normSq = 0;
  for (let index = 0; index < feature.length; index += 1) {
    feature[index] = feature[index]! - mean;
    normSq += feature[index]! * feature[index]!;
  }
  const norm = Math.sqrt(normSq);
  if (!(norm > 0)) return null;
  for (let index = 0; index < feature.length; index += 1) feature[index]! /= norm;
  return feature;
}
