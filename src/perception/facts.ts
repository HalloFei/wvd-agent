/**
 * The cheap facts one frame offers about its own screen.
 *
 * Four measurements, each the smallest rect that answers its question, taken once per frame so that
 * every perceiver reads the same numbers instead of re-deriving them: the minimap's arrow, the
 * centred title band's ink, and the ink in the two battle-button windows. They are geometry of the
 * 1920×1080 client (contracts §0.5): another size carries none of them, and a recogniser that needs
 * its own rects refuses that frame on its own.
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
const SPEED_BUTTON = { x: 691, y: 708 } as const;
const AUTO_BUTTON = { x: 1231, y: 708 } as const;
/** Half-window: 30 px holds an icon and its ring where the battle draws one. */
const WINDOW_RADIUS = 30;
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

export interface FrameFacts {
  /** The minimap arrow's pixel count in the corner (`minimap.ts`). */
  readonly minimapArrowPx: number;
  /** The centred title band's pixel count (`map.ts` G4). */
  readonly titleBarInkPx: number;
  /** Near-white ink in the 60×60 speed window. */
  readonly speedInk: number;
  /** Near-white ink in the 60×60 auto window. */
  readonly autoInk: number;
}

/** A frame the fixed rects were not measured at: every fact is absent, so nothing is ruled out. */
export const NO_FACTS: FrameFacts = {
  minimapArrowPx: 0,
  titleBarInkPx: 0,
  speedInk: 0,
  autoInk: 0,
};

export function readFacts(image: RgbaImage): FrameFacts {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return NO_FACTS;
  return {
    minimapArrowPx: minimapArrowInk(image),
    titleBarInkPx: titleBarInk(image),
    speedInk: inkFraction(image, SPEED_BUTTON),
    autoInk: inkFraction(image, AUTO_BUTTON),
  };
}

/** Thresholds re-exported so a reader of the table does not import two modules to learn them. */
export { MINIMAP_ARROW_MIN, TITLE_BAR_INK_MIN };

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
