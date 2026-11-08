/**
 * The item filter (筛选): the game's **blurred** page — a tall, narrow dialog over a depth-of-field
 * background, with the party's checkboxes, three 全部 dropdowns, the 等级 swatches, the 品质 stars and one
 * wide **OK** plate at its bottom.
 *
 * It was one of the recurring unnamed frames of the 2026-11-08 farm. It is a page with an exit, which is
 * what the \`ui-menu\` screen is for: the World's one job with it is to leave it, from a point the frame
 * itself reports.
 *
 * Its deciding feature is not the orange checkboxes (a town's lamps are orange too) and not the dialog
 * (the battle's skill panel is one). It is that **the game blurs everything behind this page** — and
 * blurs it very dark. Measured on 1920×1080 frames, two facts over the bands a centred dialog never
 * covers (x 40–560 and 1360–1880, y 100–1000):
 *
 *   | page                | luma | neighbour detail |
 *   | ------------------- | ---- | ---------------- |
 *   | the filter page     |  2.4 | 0.28             |
 *   | the town            | 31.8 | 5.92             |
 *   | the character page  | 61.7 | 4.87             |
 *   | the battle's panel  | 54.6 | 4.39             |
 *   | the 3-D view        | 69.9 | 5.71             |
 *
 * Two orders of magnitude apart on luma and fifteen times on detail, so both anchors are measurements,
 * not guesses. The exit is **located**: the widest bright horizontal run in the page's button band is
 * its OK plate.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';

/** The bands beside a centred dialog: where a blurred background shows and no page draws. */
export const SIDE_BANDS = { left: [40, 560], right: [1_360, 1_880], top: 100, bottom: 1_000, step: 4 } as const;
/** At or below this mean luma the sides are a blurred, darkened scene (measured 2.4; the next page 31.8). */
export const BLURRED_SIDES_MAX = 12;
/** At or below this neighbour-to-neighbour detail the background is out of focus (measured 0.28). */
export const BLURRED_DETAIL_MAX = 1.5;
/**
 * And at least this lit: a **black** frame also has no detail, and it is not this page — the game's
 * blank frame is \`loading\` and is named before this reader is asked. Measured: the page's sides 2.3,
 * a black frame 0.0.
 */
export const BLURRED_SIDES_MIN = 0.5;
/** The page's button band, where its OK plate is drawn (measured y 860–1040, x 700–1250). */
export const BUTTON_BAND = { top: 860, bottom: 1_040, left: 700, right: 1_250 } as const;
/** The shortest bright run that can be the OK plate. */
export const EXIT_MIN_WIDTH = 120;

function lumaAt(image: RgbaImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
}

/** What the side bands say: how dark, and how much detail, the background behind the dialog is. */
export function background(image: RgbaImage): { readonly luma: number; readonly detail: number } {
  let sum = 0;
  let edges = 0;
  let count = 0;
  for (let y = SIDE_BANDS.top; y < SIDE_BANDS.bottom; y += SIDE_BANDS.step) {
    for (const [from, to] of [SIDE_BANDS.left, SIDE_BANDS.right] as const) {
      for (let x = from; x < to; x += SIDE_BANDS.step) {
        sum += lumaAt(image, x, y);
        edges += Math.abs(lumaAt(image, x, y) - lumaAt(image, x + SIDE_BANDS.step, y));
        count += 1;
      }
    }
  }
  return count === 0 ? { luma: 0, detail: 0 } : { luma: sum / count, detail: edges / count };
}

/** The page's exit: the widest bright horizontal run in its button band. Found, never a constant. */
export function findExit(image: RgbaImage): Point | null {
  // Every row of the band whose bright run is plate-wide: the plate's own top and bottom edges are both
  // such rows, so the **median** row is the plate's middle — which is what a tap needs.
  const rows: Array<{ y: number; x0: number; x1: number; width: number }> = [];
  for (let y = BUTTON_BAND.top; y <= BUTTON_BAND.bottom; y += 2) {
    let run = 0;
    let start = 0;
    let widest = 0;
    let widestStart = 0;
    let widestEnd = 0;
    for (let x = BUTTON_BAND.left; x <= BUTTON_BAND.right; x += 2) {
      if (lumaAt(image, x, y) > 100) {
        if (run === 0) start = x;
        run += 2;
        if (run > widest) {
          widest = run;
          widestStart = start;
          widestEnd = x;
        }
      } else if (run > 0 && lumaAt(image, x, y) < 50) {
        run = 0;
      }
    }
    if (widest >= EXIT_MIN_WIDTH) rows.push({ y, x0: widestStart, x1: widestEnd, width: widest });
  }
  if (rows.length === 0) return null;
  // The page's **bottom-most** plate is its OK: the wide plates above it are the 全部 dropdowns, and a
  // live frame put one of those at 1039,950 — three presses that closed nothing (2026-11-08 22:01).
  const clusters: Array<typeof rows> = [];
  let group: typeof rows = [];
  let previous = -10;
  for (const row of rows) {
    // A plate's outline is rows of the same run interrupted by the label inside it: one cluster, and its
    // middle row is the point a tap wants (measured: the OK plate's rows 974–1024, centre y 999).
    if (row.y - previous > 60) {
      if (group.length > 0) clusters.push(group);
      group = [];
    }
    group.push(row);
    previous = row.y;
  }
  if (group.length > 0) clusters.push(group);
  const best = clusters.reduce((lowest, cluster) =>
    cluster[cluster.length - 1]!.y > lowest[lowest.length - 1]!.y ? cluster : lowest, clusters[0]!);
  // The plate's middle is the midpoint of its **outermost** rows, not the middle row of the list: the
  // list holds the plate's edges (which are the only full-width rows) and the label's rows are shorter.
  const y = Math.round((best[0]!.y + best[best.length - 1]!.y) / 2);
  const row = best.reduce((near, candidate) => (Math.abs(candidate.y - y) < Math.abs(near.y - y) ? candidate : near), best[0]!);
  return { x: Math.round((row.x0 + row.x1) / 2), y };
}

/** Names the filter page, and reports the plate that leaves it. */
export class FilterDialogPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const image = await frame.toRgba();
    const sides = background(image);
    if (sides.luma < BLURRED_SIDES_MIN
      || sides.luma > BLURRED_SIDES_MAX
      || sides.detail > BLURRED_DETAIL_MAX) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    }
    const exit = findExit(image);
    // A page whose exit was not found is not named: the World would have nothing to press.
    if (exit === null) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    // Both anchors are met; how far inside them grades the confidence.
    const darkness = 1 - sides.luma / BLURRED_SIDES_MAX;
    const flatness = 1 - sides.detail / BLURRED_DETAIL_MAX;
    const confidence = Math.min(0.99, 0.86 + 0.1 * darkness + 0.03 * flatness);
    return { screen: 'ui-menu', atMs: frame.atMs, confidence, page: 'filter', title: '筛选', exit };
  }
}
