/**
 * The inn's **rest scene**: the party has taken the room and the game plays the rest — a blurred inn
 * interior, the caption 一行人用旅店准备的热水擦拭了身体后，躺在坚硬的床铺上。 and the bottom bar
 * (AUTO / ▶ / 自动选择) with the yellow continue mark. One tap on the mark advances it to the
 * after-rest box.
 *
 * Measured 2026-11-07 on the run's own escalation frame
 * (`testdata/screens/2026-11-07-inn-rest/rest-scene-1280.jpeg`) against the opening frames and the
 * rest of the corpus:
 *
 * | screen            | blur (480x270 grid) | caption share | yellow mark share |
 * | ---               | ---                 | ---           | ---               |
 * | inn rest scene    | **2.6**             | **0.034**     | **0.0030**        |
 * | chest opening x8  | 17.5-18.8           | 0.000-0.110   | 0                 |
 * | message box       | 2.0                 | 0.000         | 0                 |
 * | item detail       | 3.6                 | 0.008         | 0                 |
 * | records menu      | 5.9                 | 0.007         | 0                 |
 * | loot banner / card| 12.5 / 13.1         | 0.014 / 0.018 | 0.0013 / 0.003    |
 * | 3-D view          | 18.1                | 0.070         | 0                 |
 *
 * **The dominant separator is blur.** The rest scene is the only full-screen moment the game defocuses
 * end to end: its mean edge energy is 2.3, a 4x margin below the nearest chest opening (9.0), while
 * every other screen that is blurred (the message box, the item detail panel, the records menu) has
 * neither the caption nor the yellow mark. The three gates together are therefore read as one fact —
 * a defocused screen carrying a caption line and the continue mark — and the mark's own centroid is the
 * tap point, so the advance follows the game's drawing rather than a constant.
 *
 * Why it exists: without it the chest-opening perceiver named this scene `chest-opening` 0.60 (blurred
 * inn = no HUD text, warm interior = the warm chest mass it gates on), the rest gate never saw the
 * visit, waited its full 90 s, called the cycle unrested, and the scene then blocked the next cycle's
 * orientation for 45 s until the stall stopped the run (live 2026-11-07 00:44-00:46).
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';
const REFERENCE_ASPECT = 16 / 9;
const ASPECT_TOLERANCE = 0.02;
const MIN_WIDTH = 640;

/**
 * The blur grid: every frame is sampled into this fixed 480x270 luma grid before the Laplacian, so the
 * score is the same at 1280 and 1920 (the rest scene's own still is a 1280 escalation snapshot).
 */
const BLUR_GRID = { width: 480, height: 270 } as const;

/**
 * The blur gate: mean |Laplacian| on the grid. Measured 2026-11-07 (grid scores): the rest scene **2.6**,
 * the eight chest openings **17.5-18.8**, the loot banner and card 12.5 / 13.1, the records menu 5.9, the
 * item detail 3.6, the message box 2.0. 8.0 sits between the rest scene and every sharp screen; the two
 * gates that follow tell the rest scene from the other blurred ones (the message box carries neither a
 * caption nor a mark, and the panels' captions are a quarter of the rest scene's).
 */
export const REST_BLUR_MAX = 8;

/** The caption band and its bright, neutral ink, as a share of the band's area. */
const CAPTION_BOX = { x0: 0.30, x1: 0.70, y0: 0.78, y1: 0.86 } as const;
const CAPTION_BRIGHT = 120;
/** Measured: rest scene 0.034, records 0.0074, item detail 0.0076, message 0.0000. */
export const REST_CAPTION_SHARE = 0.02;

/**
 * The veto that keeps this recogniser off the **Dungeon Select** page: it draws a large white **title**
 * (the dungeon's name, with 「Dungeon Select」 under it) across the upper band, and the rest scene draws
 * nothing there — it is a dark, blurred room.
 *
 * Operator, 2026-11-09: *the biggest decider is this title; all dungeon floor selection holds a title of
 * the current dungeon, plus two stable options, 入口 + 打开世界地图*. Measured on the corpus (share of
 * bright ink, luma > 150, in x 0.30-0.70, y 0.15-0.70): the rest scene **0.0156**, the inn's confirmation
 * page 0.0122, the inn's room list **0.0600**, the world map 0.1299. A page with a dungeon title sits far
 * above the rest scene, so 0.03 separates them with 2x margin on the one rest fixture there is.
 */
export const REST_TITLE_INK_MAX = 0.03;

/** The yellow continue mark under the caption, as a share of the band's area; its centroid is the tap. */
const MARK_BOX = { x0: 0.55, x1: 0.70, y0: 0.90, y1: 0.97 } as const;
/** Measured: rest scene 0.0030; the loot banner 0.0013 (and sharp), the battle 0.0010 (and sharp). */
export const REST_MARK_SHARE = 0.002;

/** Busy but not the rest scene; above every act floor, below the named answer. */
const UNNAMED_CONFIDENCE = 0.2;
/** The answer: three independent facts, decisive, still below the bar's 1.0. */
const REST_CONFIDENCE = 0.75;

export class InnRestPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    if (!isClientShape(frame.width, frame.height)) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: UNNAMED_CONFIDENCE };
    }
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    }
    if (blurScore(image) > REST_BLUR_MAX) return unknown(frame);
    if (titleInk(image) > REST_TITLE_INK_MAX) return unknown(frame);
    if (captionShare(image) < REST_CAPTION_SHARE) return unknown(frame);
    const mark = markCentre(image);
    if (mark === null) return unknown(frame);
    return { screen: 'inn-rest', atMs: frame.atMs, confidence: REST_CONFIDENCE, at: mark };
  }
}

function unknown(frame: Frame): Observation {
  return { screen: 'unknown', atMs: frame.atMs, confidence: UNNAMED_CONFIDENCE };
}

/** A 16:9 frame wide enough to carry the measured fractions (contracts §0.5). */
function isClientShape(width: number, height: number): boolean {
  if (width < MIN_WIDTH || height <= 0) return false;
  return Math.abs(width / height - REFERENCE_ASPECT) <= ASPECT_TOLERANCE;
}

/**
 * Mean |Laplacian| luma over the fixed grid: how much edge the frame carries. The rest scene is the
 * game's only end-to-end defocus, and this is the number that says so.
 */
export function blurScore(image: RgbaImage): number {
  const grid = new Float64Array(BLUR_GRID.width * BLUR_GRID.height);
  for (let gy = 0; gy < BLUR_GRID.height; gy += 1) {
    const sy = Math.min(image.height - 1, Math.floor(((gy + 0.5) / BLUR_GRID.height) * image.height));
    for (let gx = 0; gx < BLUR_GRID.width; gx += 1) {
      const sx = Math.min(image.width - 1, Math.floor(((gx + 0.5) / BLUR_GRID.width) * image.width));
      const o = (sy * image.width + sx) * 4;
      grid[gy * BLUR_GRID.width + gx] = (image.data[o]! * 299 + image.data[o + 1]! * 587 + image.data[o + 2]! * 114) / 1000;
    }
  }
  const w = BLUR_GRID.width;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < BLUR_GRID.height - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      sum += Math.abs(4 * grid[i]! - grid[i - 1]! - grid[i + 1]! - grid[i - w]! - grid[i + w]!);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Bright ink in the upper band: the Dungeon Select page's **white title** lives there, and the rest scene
 * has no text at all above its caption (operator, 2026-11-09: the dungeon's title is the biggest decider).
 */
export function titleInk(image: RgbaImage): number {
  const x0 = Math.round(image.width * 0.30);
  const x1 = Math.round(image.width * 0.70);
  const y0 = Math.round(image.height * 0.15);
  const y1 = Math.round(image.height * 0.70);
  let ink = 0;
  let area = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const o = (y * image.width + x) * 4;
      if (image.data[o]! > 150 && image.data[o + 1]! > 150 && image.data[o + 2]! > 150) ink += 1;
      area += 1;
    }
  }
  return area === 0 ? 0 : ink / area;
}

/** Bright, neutral ink in the caption band, as a share of that band's area. */
export function captionShare(image: RgbaImage): number {
  const x0 = Math.round(image.width * CAPTION_BOX.x0);
  const x1 = Math.round(image.width * CAPTION_BOX.x1);
  const y0 = Math.round(image.height * CAPTION_BOX.y0);
  const y1 = Math.round(image.height * CAPTION_BOX.y1);
  let ink = 0;
  let area = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      area += 1;
      const o = (y * image.width + x) * 4;
      if (image.data[o]! > CAPTION_BRIGHT && image.data[o + 1]! > CAPTION_BRIGHT && image.data[o + 2]! > CAPTION_BRIGHT) ink += 1;
    }
  }
  return area === 0 ? 0 : ink / area;
}

/** The yellow continue mark's centroid, or null when it is not drawn. */
function markCentre(image: RgbaImage): Point | null {
  const x0 = Math.round(image.width * MARK_BOX.x0);
  const x1 = Math.round(image.width * MARK_BOX.x1);
  const y0 = Math.round(image.height * MARK_BOX.y0);
  const y1 = Math.round(image.height * MARK_BOX.y1);
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let area = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      area += 1;
      const o = (y * image.width + x) * 4;
      const r = image.data[o]!;
      const g = image.data[o + 1]!;
      const b = image.data[o + 2]!;
      if (r > 150 && g > 110 && b < 90 && r - b > 80) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }
  if (area === 0 || count / area < REST_MARK_SHARE) return null;
  return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
}
