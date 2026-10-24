/**
 * The chest prompt (contracts §2 `chest-prompt`): the two stacked bars the game shows when the
 * party stands next to a chest — `打开` (open) and `什么也不做` (do nothing).
 *
 * It is a *presence* test, not a text reader. The bars are the darkest thing the game draws at those
 * two rows (mean luma ~30 against ~55–125 elsewhere), and they are the only screen with two of them
 * stacked. A black loading frame is dark too, so each bar must also carry some near-white text; a
 * uniform frame has none.
 *
 * Measured 2026-10-24, 1920×1080 (`testdata/screens/2026-10-24-ffxi/`):
 *
 * | frame | row 1 mean / dark | row 2 mean / dark | verdict |
 * | --- | --- | --- | --- |
 * | chest prompt | 31.4 / 0.91 | 29.4 / 0.95 | chest-prompt |
 * | 3D dungeon view | 69.9 / 0.58 | 62.7 / 0.75 | not |
 * | dungeon map | 124.2 / 0.04 | 102.8 / 0.11 | not |
 * | combat | 56.4 / 0.78 | 53.6 / 0.80 | not |
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The bars span the panel's width; sampled rows are the middle of each bar. */
const BAND_X0 = 700;
const BAND_X1 = 1220;
const BANDS = [
  { y0: 845, y1: 875 },
  { y0: 910, y1: 940 },
] as const;

/** A bar's interior is dark; the "打开" text on it is near-white. */
const DARK_LUMA = 60;
const TEXT_LUMA = 200;
const DARK_MIN = 0.85;
const MEAN_MAX = 45;
const TEXT_MIN = 0.002;

export class ChestPromptPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return unknown;

    for (const band of BANDS) {
      const stats = readBand(image, band);
      if (stats.mean > MEAN_MAX || stats.dark < DARK_MIN || stats.text < TEXT_MIN) return unknown;
    }
    return { screen: 'chest-prompt', atMs: frame.atMs, confidence: 1 };
  }
}

function readBand(
  image: RgbaImage,
  band: { readonly y0: number; readonly y1: number },
): { readonly mean: number; readonly dark: number; readonly text: number } {
  const { data, width } = image;
  let sum = 0;
  let count = 0;
  let dark = 0;
  let text = 0;
  for (let y = band.y0; y <= band.y1; y += 1) {
    const row = y * width;
    for (let x = BAND_X0; x <= BAND_X1; x += 1) {
      const offset = (row + x) * 4;
      const luma = ((data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000) | 0;
      sum += luma;
      count += 1;
      if (luma < DARK_LUMA) dark += 1;
      if (luma > TEXT_LUMA) text += 1;
    }
  }
  return { mean: sum / count, dark: dark / count, text: text / count };
}
