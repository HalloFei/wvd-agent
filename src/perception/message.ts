/**
 * The game's one-off message box (operator, 2026-11-06): a centred dark panel with a caption line and
 * the yellow continue mark below it — the after-rest 背包已补充完毕。 was the first one the farm met,
 * unnamed, so the loop escalated on it every ~4 s (and, when the chest's loot recogniser happened to
 * claim it, dismissed it as a loot card by accident).
 *
 * Measured 2026-11-06 on testdata/screens/2026-11-06-message/ (the 1920 live frame and its 1280
 * escalation copy):
 *
 * - the panel: a light border line at y 0.450 and another at y 0.601, a dark fill (luma 78) between;
 * - the caption: white ink (luma > 200) inside y 0.47..0.56, x 0.30..0.70;
 * - the continue mark: a bright yellow triangle — rgb (251, 255, 96) at its brightest — in the band
 *   x 0.60..0.68, y 0.58..0.68: 0.0040 of the band at 1920 and 0.0031 at 1280, against **0.0000 on
 *   every other recorded screen** (the inn's dialogs, the battle, the death scene, the dungeon, the
 *   harken menu, the loot card, the Dungeon Select list, the character page) — the arrow is the
 *   decisive fact, the panel and the caption only make the name honest;
 * - the tap point: the panel's own centre (fractions 0.5, 0.529), which advances the message.
 *
 * The four facts together are the screen: a panel alone is any dialog, an arrow alone is any list's
 * cursor. The name exists so the box is answered once and the loop moves on.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';

/** Sampling stride: the rules are fractions, so every other pixel is enough. */
const STRIDE = 2;
/** The panel's border lines: luma inside this range, spanning at least this share of the width. */
const BORDER_MIN_LUMA = 90;
const BORDER_MAX_LUMA = 210;
const BORDER_MIN_RUN = 0.24;
/** The top / bottom border rows, as fractions of the height. */
const TOP_BORDER_Y = [0.43, 0.47] as const;
const BOTTOM_BORDER_Y = [0.585, 0.625] as const;
/** The caption band, and the share of it that has to be bright ink. */
const CAPTION_BAND = { x0: 0.3, x1: 0.7, y0: 0.47, y1: 0.56 } as const;
const CAPTION_MIN_INK = 0.002;
const CAPTION_LUMA = 200;
/** The continue mark's band, and the share of it that has to be the bright yellow arrow. */
const ARROW_BAND = { x0: 0.6, x1: 0.68, y0: 0.58, y1: 0.68 } as const;
const ARROW_MIN_FRACTION = 0.002;
/** The tap point: the panel's centre, fractions of the frame. */
export const MESSAGE_TAP = { x: 0.5, y: 0.529 } as const;

const lumaOf = (r: number, g: number, b: number): number => (r * 299 + g * 587 + b * 114) / 1_000;

export interface MessageFacts {
  /** The longest light-border run found in the panel's top and bottom bands, as width fractions. */
  readonly topBorder: number;
  readonly bottomBorder: number;
  /** The share of the caption band that is bright ink. */
  readonly captionInk: number;
  /** The share of the arrow band that is the bright yellow continue mark. */
  readonly arrow: number;
}

/** The four fractions the rule reads, exported so the test can pin the measurements. */
export function messageFacts(image: RgbaImage): MessageFacts {
  const { data, width, height } = image;
  const at = (x: number, y: number): number => {
    const offset = (y * width + x) * 4;
    return lumaOf(data[offset]!, data[offset + 1]!, data[offset + 2]!);
  };
  const longestRun = (y0: number, y1: number): number => {
    let best = 0;
    for (let y = Math.round(height * y0); y <= Math.round(height * y1); y += 1) {
      let run = 0;
      for (let x = 0; x < width; x += STRIDE) {
        const luma = at(x, y);
        run = luma >= BORDER_MIN_LUMA && luma <= BORDER_MAX_LUMA ? run + STRIDE : 0;
        if (run > best) best = run;
      }
    }
    return best / width;
  };
  let captionInk = 0;
  let captionCount = 0;
  for (let y = Math.round(height * CAPTION_BAND.y0); y <= Math.round(height * CAPTION_BAND.y1); y += STRIDE) {
    for (let x = Math.round(width * CAPTION_BAND.x0); x <= Math.round(width * CAPTION_BAND.x1); x += STRIDE) {
      if (at(x, y) > CAPTION_LUMA) captionInk += 1;
      captionCount += 1;
    }
  }
  let arrow = 0;
  let arrowCount = 0;
  for (let y = Math.round(height * ARROW_BAND.y0); y <= Math.round(height * ARROW_BAND.y1); y += STRIDE) {
    for (let x = Math.round(width * ARROW_BAND.x0); x <= Math.round(width * ARROW_BAND.x1); x += STRIDE) {
      const offset = (y * width + x) * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      if (r > 180 && g > 180 && b < 140 && Math.abs(r - g) < 50) arrow += 1;
      arrowCount += 1;
    }
  }
  return {
    topBorder: longestRun(TOP_BORDER_Y[0], TOP_BORDER_Y[1]),
    bottomBorder: longestRun(BOTTOM_BORDER_Y[0], BOTTOM_BORDER_Y[1]),
    captionInk: captionCount === 0 ? 0 : captionInk / captionCount,
    arrow: arrowCount === 0 ? 0 : arrow / arrowCount,
  };
}

/** Names the game's one-off message box; unknown when the panel, its caption or its arrow is absent. */
export class MessagePerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    if (image.width < 64 || image.height < 64) return unknown;
    const facts = messageFacts(image);
    if (facts.topBorder < BORDER_MIN_RUN || facts.bottomBorder < BORDER_MIN_RUN) return unknown;
    if (facts.captionInk < CAPTION_MIN_INK || facts.arrow < ARROW_MIN_FRACTION) return unknown;
    return {
      screen: 'message',
      atMs: frame.atMs,
      confidence: 0.85,
      at: { x: Math.round(image.width * MESSAGE_TAP.x), y: Math.round(image.height * MESSAGE_TAP.y) },
    };
  }
}
