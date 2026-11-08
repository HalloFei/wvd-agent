/**
 * The pointer, read from the frame.
 *
 * The game draws its own cursor into the captured pixels, so the cursor is perception, not a system
 * fact: nothing here asks Windows where the mouse is — the frame says where the arrow is drawn, which
 * is the same picture the game is reacting to (operator, 2026-11-09: *we need a module to move and
 * capture cursor*).
 *
 * Why it matters: WASD drives that cursor, and a cursor held **at the map's edge** pushes the
 * perspective at a constant speed. So the map has three inputs — edge-push (constant speed, coarse),
 * the pointer drag (a path, smoothed by the game), and close/reopen (a reset) — and only the first two
 * need to know where the arrow is.
 *
 * The arrow is the frame's brightest small thing: near-white ink, compact, a few dozen pixels. UI text
 * is also bright, so the reader requires the bright cluster to be **compact** (the arrow's own size)
 * and refuses a frame where the cluster is part of a large white area.
 */
import type { Point, RgbaImage } from '../contracts.ts';

/**
 * Near-white: the cursor is drawn in pure white, and the map's own bright art (labels, banners) stops
 * just short of it. Measured on a live world-map frame (2026-11-09): bright cells at luma 240 = **17**
 * (the labels join the arrow), at 250 = 10, at 252 = 8, at 254 = 6 (the arrow alone). 252 is where the
 * cursor is separable from the map — the first cut's 242 refused the arrow on every map frame.
 */
export const POINTER_LUMA = 252;
/** The cell grid the bright pixels are counted in (client pixels). */
export const POINTER_CELL = 8;
/** A 3×3 cell cluster must carry at least this many bright pixels to be the arrow. */
export const POINTER_MIN_INK = 24;
/** The arrow is compact: a cluster wider than this is a panel, a label or a highlight. */
export const POINTER_MAX_SPAN = 72;
/** How many bright cells the whole frame may hold: the arrow's ~6, a panel's dozens. */
export const POINTER_MAX_CELLS = 12;

export interface PointerReading {
  /** The arrow's tip, client pixels. */
  readonly at: Point;
  /** Bright pixels in the cluster the reading came from. */
  readonly ink: number;
  readonly confidence: number;
}

function lumaAt(image: RgbaImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
}

/**
 * The pointer this frame draws, or null. One frame in, one answer: the caller re-reads after every
 * hold, so a lost cursor is a fact of that frame rather than a remembered state.
 */
export function readPointer(image: RgbaImage): PointerReading | null {
  const columns = Math.floor(image.width / POINTER_CELL);
  const rows = Math.floor(image.height / POINTER_CELL);
  if (columns < 3 || rows < 3) return null;
  const counts = new Uint16Array(columns * rows);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (lumaAt(image, x, y) < POINTER_LUMA) continue;
      counts[Math.floor(y / POINTER_CELL) * columns + Math.floor(x / POINTER_CELL)] += 1;
    }
  }
  // The arrow is the frame's *only* bright thing of that size. A white panel draws dozens of bright
  // cells; a frame with that much bright ink is ambiguous, and a wrong pointer position is worse than
  // no reading (the caller then re-reads rather than steering blind).
  let brightCells = 0;
  for (const cellInk of counts) if (cellInk >= 4) brightCells += 1;
  if (brightCells > POINTER_MAX_CELLS) return null;
  let best = { row: -1, column: -1, ink: 0 };
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      let ink = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) ink += counts[(row + dy) * columns + column + dx]!;
      }
      if (ink > best.ink) best = { row, column, ink };
    }
  }
  if (best.ink < POINTER_MIN_INK) return null;
  // The cluster's own span: a bright panel or a label run is wide, the arrow is not.
  const left = (best.column - 1) * POINTER_CELL;
  const top = (best.row - 1) * POINTER_CELL;
  const right = (best.column + 2) * POINTER_CELL;
  const bottom = (best.row + 2) * POINTER_CELL;
  let minX = right;
  let maxX = left;
  let minY = bottom;
  let maxY = top;
  let sumX = 0;
  let sumY = 0;
  let ink = 0;
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y += 1) {
    for (let x = Math.max(0, left); x < Math.min(image.width, right); x += 1) {
      if (lumaAt(image, x, y) < POINTER_LUMA) continue;
      ink += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (ink < POINTER_MIN_INK) return null;
  if (maxX - minX > POINTER_MAX_SPAN || maxY - minY > POINTER_MAX_SPAN) return null;
  // The centroid, not the bounding box's middle: the arrow's mass is at its body.
  return {
    at: { x: Math.round(sumX / ink), y: Math.round(sumY / ink) },
    ink,
    confidence: Math.min(1, ink / (POINTER_MIN_INK * 3)),
  };
}

/** Where the pointer is, or null when this frame does not draw it. */
export function pointerAt(image: RgbaImage): Point | null {
  return readPointer(image)?.at ?? null;
}
