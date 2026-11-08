/**
 * The game's own blank frame — and the screen name the whole loop was already built around.
 *
 * \`loading\` has been a first-class screen since the contracts were written: the orientation waits on
 * it (\`policy/orient.ts\`), the mode ignores it (\`policy/mode.ts\`), the recovery stepper leaves it
 * alone (\`policy/recover.ts\`), a page episode survives it (\`policy/page-episode.ts\`), the task steps
 * treat it as "not yet" (\`tasks/steps.ts\`) and the heal refuses to abandon on it (\`world.ts\`). **No
 * reader ever named it.** A blank frame therefore answered \`unknown\` at 0.20, which is the loop's
 * "something is drawn that I cannot name" refusal — so the World escalated it, pressed Esc after 20 s,
 * and a fade became an episode (live 2026-11-08: a heal gave up on a page that was open the whole time
 * and the recovery then closed the page without healing).
 *
 * A blank frame is not ambiguous, it is empty: the game fades to black for a load, an inn's rest, a
 * scene change. The measurement (2026-11-08, bright-pixel fraction of the frame, luma > 24 over a 4-px
 * grid, 47 fixtures plus 2 live frames) is unambiguous:
 *
 *   the live black frame after a battle   0.00005   (only the FPS counter is lit)
 *   the dimmest drawn screen in the corpus 0.26      (the inn's room list over a dark room)
 *   every other fixture                    0.64–0.87
 *
 * Four orders of magnitude between "empty" and "dark", so the anchor is a fraction, not a guess:
 * **a frame with 2 % of its pixels brighter than luma 24 is not blank** — 400× the black frame, 13×
 * below the dimmest thing the game ever draws.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

/** The bright-pixel fraction at or below which a frame is the game's blank one (measured above). */
export const BLANK_BRIGHT_FRACTION = 0.02;

/** What counts as a lit pixel: the frame's own 3-D view is far above this everywhere it is drawn. */
export const BRIGHT_LUMA = 24;

/** The sampling grid: every 4th pixel in each axis (480×270 samples on the client). */
export const BLANK_SAMPLE_STEP = 4;

/**
 * Whether the frame is blank, bailing as soon as it cannot be: a drawn frame leaves the question
 * after a few dozen samples, so the gate costs the tick nothing (contracts §0.7: observe is the
 * half-tick's budget).
 */
export function isBlank(image: RgbaImage): boolean {
  const { data, width, height } = image;
  let sampled = 0;
  let bright = 0;
  for (let y = 0; y < height; y += BLANK_SAMPLE_STEP) {
    for (let x = 0; x < width; x += BLANK_SAMPLE_STEP) {
      const at = (y * width + x) * 4;
      const luma = 0.299 * data[at]! + 0.587 * data[at + 1]! + 0.114 * data[at + 2]!;
      sampled += 1;
      if (luma > BRIGHT_LUMA) {
        bright += 1;
        if (bright > sampled * BLANK_BRIGHT_FRACTION) return false;
      }
    }
  }
  return bright <= sampled * BLANK_BRIGHT_FRACTION;
}

/**
 * Names the game's blank frame \`loading\`. First in the chain: the cheapest decisive gate is the one
 * a frame's own emptiness answers, and every later recogniser is wasted work on pixels that are not
 * there.
 */
export class LoadingPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    if (!isBlank(await frame.toRgba())) {
      return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    }
    // Certain by construction: the frame has no ink. The confidence is what tells the loop a wait is
    // the right answer rather than a question.
    return { screen: 'loading', atMs: frame.atMs, confidence: 1 };
  }
}
