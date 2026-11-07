/**
 * The cheap facts one frame offers about its own screen.
 *
 * Five measurements, each the smallest rect that answers its question, taken once per frame so that
 * every perceiver reads the same numbers instead of re-deriving them: the minimap's arrow, the
 * centred title band's ink, the ink in the two battle-button windows, and the town's shop band.
 * They are geometry of the 1920×1080 client (contracts §0.5): another size carries none of them,
 * and a recogniser that needs its own rects refuses that frame on its own.
 *
 * The meaning of each fact — which screens it supports and which it makes impossible — is
 * `screens.ts`'s table, not this module's.
 */
import type { RgbaImage } from '../contracts.ts';
import { MINIMAP_ARROW_MIN, minimapArrowInk } from './minimap.ts';
import { TITLE_BAR_INK_MIN, titleBarInk } from './map.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** Centre of the 倍速 button and of the 自动 button, client pixels (measured on the live game). */
export const SPEED_BUTTON = { x: 691, y: 708 } as const;
export const AUTO_BUTTON = { x: 1231, y: 708 } as const;
/** Half-window: 30 px holds an icon and its ring where the battle draws one. */
export const WINDOW_RADIUS = 30;
/** Near-white ink. */
const INK_LUMA = 200;

/**
 * Both battle windows at or above this: the battle HUD is drawn. Measured 2026-10-25 over five
 * battle frames 0.0086–0.0314 on the speed window and 0.0107–0.0153 on the auto window; the highest
 * non-battle on either window is the FFXI map's 0.0374 on auto, which the title band rules out.
 */
export const BUTTON_INK_MIN = 0.004;
/** Both windows above this are strong evidence, rather than merely present. */
export const BUTTON_INK_STRONG = 0.008;

/**
 * The town's shop band: the eight facility glyphs (冒险者公会, 寺院, 郊外, 荒屋, 旅店, 打铁铺, 宝石商,
 * 道具店) and the street behind them. A battle draws its 倍速 and 自动 toggles over a dim dungeon scene;
 * the town draws these ivory glyphs there instead, and the two windows alone do not say which.
 */
const SHOP_BAND = { x: 650, y: 280, width: 600, height: 360 } as const;
/** Ivory ink: the glyphs are pale warm white, the gold sky behind them is not (its saturation is 80+). */
const SHOP_INK_LUMA = 150;
const SHOP_INK_SAT = 45;
/** A glyph's stroke carries its own dark outline this close to it; a bright *surface* has none. */
const SHOP_STROKE_DARK = 90;
const SHOP_STROKE_RADIUS = 2;

/**
 * At or above this the band carries drawn glyphs, and the frame's mid band is the town's, not the
 * battle's. Measured 2026-11-07 on the 1920×1080 corpus with `shopBandInk`:
 *
 * | frame | shop-band ink px |
 * | --- | --- |
 * | `2026-11-07-town-live/town-1920.jpg` (the live town of this ticket) | 2 942 |
 * | `testdata/frames/town-*.jpg` (the six committed town frames) | 1 933–2 166 |
 * | battles: the five command-phase frames, the two FFXI-era ones, the revive QTE | 2–436 |
 * | the 3-D view, with its menu legend | 0–799 |
 * | the opener panel and the chest QTE | 142–452 |
 * | dungeon maps, Dungeon Select, the inn dialogs | 374–5 717 |
 *
 * The floor sits 2.3× above the highest battle (436) and 1.9× below the lowest town frame (1 933).
 * It is **not** evidence that the frame is the town: a map, the Dungeon Select list or the inn dialog
 * draws its own text in the same band and clears the floor too. It says the battle HUD's mid band is
 * the one screen that is dark there, which is what `screens.ts` needs to keep the town off the battle.
 */
export const SHOP_BAND_INK_MIN = 1_000;

export interface FrameFacts {
  /** The minimap arrow's pixel count in the corner (`minimap.ts`). */
  readonly minimapArrowPx: number;
  /** The centred title band's **text** ink (`map.ts` G4): a bright stroke with its own dark gap. */
  readonly titleBarInkPx: number;
  /** Near-white ink in the 60×60 speed window. */
  readonly speedInk: number;
  /** Near-white ink in the 60×60 auto window. */
  readonly autoInk: number;
  /** Ivory glyph ink in the town's shop band (`shopBandInk`): a battle is dark there. */
  readonly shopBandInkPx: number;
}

/** A frame the fixed rects were not measured at: every fact is absent, so nothing is ruled out. */
export const NO_FACTS: FrameFacts = {
  minimapArrowPx: 0,
  titleBarInkPx: 0,
  speedInk: 0,
  autoInk: 0,
  shopBandInkPx: 0,
};

export function readFacts(image: RgbaImage): FrameFacts {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return NO_FACTS;
  return {
    minimapArrowPx: minimapArrowInk(image),
    titleBarInkPx: titleBarInk(image),
    speedInk: inkFraction(image, SPEED_BUTTON),
    autoInk: inkFraction(image, AUTO_BUTTON),
    shopBandInkPx: shopBandInk(image),
  };
}

/** Thresholds re-exported so a reader of the table does not import two modules to learn them. */
export { MINIMAP_ARROW_MIN, TITLE_BAR_INK_MIN };

/**
 * Ivory ink px in the town's shop band: bright, low-saturation pixels that sit within
 * `SHOP_STROKE_RADIUS` of a dark pixel up, down, left or right. A glyph — the town's shop labels and
 * their icons — passes; the gold sky (saturation 80+) and a flat bright surface do not. Measured
 * 2026-11-07: 2 942 on the live town, 1 933–2 166 on the six committed town frames, 2–436 on the
 * five command-phase battle frames and the two FFXI-era ones (the battle's band is the dim dungeon,
 * with only its torch flames bright there). One pass over the band; the stroke test reads four
 * neighbours and only for pixels that are already bright.
 */
export function shopBandInk(image: RgbaImage): number {
  const { data, width, height } = image;
  const x0 = Math.max(0, SHOP_BAND.x);
  const y0 = Math.max(0, SHOP_BAND.y);
  const x1 = Math.min(width, SHOP_BAND.x + SHOP_BAND.width);
  const y1 = Math.min(height, SHOP_BAND.y + SHOP_BAND.height);
  let ink = 0;
  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const offset = (row + x) * 4;
      const luma = (data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000;
      if (luma <= SHOP_INK_LUMA) continue;
      const sat = Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!)
        - Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!);
      if (sat > SHOP_INK_SAT) continue;
      if (darkAround(data, width, height, x, y)) ink += 1;
    }
  }
  return ink;
}

/** Whether the pixel `SHOP_STROKE_RADIUS` away in one of the four directions is a glyph's outline. */
function darkAround(data: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  const r = SHOP_STROKE_RADIUS;
  for (const [dx, dy] of [[-r, 0], [r, 0], [0, -r], [0, r]] as const) {
    const xx = x + dx;
    const yy = y + dy;
    if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
    const offset = (yy * width + xx) * 4;
    const luma = (data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000;
    if (luma < SHOP_STROKE_DARK) return true;
  }
  return false;
}

function inkFraction(image: RgbaImage, centre: { x: number; y: number }): number {
  const { data, width } = image;
  let lit = 0;
  let total = 0;
  for (let y = centre.y - WINDOW_RADIUS; y <= centre.y + WINDOW_RADIUS; y += 1) {
    const row = y * width;
    for (let x = centre.x - WINDOW_RADIUS; x <= centre.x + WINDOW_RADIUS; x += 1) {
      const offset = (row + x) * 4;
      const luma = ((data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000) | 0;
      if (luma > INK_LUMA) lit += 1;
      total += 1;
    }
  }
  return lit / total;
}
