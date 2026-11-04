/**
 * The main character's death (operator, 2026-11-05).
 *
 * The scene is the camera falling onto the character's own gauntlets in the dark: no HUD, no
 * minimap, no title, no buttons. Before this name it was an unnamed frame — the loop held the mode
 * it was in, waited out the settle and asked Coo (live 2026-11-04 16:06:57: a 120 s stall on the
 * death scene while the mode was `chest`).
 *
 * The measured evidence is the game's own treatment: the death frame is rendered in **greyscale**.
 * On the live frame (`testdata/screens/2026-11-05-main-character-death/death.jpeg`, a 1280×720
 * escalation snapshot) the mean saturation is **0.000** and **0.00 %** of pixels are saturated,
 * against 0.058–0.148 and 5.8–33.4 % on every other recorded screen (the battle command phase, the
 * revive QTE, the dungeon map, the chest prompt, the character page). Luma 59.8, so the rule also
 * excludes a black or blank transition (luma < 20) and a blown-out frame (luma > 140).
 *
 * The rule is a **fraction**, not a rectangle: it holds at 1280 and 1920 without scaling geometry.
 * Sampling every 8th pixel on both axes keeps the full-frame statistic cheap (~32 k samples per
 * 1080p frame, against 2 M for a full pass).
 *
 * The name is all there is: there is no recovery module. The route waits on this screen and the
 * game's own revive changes it; a session that cannot come back is the stall clock's business.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

const SAMPLE_STRIDE = 8;
/** Below this luma the frame is a black or blank transition, not a scene. */
export const DEATH_LUMA_MIN = 20;
/** Above this luma the frame is blown out: not the dark death scene. */
export const DEATH_LUMA_MAX = 140;
/** Fraction of saturated pixels at or below which the frame is greyscale. Measured: 0 vs ≥ 5.8 %. */
export const DEATH_COLOUR_MAX = 0.005;
/** A pixel is "saturated" above this: the death scene has none, every other screen has many. */
const SATURATION_MIN = 0.18;
/** Saturation is only counted where there is light: a dark pixel's hue is JPEG noise. */
const VALUE_MIN = 40;

export class MainCharacterDeathPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    if (image.width < 64 || image.height < 64) return unknown;
    const { luma, colourFraction } = greyscaleFacts(image);
    if (luma < DEATH_LUMA_MIN || luma > DEATH_LUMA_MAX || colourFraction > DEATH_COLOUR_MAX) return unknown;
    return { screen: 'main-character-dead', atMs: frame.atMs, confidence: 0.9 };
  }
}

/** Mean luma (Rec. 601) and the fraction of saturated pixels, on a sampling grid. */
export function greyscaleFacts(image: RgbaImage): { readonly luma: number; readonly colourFraction: number } {
  const { data, width, height } = image;
  let luma = 0;
  let colour = 0;
  let count = 0;
  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= data.length) break;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      luma += (r * 299 + g * 587 + b * 114) / 1000;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max >= VALUE_MIN && (max - min) / max > SATURATION_MIN) colour += 1;
      count += 1;
    }
  }
  return count === 0 ? { luma: 0, colourFraction: 1 } : { luma: luma / count, colourFraction: colour / count };
}
