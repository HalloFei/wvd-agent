/**
 * The battle's **skill detail panel**: the page a slot tap opens, and the one the 確定 must be pressed
 * on.
 *
 * It was the 20:12 stall of 2026-11-08 and the 21:12 one after it. The panel is a modal over the battle
 * scene — the skill's name, its description, an MP line and **two buttons, 取消 and 確定, side by side
 * at the bottom of it** — and no recogniser named it, so the frame escalated (20 s), and the fallback's
 * Esc **cancelled the panel** the battle was waiting to confirm. The cast was then never resolved and
 * the battle sat with 自動 off and no input at all.
 *
 * Its deciding feature is the button pair, and nothing else in this game draws one there: a dialog in
 * the battle's lower band is a **rule** (a bright horizontal line) above **two plates of the same size**
 * with a clear gap between them. Measured on the live frame (\`testdata/screens/2026-11-08-battle/
 * skill-panel.png\`, 1920×1080): the rule is one row of ~326 bright pixels at y 980, and the pair is two
 * runs of 150 and 140 bright columns at y 1020–1055 with a 20 px gap at x 960. The party card panel,
 * the opener panel, the loot banner and a map draw no such pair.
 *
 * The press itself is **not** this module's: the battle sequence owes the 確定 from the slot tap and
 * locates the button on the frame (\`perception/battle-panel.ts\`). Naming the screen is what keeps the
 * escalation, and its Esc, away from the panel.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

/**
 * The pair's band: the dialog's two buttons sit here in the client's 1920×1080, whatever the panel's
 * height. Measured y 1020–1055; the band allows the panel to move a few pixels.
 */
export const PAIR_BAND = { top: 1_000, bottom: 1_060, left: 760, right: 1_160 } as const;
/** The rule above them: one bright row of the dialog's own separator. */
export const RULE_BAND = { top: 962, bottom: 998, left: 700, right: 1_250 } as const;
/** A column counts as part of a plate when this many of the band's rows are lit. */
export const PLATE_ROWS = 6;
/** Luma at which a pixel is ink. */
export const PANEL_INK_LUMA = 100;
/** The shortest run that can be one of the two plates, and the gap that separates them. */
export const PLATE_MIN_WIDTH = 60;
export const PLATE_GAP_MIN = 8;
/** The pair together: a dialog's buttons, not a row of three cards or a grid. */
export const PAIR_MIN_SPAN = 240;
export const PAIR_MAX_SPAN = 460;
/** The rule's width: the dialog's own width, far wider than a label. */
export const RULE_MIN_WIDTH = 150;

interface Pair {
  readonly first: number;
  readonly second: number;
  readonly gap: number;
  readonly span: number;
}

/** The two plates' bright runs in the pair band, when the band holds exactly two of them. */
export function findPair(image: RgbaImage): Pair | null {
  const runs: Array<{ start: number; width: number }> = [];
  let start: number | null = null;
  let width = 0;
  const close = (): void => {
    if (start !== null && width >= PLATE_MIN_WIDTH) runs.push({ start, width });
    start = null;
    width = 0;
  };
  for (let x = PAIR_BAND.left; x <= PAIR_BAND.right; x += 2) {
    let lit = 0;
    for (let y = PAIR_BAND.top; y <= PAIR_BAND.bottom; y += 2) {
      const at = (y * image.width + x) * 4;
      const luma = 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
      if (luma > PANEL_INK_LUMA) {
        lit += 1;
        if (lit >= PLATE_ROWS / 2) break;
      }
    }
    if (lit >= PLATE_ROWS / 2) {
      start ??= x;
      width += 2;
    } else {
      close();
    }
  }
  close();
  if (runs.length !== 2) return null;
  const [first, second] = runs as [{ start: number; width: number }, { start: number; width: number }];
  const gap = second.start - (first.start + first.width);
  const span = second.start + second.width - first.start;
  if (gap < PLATE_GAP_MIN || span < PAIR_MIN_SPAN || span > PAIR_MAX_SPAN) return null;
  return { first: first.width, second: second.width, gap, span };
}

/** The dialog's rule above the buttons: the widest bright row in its band. */
export function ruleWidth(image: RgbaImage): number {
  let widest = 0;
  for (let y = RULE_BAND.top; y <= RULE_BAND.bottom; y += 2) {
    let run = 0;
    for (let x = RULE_BAND.left; x <= RULE_BAND.right; x += 2) {
      const at = (y * image.width + x) * 4;
      const luma = 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
      if (luma > PANEL_INK_LUMA) {
        run += 2;
        if (run > widest) widest = run;
      } else {
        run = 0;
      }
    }
  }
  return widest;
}

/** Names the panel. Both anchors are required; the confidence grades how squarely they were met. */
export class SkillPanelPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const image = await frame.toRgba();
    const pair = findPair(image);
    if (pair === null) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    const rule = ruleWidth(image);
    if (rule < RULE_MIN_WIDTH) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    // Two plates of one size, and a dialog wide enough to be this panel: the closer the two plates are
    // to each other in width, the more certain it is that this is a button row and not a coincidence.
    const likeness = Math.min(pair.first, pair.second) / Math.max(pair.first, pair.second);
    const confidence = Math.min(0.99, 0.85 + 0.14 * likeness);
    return { screen: 'skill-panel', atMs: frame.atMs, confidence };
  }
}
