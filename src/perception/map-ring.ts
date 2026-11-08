/**
 * The white ring: the game's own "this icon is clickable" signal.
 *
 * Operator, 2026-11-09: *must be on the icon; when on the icon or clickable state, there will appear
 * to be a white circle around the icon* — at levels 1 and 2, never at 0. So a tap is sent only after
 * the ring is read from the frame, which turns "the projection said this is the node" into "the game
 * says this is a button". That is the same rule the rest of the project uses: verification by action,
 * with the evidence taken from the frame that the action will land on.
 */
import type { Point, RgbaImage } from '../contracts.ts';

/** The ring's radius range, client pixels. Provisional until a live frame is measured. */
export const RING_RADIUS = { min: 14, max: 34 } as const;
/** What counts as the ring's ink. */
export const RING_LUMA = 200;
/** How much brighter the ring must be than the icon's interior to be a ring and not a lit disc. */
export const RING_CONTRAST = 40;

function lumaAt(image: RgbaImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
}

export interface RingReading {
  readonly radius: number;
  /** Mean luma on the ring. */
  readonly ringLuma: number;
  /** Mean luma inside it, at half the radius. */
  readonly innerLuma: number;
  /** The pair's confidence: how far above the interior the ring sits, scaled to 0..1. */
  readonly confidence: number;
}

/**
 * The ring around `at`, or null when there is none.
 *
 * The test is an annulus against its own interior: a lit **disc** (parchment, a mountain, a building)
 * has an interior as bright as its edge and is not a ring; the game's ring is bright ink on the icon's
 * own dark disc.
 */
export function whiteRing(image: RgbaImage, at: Point, options: {
  readonly radiusMin?: number;
  readonly radiusMax?: number;
  readonly ringLuma?: number;
  readonly contrast?: number;
} = {}): RingReading | null {
  const min = options.radiusMin ?? RING_RADIUS.min;
  const max = options.radiusMax ?? RING_RADIUS.max;
  const floor = options.ringLuma ?? RING_LUMA;
  const contrast = options.contrast ?? RING_CONTRAST;
  let best: RingReading | null = null;
  for (let radius = min; radius <= max; radius += 1) {
    // 24 points around the circle: enough for a ring, cheap enough for the tick.
    let ringSum = 0;
    let innerSum = 0;
    const innerRadius = Math.max(2, Math.round(radius * 0.55));
    for (let step = 0; step < 24; step += 1) {
      const angle = (step / 24) * Math.PI * 2;
      ringSum += lumaAt(image, Math.round(at.x + Math.cos(angle) * radius), Math.round(at.y + Math.sin(angle) * radius));
      innerSum += lumaAt(image, Math.round(at.x + Math.cos(angle) * innerRadius), Math.round(at.y + Math.sin(angle) * innerRadius));
    }
    const ringLuma = ringSum / 24;
    const innerLuma = innerSum / 24;
    if (ringLuma < floor || ringLuma - innerLuma < contrast) continue;
    const confidence = Math.min(1, (ringLuma - innerLuma) / 160);
    if (best === null || confidence > best.confidence) best = { radius, ringLuma, innerLuma, confidence };
  }
  return best;
}

/** Whether the frame shows the icon as clickable. */
export function isClickable(image: RgbaImage, at: Point): boolean {
  return whiteRing(image, at) !== null;
}
