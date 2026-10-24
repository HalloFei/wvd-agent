/**
 * Grayscale normalized cross-correlation between a frame area and one legacy template.
 *
 * The templates are the mobile art at 900×1600 (see `scripts/extract-location-templates.mjs`); the
 * PC build draws the same UI at 1080/1600 = 0.675, so each scan sweeps a small scale range. The
 * search is coarse-to-fine: the area and the scaled template are box-averaged 4×, every coarse
 * position is scored, and the three best are refined at full resolution within ±8 px. Measured
 * 2026-10-24: the world-map icon, panel chevron, 诺森霍洛村 and 北穿幽冥城 score 0.955–0.989 at
 * 0.66–0.68, and a node clipped by the map edge scores 0.555, below the 0.8 floor.
 *
 * A window whose luma variance is under 100 is never a match: flat black bars and empty panels
 * correlate with anything after normalization, which is how a template detector invents a button.
 *
 * The entry path may spend 100–300 ms here (it runs outside the 10 Hz tick). The recognisers call
 * the same function on a small band, where the coarse pass keeps them cheap.
 */
import type { PixelRect, Point, RgbaImage } from '../contracts.ts';

export interface MatchTemplate {
  readonly width: number;
  readonly height: number;
  readonly gray: Uint8Array;
}

export interface Match {
  /** The template's top-left in the frame's own device pixels. */
  readonly at: Point;
  readonly width: number;
  readonly height: number;
  /** Pearson correlation of the window and the template, in [-1, 1]. */
  readonly score: number;
  readonly scale: number;
}

export interface MatchOptions {
  readonly scales?: readonly number[];
  readonly minScore?: number;
}

/** The sweep the measurements support: 0.62–0.72 of the mobile art is the PC UI's 0.675 ± margin. */
export const DEFAULT_SCALES: readonly number[] = [0.62, 0.64, 0.66, 0.68, 0.70, 0.72];

const DEFAULT_MIN_SCORE = 0.8;
/** The coarse pass reads one pixel in 16 and refines the best few at full resolution. */
const COARSE = 4;
const COARSE_STRIDE = 2;
const REFINE_RADIUS = 8;
const CANDIDATES = 4;
const MIN_TEMPLATE = 8;
/** Below this variance the window is flat and its correlation is noise (luma units squared). */
const MIN_VARIANCE = 100;

interface Gray {
  readonly data: Float64Array;
  readonly width: number;
  readonly height: number;
}

interface TemplateStats {
  readonly mean: number;
  readonly varianceSum: number;
}

/** Find the best placement of `template` inside `area`, or null below `minScore`. */
export function findTemplate(
  image: RgbaImage,
  area: PixelRect,
  template: MatchTemplate,
  options: MatchOptions = {},
): Match | null {
  const scales = options.scales ?? DEFAULT_SCALES;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const x = Math.max(0, Math.trunc(area.x));
  const y = Math.max(0, Math.trunc(area.y));
  const width = Math.min(image.width - x, Math.trunc(area.width));
  const height = Math.min(image.height - y, Math.trunc(area.height));
  if (width < MIN_TEMPLATE || height < MIN_TEMPLATE) return null;

  const gray = lumaArea(image, x, y, width, height);
  const coarseImage = boxDown(gray, COARSE);
  let best: Match | null = null;

  for (const scale of scales) {
    const tw = Math.round(template.width * scale);
    const th = Math.round(template.height * scale);
    if (tw < MIN_TEMPLATE || th < MIN_TEMPLATE || tw >= width || th >= height) continue;
    const scaled = resize(template.gray, template.width, template.height, tw, th);
    const stats = statsOf(scaled);
    if (stats.varianceSum <= 0) continue;

    const coarseTemplate = boxDown({ data: scaled, width: tw, height: th }, COARSE);
    const coarseStats = statsOf(coarseTemplate.data);
    if (coarseStats.varianceSum <= 0) continue;

    for (const candidate of bestCandidates(coarseImage, coarseTemplate, coarseStats, tw, th)) {
      const centreX = candidate.x * COARSE;
      const centreY = candidate.y * COARSE;
      const fromX = Math.max(0, centreX - REFINE_RADIUS);
      const toX = Math.min(width - tw, centreX + REFINE_RADIUS);
      const fromY = Math.max(0, centreY - REFINE_RADIUS);
      const toY = Math.min(height - th, centreY + REFINE_RADIUS);
      // Two-stage refine: every second pixel first, then the 5×5 around that. A full 17×17 scan per
      // candidate tripled the entry's observation time for no extra precision.
      let localX = fromX;
      let localY = fromY;
      let localScore = -Infinity;
      for (let atY = fromY; atY <= toY; atY += 2) {
        for (let atX = fromX; atX <= toX; atX += 2) {
          const score = correlate(gray, atX, atY, scaled, tw, th, stats);
          if (score > localScore) {
            localScore = score;
            localX = atX;
            localY = atY;
          }
        }
      }
      for (let atY = Math.max(fromY, localY - 1); atY <= Math.min(toY, localY + 1); atY += 1) {
        for (let atX = Math.max(fromX, localX - 1); atX <= Math.min(toX, localX + 1); atX += 1) {
          const score = correlate(gray, atX, atY, scaled, tw, th, stats);
          if (score >= localScore) {
            localScore = score;
            localX = atX;
            localY = atY;
          }
        }
      }
      if (best === null || localScore > best.score) {
        best = { at: { x: x + localX, y: y + localY }, width: tw, height: th, score: localScore, scale };
      }
    }
  }

  return best !== null && best.score >= minScore ? best : null;
}

/** The RGBA frame's area as luma, Rec. 601 floored, matching the map parser's arithmetic. */
function lumaArea(image: RgbaImage, x: number, y: number, width: number, height: number): Gray {
  const data = new Float64Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const source = ((y + row) * image.width + x) * 4;
    const target = row * width;
    for (let column = 0; column < width; column += 1) {
      const offset = source + column * 4;
      data[target + column] = ((image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1000) | 0;
    }
  }
  return { data, width, height };
}

/** The mean and the sum of squared deviations of a template. */
function statsOf(data: Float64Array): TemplateStats {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) sum += data[index]!;
  const mean = sum / data.length;
  let varianceSum = 0;
  for (let index = 0; index < data.length; index += 1) {
    const delta = data[index]! - mean;
    varianceSum += delta * delta;
  }
  return { mean, varianceSum };
}

/** Pearson correlation of the window at (x,y) with the template. */
function correlate(
  image: Gray,
  x: number,
  y: number,
  template: Float64Array,
  width: number,
  height: number,
  stats: TemplateStats,
): number {
  const count = width * height;
  let sum = 0;
  let squareSum = 0;
  let cross = 0;
  for (let row = 0; row < height; row += 1) {
    const source = (y + row) * image.width + x;
    const target = row * width;
    for (let column = 0; column < width; column += 1) {
      const value = image.data[source + column]!;
      sum += value;
      squareSum += value * value;
      cross += value * template[target + column]!;
    }
  }
  const variance = squareSum - (sum * sum) / count;
  if (variance < MIN_VARIANCE || stats.varianceSum <= 0) return -1;
  return (cross - (sum * stats.mean)) / Math.sqrt(variance * stats.varianceSum);
}

interface Candidate {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/** The best coarse placements, at most `CANDIDATES`; adjacency is left to the full-resolution refine. */
function bestCandidates(image: Gray, template: Gray, stats: TemplateStats, tw: number, th: number): Candidate[] {
  const width = template.width;
  const height = template.height;
  if (image.width < width || image.height < height) return [];
  const found: Candidate[] = [];
  for (let y = 0; y + height <= image.height; y += COARSE_STRIDE) {
    for (let x = 0; x + width <= image.width; x += COARSE_STRIDE) {
      const score = correlate(image, x, y, template.data, width, height, stats);
      if (score <= 0) continue;
      // Keep the six best coarse scores, adjacent or not: a spurious patch early in the scan must
      // not suppress the real peak a few pixels away, and the full-resolution refine is cheap.
      found.push({ x, y, score });
      found.sort((left, right) => right.score - left.score);
      if (found.length > CANDIDATES) found.pop();
    }
  }
  return found;
}

/** Downsample by an integer factor, averaging each block. */
function boxDown(image: Gray, factor: number): Gray {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Float64Array(width * height);
  const divisor = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let row = 0; row < factor; row += 1) {
        const source = (y * factor + row) * image.width + x * factor;
        for (let column = 0; column < factor; column += 1) sum += image.data[source + column]!;
      }
      data[y * width + x] = sum / divisor;
    }
  }
  return { data, width, height };
}

/** Bilinear resize of a grayscale template. */
function resize(source: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Float64Array {
  const target = new Float64Array(width * height);
  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const top = Math.floor(sourceY);
    const bottom = Math.min(sourceHeight - 1, top + 1);
    const weightY = sourceY - top;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const left = Math.floor(sourceX);
      const right = Math.min(sourceWidth - 1, left + 1);
      const weightX = sourceX - left;
      const upper = source[top * sourceWidth + left]! * (1 - weightX) + source[top * sourceWidth + right]! * weightX;
      const lower = source[bottom * sourceWidth + left]! * (1 - weightX) + source[bottom * sourceWidth + right]! * weightX;
      target[y * width + x] = upper * (1 - weightY) + lower * weightY;
    }
  }
  return target;
}
