/**
 * The battle screen (contracts §2 `combat`).
 *
 * A battle is named by its two round buttons — 倍速 (speed) and 自动 (auto) — drawn at fixed points of
 * the 1920×1080 client area. The test is a near-white ink fraction in a 60×60 window at each: the
 * icons are near-white, the HUD behind them is not, and both windows must clear the floor.
 *
 * A frame carrying a centred title bar is refused before the windows are read, because no battle
 * draws one: a map draws its floor title there, and so do the town and Dungeon Select. That gate is
 * what keeps a map out of the fight — the B1F map's walls fill both windows (0.0355 and 0.0212 on
 * `nav-1024-0213/popup.jpg`) while every battle frame measured carries 0–1 px of title ink.
 *
 * Measured 2026-10-25 over 1920×1080 frames:
 *
 * | frame | speed window | auto window | title ink | verdict |
 * | --- | --- | --- | --- | --- |
 * | battle (5 frames, both layouts) | 0.0086–0.0314 | 0.0107–0.0153 | 0–1 | combat |
 * | 3-D dungeon view | 0 | 0 | 0 | not |
 * | dungeon maps (5 frames) | 0.0008–0.0019 | 0–0.0374 | 759–1824 | not |
 * | town, Dungeon Select, opener, chest QTE | ≤0.0005 | 0.0067–0.0110 | 865–5251 | not |
 *
 * The buttons move between battle layouts: at the ends of the command row, (655,700) and
 * (1 205,700), while it is up, and at (694,716) and (1 241,716) with it down. The windows stay where
 * the second layout draws them and clear the floor in both; every other screen measured is below it.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';
import { TITLE_BAR_INK_MIN, titleBarInk } from './map.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** Centre of the 倍速 button and of the 自动 button, client pixels (measured on the live game). */
const SPEED_BUTTON = { x: 691, y: 708 } as const;
const AUTO_BUTTON = { x: 1231, y: 708 } as const;
/** Half-window: 30 px holds an icon and its ring where the battle draws one. */
const WINDOW_RADIUS = 30;
/** Near-white icon ink. */
const INK_LUMA = 200;
/** Below this the window holds no battle HUD. */
const INK_MIN = 0.004;
/** Both windows above this is a confident battle (the measured floor is not a ceiling). */
const INK_STRONG = 0.008;

export class CombatPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return unknown;

    // A title bar belongs to a map, the town or Dungeon Select; no battle draws one.
    if (titleBarInk(image) >= TITLE_BAR_INK_MIN) return unknown;

    const speed = inkFraction(image, SPEED_BUTTON);
    const auto = inkFraction(image, AUTO_BUTTON);
    if (speed < INK_MIN || auto < INK_MIN) return unknown;
    const confidence = speed >= INK_STRONG && auto >= INK_STRONG ? 1 : 0.8;
    return { screen: 'combat', atMs: frame.atMs, confidence };
  }
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
