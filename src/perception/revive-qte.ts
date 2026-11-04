/**
 * A party member's death: the revive QTE (operator, 2026-11-05).
 *
 * When a member falls in battle the game puts the revive QTE up: the 3-D battle view with the
 * boss's HUD at the top, the command row and the party panel gone, a **pale-violet ring** swirling
 * over the fallen member, and a modal **close X** in the bottom-right corner. Before this name the
 * frame was `unknown` at 0.80 and the battle **mode** held it (2026-11-03 design): the loop waited,
 * the ring faded, and the farm carried on with a dead member.
 *
 * The measured evidence is the frame's own UI, on `testdata/battle-2026-11-02/revive-qte.jpg`
 * (1920×1080, the live frame) and the 1280×720 copy the escalation snapshot is taken at
 * (`testdata/screens/2026-11-05-party-revive/revive-qte-1280.jpg`, a box-filtered downscale of the
 * same frame):
 *
 * - **the close X** — bright pixels (luma > 140) in the bottom-right 7 % window: **0.065** at 1920
 *   and **0.080** at 1280, against **0.000** on every other recorded screen (the battle's command
 *   phase, both slot panels, the skill-detail panel, every escalation snapshot, the death scene, the
 *   chest prompt, the map, the character page, the loot card, the harken menu, the Dungeon Select
 *   list). The chest's QTE bar does carry a bright bottom-right control (0.17–0.20), but its frame
 *   has no ring and the chest recogniser names it first.
 * - **the ring** — the pale-violet swirl in the centre band (x 25–65 %, y 25–70 %): pixels with
 *   `b ≥ g + 8`, `b ≥ r − 5` and luma > 100 are **3.4 %** of the band here, at most **0.73 %** on
 *   every other recorded screen except the Dungeon Select list (7.4 %, which its own recogniser
 *   names first and which has no close X).
 *
 * Both thresholds sit between the measurements, and both are **fractions** of their window, so the
 * rule holds at 1920 and 1280 without scaling geometry. Sampling every 4th pixel keeps the two
 * windows under ~15 k reads per 1080p frame.
 *
 * The name is all there is: no revive module plays the QTE. The route waits on it, the World either
 * stops the session (`stopOnDeath`, the operator's farm run) or asks Coo once, exactly like the main
 * character's death scene.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

/** Sample every 4th pixel inside each window: the rule is a fraction, not a rectangle template. */
const SAMPLE_STRIDE = 4;
/** A pixel is "bright" above this luma: the close X's circle and glyph are near-white. */
const BRIGHT_LUMA = 140;
/** A ring pixel is lit *and* violet: the swirl, not the grey stone under it. */
const RING_LUMA = 100;
/** Fraction of bright pixels in the bottom-right window at which the close X is drawn. */
export const REVIVE_CLOSE_X_MIN = 0.03;
/** Fraction of pale-violet pixels in the centre band at which the revive ring is drawn. */
export const REVIVE_RING_MIN = 0.01;

export interface ReviveFacts {
  readonly closeX: number;
  readonly ring: number;
}

/** The two fractions the rule reads, exported so the test can pin the measurements. */
export function reviveFacts(image: RgbaImage): ReviveFacts {
  const { data, width, height } = image;
  const x0 = Math.floor(width * 0.93);
  const y0 = Math.floor(height * 0.93);
  let bright = 0;
  let closeCount = 0;
  for (let y = y0; y < height; y += SAMPLE_STRIDE) {
    for (let x = x0; x < width; x += SAMPLE_STRIDE) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= data.length) continue;
      const luma = (data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000;
      if (luma > BRIGHT_LUMA) bright += 1;
      closeCount += 1;
    }
  }
  const rx0 = Math.floor(width * 0.25);
  const rx1 = Math.ceil(width * 0.65);
  const ry0 = Math.floor(height * 0.25);
  const ry1 = Math.ceil(height * 0.70);
  let violet = 0;
  let ringCount = 0;
  for (let y = ry0; y < ry1; y += SAMPLE_STRIDE) {
    for (let x = rx0; x < rx1; x += SAMPLE_STRIDE) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= data.length) continue;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      if (luma > RING_LUMA && b >= g + 8 && b >= r - 5) violet += 1;
      ringCount += 1;
    }
  }
  return {
    closeX: closeCount === 0 ? 0 : bright / closeCount,
    ring: ringCount === 0 ? 0 : violet / ringCount,
  };
}

export class ReviveQtePerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    if (image.width < 64 || image.height < 64) return unknown;
    const { closeX, ring } = reviveFacts(image);
    if (closeX < REVIVE_CLOSE_X_MIN || ring < REVIVE_RING_MIN) return unknown;
    // The two facts together: a modal screen's close button over the battle, and the revive ring.
    return { screen: 'revive-qte', atMs: frame.atMs, confidence: 0.85 };
  }
}
