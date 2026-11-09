/**
 * The world map, localised by **registration** instead of by templates.
 *
 * This is the LKMapTools / Game-Map-Tracker shape without the feature detector
 * (https://github.com/HCskia/LKMapTools, https://github.com/761696148/Game-Map-Tracker): the view's
 * pose is the placement of the live strip inside the stored atlas image, found by normalised
 * cross-correlation on a coarse-to-fine pyramid, refined locally around a prior when the caller has
 * one, and the **zoom level is a hypothesis that is scored**, not a press count. The atlas is the
 * stitched map (testdata/worldmap/2026-11-01/overview-full.jpg, generated into
 * worldmap-atlas-image.ts), read as one image rather than as a bank of banners and icons.
 *
 * Why not a corner detector: the map never rotates, the zoom ladder is known and discrete (4
 * levels, 1.34x per step) and the atlas is a painting, so the 4-DOF similarity LKMapTools fits is
 * a **2-DOF** problem here — translation, with the scale snapped to the ladder. The whole atlas is
 * only 1.4x the strip wide, so even the exhaustive translation search is small.
 *
 * Geometry. A strip coordinate s (after subtracting MAP_STRIP.x) shows atlas point
 *   a = q + C + (s - C) / f,      C = (MAP_STRIP.width/2, MAP_STRIP.height/2),  f = 1.34^level
 * where q is the atlas offset of the view at max zoom-out — the same quantity `placementAt` and
 * the atlas pan loop speak. A pose is (q, level); the strip's own top-left sits on the atlas at
 * P = q + C(1 - 1/f), which is why the probe is simply the strip resampled at f * pixelsPerCell
 * screen px per cell, and the search is where that probe lands on the atlas.
 */
import type { RgbaImage } from '../contracts.ts';
import { MAP_STRIP, MAP_ZOOM, zoomFactor } from './worldmap-atlas.ts';
import { WORLD_MAP_ATLAS_IMAGE } from './worldmap-atlas-image.ts';

/** The stored atlas, as the generated module writes it. */
export interface AtlasImageData {
  /** The atlas size in atlas pixels. */
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  /** Stored pixels per atlas pixel. */
  readonly pixelsPerCell: number;
  readonly width: number;
  readonly height: number;
  /** width*height 8-bit luma, row-major. */
  readonly gray: Uint8Array;
}

/** One downsampled copy of the atlas: `step` stored pixels per cell. */
export interface AtlasLayer {
  readonly step: number;
  /** Cell size in atlas pixels. */
  readonly cellPx: number;
  readonly width: number;
  readonly height: number;
  readonly data: Float64Array;
}

/** The atlas plus its pyramid, built once per session. */
export interface LocaliserAtlas {
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly pixelsPerCell: number;
  readonly storedWidth: number;
  readonly storedHeight: number;
  /** Coarsest first. */
  readonly layers: readonly AtlasLayer[];
}

/** Where the strip's content sits on the atlas, and at which zoom it was taken. */
export interface Pose {
  /**
   * The atlas point the strip's top-left corner shows, in atlas pixels. The whole projective model
   * is then `screen = factor * (atlas - origin)`, with no centre term: at max zoom-out it equals
   * the atlas's own `offset`, and at any other level it is the single number the pan and the
   * confirmation need.
   */
  readonly origin: { readonly x: number; readonly y: number };
  /** The zoom level the strip shows (0 = max zoom-out). */
  readonly level: number;
  /** The measured zoom factor of that level (ZOOM_LADDER), not the 1.34^k the atlas used. */
  readonly factor: number;
  /** Normalised cross-correlation of the winning placement, [-1, 1]. */
  readonly score: number;
  /** The winning layer's cell size, in atlas pixels. */
  readonly cellPx: number;
}

export interface LocaliseOptions {
  /** A prior pose: the search starts at its level, inside `windowPx`. */
  readonly prior?: { readonly offset: { readonly x: number; readonly y: number }; readonly level: number };
  /** Atlas pixels around the prior to search, when a prior is given. Default 320. */
  readonly windowPx?: number;
  /** The levels to score. Default: all of them, or the prior's level when there is a prior. */
  readonly levels?: readonly number[];
  /** The score below which no pose is reported. Default 0.5. */
  readonly minScore?: number;
  /** An exact scale factor to test instead of the ladder. Used by the tests to scan the ratio. */
  readonly factor?: number;
  /**
   * Whether to refine the winning factor around its ladder entry (±4%, five probes). Default true:
   * the recorded frames sit 1-4% off their entry, which is tens of pixels at the map's edge.
   */
  readonly refineScale?: boolean;
}

/** The pyramid halves the stored atlas three times: 2, 4 and 8 stored px per cell (16 atlas px at the top). */
const DOUBLINGS = [2, 4, 8] as const;
/** Coarse placements refined per level (a false peak must not hide the real one). */
const CANDIDATES = 3;
/** Cells searched around a placement when the pyramid goes one level finer. */
const REFINE_RADIUS = 2;

const CENTRE = { x: MAP_STRIP.width / 2, y: MAP_STRIP.height / 2 } as const;

/** Build the atlas pyramid. Once per session (~20 ms), never per frame. */
export function createAtlas(image: AtlasImageData): LocaliserAtlas {
  const stored = new Float64Array(image.width * image.height);
  for (let index = 0; index < stored.length; index += 1) stored[index] = image.gray[index] ?? 0;
  let layer: AtlasLayer = {
    step: 1,
    cellPx: image.pixelsPerCell,
    width: image.width,
    height: image.height,
    data: stored,
  };
  const layers: AtlasLayer[] = [layer];
  for (const step of DOUBLINGS) {
    layer = { ...boxDown(layer), step, cellPx: image.pixelsPerCell * step };
    layers.push(layer);
  }
  layers.reverse();
  return {
    atlasWidth: image.atlasWidth,
    atlasHeight: image.atlasHeight,
    pixelsPerCell: image.pixelsPerCell,
    storedWidth: image.width,
    storedHeight: image.height,
    layers,
  };
}

let cached: LocaliserAtlas | null = null;

/** The committed atlas, built on first use and kept for the session. */
export function worldMapAtlas(): LocaliserAtlas {
  if (cached === null) {
    cached = createAtlas({
      ...WORLD_MAP_ATLAS_IMAGE,
      gray: Uint8Array.from(Buffer.from(WORLD_MAP_ATLAS_IMAGE.gray, 'base64')),
    });
  }
  return cached;
}

/** The strip as a probe: the screen content resampled into atlas space, stored resolution. */
interface Probe {
  readonly width: number;
  readonly height: number;
  readonly data: Float64Array;
  readonly mean: number;
  /** Sum of squared deviations from the mean. */
  readonly variance: number;
}

/** Localise one live frame (1920x1080). Null when no level scores at least `minScore`. */
export function localiseView(image: RgbaImage, atlas: LocaliserAtlas, options: LocaliseOptions = {}): Pose | null {
  const minScore = options.minScore ?? 0.5;
  const prior = options.prior;
  const levels = options.levels
    ?? (prior === undefined ? [0, 1, 2, 3].filter((level) => level <= MAP_ZOOM.steps) : [prior.level]);
  const windowPx = options.windowPx ?? 320;

  /** Place the probe made at `f` on the atlas, under the prior's window when the level matches. */
  const attempt = (level: number, f: number): { origin: { x: number; y: number }; score: number } | null => {
    const probe = probeAtLevel(image, atlas, f);
    if (probe === null) return null;
    const coarse = atlas.layers[0]!;
    const shifted = { x: CENTRE.x * (1 - 1 / f), y: CENTRE.y * (1 - 1 / f) };
    const seeds = prior === undefined || prior.level !== level
      ? searchLayer(probe, coarse, null)
      : searchLayer(probe, coarse, {
        x: (prior.offset.x + shifted.x) / coarse.cellPx,
        y: (prior.offset.y + shifted.y) / coarse.cellPx,
        radiusPx: windowPx / coarse.cellPx,
      });
    let found: { origin: { x: number; y: number }; score: number } | null = null;
    for (const seed of seeds.slice(0, CANDIDATES)) {
      const refined = refine(probe, atlas, seed);
      if (refined !== null && (found === null || refined.score > found.score)) found = refined;
    }
    return found;
  };

  let winner: { level: number; factor: number; origin: { x: number; y: number }; score: number } | null = null;
  for (const level of levels) {
    const factor = options.factor ?? zoomFactor(level);
    const placed = attempt(level, factor);
    if (placed !== null && (winner === null || placed.score > winner.score)) winner = { level, factor, ...placed };
  }
  if (winner === null) return null;

  // The ladder entry is a hypothesis, the way LKMapTools' 4-DOF fit estimates its scale: probe a
  // few factors around the winner and keep the one that correlates best. The recorded frames sit
  // 1-4% off their ladder entry, which is tens of pixels at the map's edge.
  if (options.factor === undefined && options.refineScale !== false) {
    const base = winner;
    let refined = base;
    for (const percent of [96, 98, 102, 104]) {
      const candidate: number = Math.round(base.factor * percent) / 100;
      const placed = attempt(base.level, candidate);
      if (placed !== null && placed.score > refined.score) refined = { level: base.level, factor: candidate, ...placed };
    }
    winner = refined;
  }

  if (winner.score < minScore) return null;
  return {
    origin: {
      x: Math.round(atlas.pixelsPerCell * winner.origin.x),
      y: Math.round(atlas.pixelsPerCell * winner.origin.y),
    },
    level: winner.level,
    factor: winner.factor,
    score: winner.score,
    cellPx: atlas.pixelsPerCell,
  };
}

/**
 * The strip resampled into atlas space: probe cell (i,j) is the screen pixel
 * (i * f * ppc, j * f * ppc), and its atlas point is P + (i,j) * ppc. Null when the strip is too
 * small to be a map.
 */
function probeAtLevel(image: RgbaImage, atlas: LocaliserAtlas, f: number): Probe | null {
  const ppc = atlas.pixelsPerCell;
  const cellPx = f * ppc;
  const width = Math.floor(MAP_STRIP.width / cellPx);
  const height = Math.floor(MAP_STRIP.height / cellPx);
  if (width < 16 || height < 16) return null;
  const data = new Float64Array(width * height);
  let sum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = lumaAt(image, MAP_STRIP.x + (x + 0.5) * cellPx, (y + 0.5) * cellPx);
      data[y * width + x] = value;
      sum += value;
    }
  }
  const count = width * height;
  const mean = sum / count;
  let variance = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = data[index]! - mean;
    variance += delta * delta;
  }
  return { width, height, data, mean, variance };
}

/** Bilinear luma at a screen point (clamped). */
function lumaAt(image: RgbaImage, x: number, y: number): number {
  const px = Math.max(0, Math.min(image.width - 1, x - 0.5));
  const py = Math.max(0, Math.min(image.height - 1, y - 0.5));
  const left = Math.floor(px);
  const top = Math.floor(py);
  const right = Math.min(image.width - 1, left + 1);
  const bottom = Math.min(image.height - 1, top + 1);
  const wx = px - left;
  const wy = py - top;
  const at = (column: number, row: number): number => {
    const offset = (row * image.width + column) * 4;
    return (image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1000;
  };
  const upper = at(left, top) * (1 - wx) + at(right, top) * wx;
  const lower = at(left, bottom) * (1 - wx) + at(right, bottom) * wx;
  return upper * (1 - wy) + lower * wy;
}

/** Downsample a probe or layer 2x, averaging each block. */
function boxDown(source: { width: number; height: number; data: Float64Array }): {
  width: number;
  height: number;
  data: Float64Array;
} {
  const width = Math.floor(source.width / 2);
  const height = Math.floor(source.height / 2);
  const data = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = (
        source.data[2 * y * source.width + 2 * x]!
        + source.data[2 * y * source.width + 2 * x + 1]!
        + source.data[(2 * y + 1) * source.width + 2 * x]!
        + source.data[(2 * y + 1) * source.width + 2 * x + 1]!
      ) / 4;
    }
  }
  return { width, height, data };
}

interface Search {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/**
 * Score the probe at every placement on a layer (or inside a window), best first. The probe is
 * box-downsampled to the layer's cell size, so both grids are compared at the same resolution.
 */
function searchLayer(
  probe: Probe,
  layer: AtlasLayer,
  window: { x: number; y: number; radiusPx: number } | null,
): Search[] {
  let cells: { width: number; height: number; data: Float64Array } = probe;
  for (let step = layer.step; step > 1; step = Math.floor(step / 2)) {
    if (cells.width / 2 < 8 || cells.height / 2 < 8) break;
    cells = boxDown(cells);
  }
  if (cells.width > layer.width || cells.height > layer.height) return [];
  const stats = statsOf(cells);
  const fromX = window === null ? 0 : Math.max(0, Math.round(window.x - window.radiusPx));
  const toX = window === null ? layer.width - cells.width : Math.min(layer.width - cells.width, Math.round(window.x + window.radiusPx));
  const fromY = window === null ? 0 : Math.max(0, Math.round(window.y - window.radiusPx));
  const toY = window === null ? layer.height - cells.height : Math.min(layer.height - cells.height, Math.round(window.y + window.radiusPx));
  const found: Search[] = [];
  for (let y = fromY; y <= toY; y += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      const score = correlate(layer.data, layer.width, x, y, cells, stats);
      if (found.length < CANDIDATES) {
        found.push({ x, y, score });
        found.sort((left, right) => right.score - left.score);
      } else if (score > found[found.length - 1]!.score) {
        found[found.length - 1] = { x, y, score };
        found.sort((left, right) => right.score - left.score);
      }
    }
  }
  return found;
}

/** Box-down a probe by `step` (a power of two), or null when it becomes too small to match. */
function boxDownTo(
  source: { width: number; height: number; data: Float64Array },
  step: number,
): { width: number; height: number; data: Float64Array } | null {
  let cells: { width: number; height: number; data: Float64Array } = source;
  for (let at = step; at > 1; at = Math.floor(at / 2)) {
    if (cells.width < 16 || cells.height < 16) return null;
    cells = boxDown(cells);
  }
  return cells;
}

/** Walk the pyramid from a coarse placement to the finest, searching a small window each step. */
function refine(probe: Probe, atlas: LocaliserAtlas, seed: Search): { origin: { x: number; y: number }; score: number } | null {
  let origin = { x: seed.x, y: seed.y };
  let previous = atlas.layers[0]!.step;
  let score = seed.score;
  for (let index = 1; index < atlas.layers.length; index += 1) {
    const layer = atlas.layers[index]!;
    const cells = boxDownTo(probe, layer.step);
    if (cells === null) return null;
    const stats = statsOf(cells);
    const ratio = previous / layer.step;
    const base = { x: Math.round(origin.x * ratio), y: Math.round(origin.y * ratio) };
    let found: Search | null = null;
    for (let dy = -REFINE_RADIUS; dy <= REFINE_RADIUS; dy += 1) {
      for (let dx = -REFINE_RADIUS; dx <= REFINE_RADIUS; dx += 1) {
        const x = base.x + dx;
        const y = base.y + dy;
        if (x < 0 || y < 0 || x + cells.width > layer.width || y + cells.height > layer.height) continue;
        const candidate = correlate(layer.data, layer.width, x, y, cells, stats);
        if (found === null || candidate > found.score) found = { x, y, score: candidate };
      }
    }
    if (found === null) return null;
    origin = { x: found.x, y: found.y };
    score = found.score;
    previous = layer.step;
  }
  return { origin, score };
}

interface Stats {
  readonly mean: number;
  readonly variance: number;
}

function statsOf(cells: { data: Float64Array; width: number; height: number }): Stats {
  const count = cells.width * cells.height;
  let sum = 0;
  for (let index = 0; index < count; index += 1) sum += cells.data[index]!;
  const mean = sum / count;
  let variance = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = cells.data[index]! - mean;
    variance += delta * delta;
  }
  return { mean, variance };
}

/** Pearson correlation of the cells at (x,y) with the probe cells. */
function correlate(
  atlas: Float64Array,
  atlasWidth: number,
  x: number,
  y: number,
  cells: { data: Float64Array; width: number; height: number },
  stats: Stats,
): number {
  const { width, height } = cells;
  let sum = 0;
  let squareSum = 0;
  let cross = 0;
  for (let row = 0; row < height; row += 1) {
    const source = (y + row) * atlasWidth + x;
    const target = row * width;
    for (let column = 0; column < width; column += 1) {
      const value = atlas[source + column]!;
      sum += value;
      squareSum += value * value;
      cross += value * cells.data[target + column]!;
    }
  }
  const count = width * height;
  const variance = squareSum - (sum * sum) / count;
  if (variance < 100 || stats.variance <= 0) return -1;
  return (cross - (sum * stats.mean)) / Math.sqrt(variance * stats.variance);
}
