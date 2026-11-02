/**
 * The harken's floor menu: the teleport list a harken offers when the party reaches it.
 *
 * Measured 2026-11-03 on `testdata/screens/2026-11-03-harken-menu/harken-2f.jpg` (1600×900; the
 * fractions below are the same at the World's 1920×1080 client): a centred list of rows, labels on
 * x ≈ 0.5, rows 0.0667 of the height apart — 第一区-城外-, 第二区-城内1F-, 第四区-城内2F深处-, 归还 —
 * followed by the 加护 block.
 *
 * **The list is not fixed** (operator rule 2026-11-03): a harken offers a destination only once that
 * floor's harken has been reconstructed, so a new harken may draw nothing but 归还. The reader
 * therefore *finds* the rows instead of assuming them, and *reads* each row's label against the
 * measured library (`harken-library.ts`): a label it has never seen is `null`, never the closest
 * guess.
 *
 * The climb uses it as the operator described: the farm floor's row is offered → tap it; only 归还 →
 * tap that to back out, and take the stair icon on the map to the next floor on foot.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';
import { HARKEN_ROW_LABELS } from './harken-library.ts';
import { lumaAt, StripLibraryReader } from './reader.ts';

/** The label band: x 0.43..0.57 of the width, and a row's half-height around its text line. */
const LABEL_BAND = { x0: 0.43, x1: 0.57 } as const;
const ROW_HALF_HEIGHT = 0.013;
/** A row's text line: bright ink, and this tall — a line is 10–25 px at 1080. */
const INK_LUMA = 170;
const MIN_INK_PX = 3;
const LINE_MIN_HEIGHT = 0.008;
const LINE_MAX_HEIGHT = 0.035;
/** The band the rows live in vertically: the dialog is centred, the 加护 block sits below it. */
const ROWS_TOP = 0.35;
const ROWS_BOTTOM = 0.85;
/** The label match floor: an exact match is 1.0, an unseen row is null. */
const LABEL_FLOOR = 0.82;

/** One row of the menu: where its label sits, the label the library knows, and the match's score. */
export interface HarkenRow {
  readonly at: Point;
  readonly label: string | null;
  readonly score: number;
}

/** The rows found, top to bottom. */
export interface HarkenMenu {
  readonly rows: readonly HarkenRow[];
}

/** Finds the harken floor menu on the frame, or null when no row carries a label from the library. */
export function findHarkenMenu(image: RgbaImage): HarkenMenu | null {
  const lines = textLines(image);
  if (lines.length === 0) return null;
  const found: HarkenRow[] = lines.map((line) => {
    const centreY = (line.y0 + line.y1) / 2 / image.height;
    const region = {
      x0: LABEL_BAND.x0,
      y0: centreY - ROW_HALF_HEIGHT,
      x1: LABEL_BAND.x1,
      y1: centreY + ROW_HALF_HEIGHT,
    };
    const reader = new StripLibraryReader('harken-row', region, HARKEN_ROW_LABELS, LABEL_FLOOR);
    const answer = reader.read(image);
    return {
      at: { x: Math.round(image.width / 2), y: Math.round((line.y0 + line.y1) / 2) },
      label: answer === null ? null : answer.value.label,
      score: answer === null ? 0 : answer.value.score,
    };
  });
  // Only the rows the library can name are reported: an unnamed row is a destination the climb cannot
  // choose, and the dialogue's own separators are lines too (measured 2026-11-03: the four menu rows
  // answer 第一区-城外- / 第二区-城内1F- / 第四区-城内2F深处- / 归还 at 1.00, and the lines between them
  // match nothing). A menu with no named row is not this screen.
  const rows = found.filter((row) => row.label !== null);
  if (rows.length === 0) return null;
  return { rows };
}

/** The menu's text lines in the central band: bright ink runs, a line's own height bounds applied. */
function textLines(image: RgbaImage): { y0: number; y1: number }[] {
  const x0 = Math.round(image.width * LABEL_BAND.x0);
  const x1 = Math.round(image.width * LABEL_BAND.x1);
  const top = Math.round(image.height * ROWS_TOP);
  const bottom = Math.round(image.height * ROWS_BOTTOM);
  const lines: { y0: number; y1: number }[] = [];
  let start: number | null = null;
  for (let y = top; y <= bottom; y += 1) {
    let ink = 0;
    for (let x = x0; x < x1; x += 1) {
      if (lumaAt(image, x, y) > INK_LUMA) ink += 1;
    }
    if (ink >= MIN_INK_PX && start === null) start = y;
    if (ink < MIN_INK_PX && start !== null) {
      const height = (y - start) / image.height;
      if (height >= LINE_MIN_HEIGHT && height <= LINE_MAX_HEIGHT) lines.push({ y0: start, y1: y - 1 });
      start = null;
    }
  }
  return lines;
}

/** Names the harken's floor menu; unknown when no row's label is in the library. */
export class HarkenMenuPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    const menu = findHarkenMenu(image);
    if (menu === null) return unknown;
    const confidence = Math.max(...menu.rows.map((row) => row.score));
    return { screen: 'harken-menu', atMs: frame.atMs, confidence, rows: menu.rows.map((row) => ({ at: row.at, label: row.label })) };
  }
}
