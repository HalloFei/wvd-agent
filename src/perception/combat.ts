/**
 * The battle screen (contracts §2 `combat`).
 *
 * A battle is named by its two round buttons — 倍速 (speed) bottom-left of the party cards and 自动
 * (auto) bottom-right — because they are the only UI this game draws *only* in combat, and they sit
 * at fixed points of the 1920×1080 client area. The test is a bright-ink fraction in a small window
 * around each: the icons are near-white, the ground behind them is not, and a map's parchment can
 * light one window but not both (measured: a map scores 0.034 on the auto button and 0.001 on the
 * speed button, so the pair is what discriminates).
 *
 * Thresholds are measured, not guessed:
 *
 * | frame | speed window | auto window | verdict |
 * | --- | --- | --- | --- |
 * | combat, auto on | 0.009–0.028 | 0.010–0.015 | combat |
 * | 3D dungeon view | 0 | 0 | not |
 * | dungeon map | 0.001 | 0.034 | not |
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** Centre of the 倍速 button and of the 自动 button, client pixels (measured on the live game). */
const SPEED_BUTTON = { x: 691, y: 708 } as const;
const AUTO_BUTTON = { x: 1231, y: 708 } as const;
/** Half-window: the button is ~40 px across, so 30 px holds the icon and its ring. */
const WINDOW_RADIUS = 30;
/** Near-white icon ink. */
const INK_LUMA = 200;
/** Below this the window holds no icon. */
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
