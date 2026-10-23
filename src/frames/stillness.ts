/**
 * Scene stillness: the loop's arrival evidence (contracts §8.3 `automoveStillSeconds`).
 *
 * Why this exists. A walk command's own effect is the map closing, so a *screen* change cannot be
 * the answer to "has the party arrived" — the screen changed the moment the key worked. Arrival is a
 * fact about the *scene*: the party has stopped moving. This module turns a frame into a cheap
 * signature and answers whether two signatures show the same standing scene.
 *
 * Two measured facts and one chosen threshold:
 *
 * - A frame is sampled on a grid, not read whole. A 1920×1080 frame is 2 M pixels, ~85 ms for a
 *   full pass (`research-map-parser.md` §1; contracts §0.7 is a 50 ms half-tick); sampling every
 *   16th pixel on both axes is 8 160 reads and enough to tell a moving camera from a standing party.
 * - The stopped party in `testdata/nav-1024-0213/` differed by **1.3 %** between frames 2.5 s apart —
 *   particle flicker, not movement (navigation design §3a). A walking camera moves most of the
 *   frame, so the gap either side is wide.
 * - `STILL_FRACTION = 0.03` is the **chosen** boundary between them: above the 1.3 % measured
 *   flicker, far below a walking scene. It is not a measured fact and is named as a choice here.
 *
 * Dimensions come from the image (contracts §0.5), never from a constant: another size is sampled
 * on its own grid, and two signatures of different shapes are simply not the same scene.
 */
import type { RgbaImage } from '../contracts.ts';

/** Every 16th pixel on both axes: ~8 200 samples at 1080p. */
const SAMPLE_STRIDE = 16;
/** A sample counts as moved when its luma differs by more than this; JPEG noise is smaller. */
const MOVED_LUMA = 12;
/**
 * The scene is still when fewer than 3 % of the samples moved. Chosen from the 1.3 % flicker
 * measurement and the fact that a walking camera moves most of the frame — see the header.
 */
export const STILL_FRACTION = 0.03;

/** What one frame showed, on a grid: enough to compare scenes, nothing that identifies a screen. */
export interface SceneSignature {
  readonly luma: Uint8Array;
  readonly columns: number;
  readonly rows: number;
}

/** A frame's scene signature: Rec. 601 luma on the sampling grid, from the image's own dimensions. */
export function sceneSignature(image: RgbaImage): SceneSignature {
  const columns = Math.max(1, Math.ceil(image.width / SAMPLE_STRIDE));
  const rows = Math.max(1, Math.ceil(image.height / SAMPLE_STRIDE));
  const luma = new Uint8Array(columns * rows);
  const { data, width } = image;
  let cell = 0;
  for (let row = 0; row < rows; row += 1) {
    const y = Math.min(row * SAMPLE_STRIDE, image.height - 1);
    for (let column = 0; column < columns; column += 1) {
      const x = Math.min(column * SAMPLE_STRIDE, image.width - 1);
      const offset = (y * width + x) * 4;
      // A malformed image (shorter than its declared size) reads as black rather than throwing:
      // this is a stillness measure, and a missing pixel is not evidence of motion.
      luma[cell++] = offset + 2 < data.length
        ? ((data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000) | 0
        : 0;
    }
  }
  return { luma, columns, rows };
}

/** The fraction of sampled cells that moved between two signatures, in [0, 1]. */
export function movedFraction(previous: SceneSignature, next: SceneSignature): number {
  if (previous.columns !== next.columns || previous.rows !== next.rows) return 1;
  const cells = previous.luma.length;
  if (cells === 0) return 1;
  let moved = 0;
  for (let index = 0; index < cells; index += 1) {
    const delta = previous.luma[index]! - next.luma[index]!;
    if (delta > MOVED_LUMA || delta < -MOVED_LUMA) moved += 1;
  }
  return moved / cells;
}

/** Is the scene standing still? Two signatures less than `STILL_FRACTION` apart say yes. */
export function sceneIsStill(previous: SceneSignature, next: SceneSignature): boolean {
  return movedFraction(previous, next) < STILL_FRACTION;
}
