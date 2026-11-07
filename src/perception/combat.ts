/**
 * The battle screen (contracts §2 `combat`).
 *
 * A battle is named by its two round buttons — 倍速 (speed) and 自动 (auto) — drawn at fixed points of
 * the 1920×1080 client area. The test is a near-white ink fraction in a 60×60 window at each: the
 * icons are near-white, the HUD behind them is not, and both windows must clear the floor.
 *
 * The windows alone cannot separate a battle from a map — the B1F map's walls fill both (0.0355 and
 * 0.0212 on `nav-1024-0213/popup.jpg`) — or from the town's party panel, whose idle sparkle and
 * sunlit street fill both on the live 2026-11-07 client. So the frame's evidence is checked first:
 * `screens.ts` rules `combat` out on any frame with a minimap, a centred title bar or the town's shop
 * band (a battle is dim where the town draws its eight glyphs), and this perceiver refuses to answer
 * when it has. The same rule protects the classifier, so a map whose parser refuses the frame — and
 * the town — is never fought on.
 *
 * Measured over 1920×1080 frames (2026-10-25, and the town row 2026-11-07):
 *
 * | frame | speed window | auto window | verdict |
 * | --- | --- | --- | --- |
 * | battle (5 frames, both layouts) | 0.0086–0.0314 | 0.0107–0.0153 | combat |
 * | 3-D dungeon view | 0 | 0 | not |
 * | dungeon maps (5 frames) | 0.0008–0.0019 | 0–0.0374 | not |
 * | town, Dungeon Select, opener, chest QTE (2026-10-25 frames) | ≤0.0005 | 0.0067–0.0110 | not |
 * | **town, 2026-11-07 live frame** | **0.0239** | **0.0288** | **not (shop band)** |
 *
 * The buttons move between battle layouts: at the ends of the command row, (655,700) and
 * (1 205,700), while it is up, and at (694,716) and (1 241,716) with it down. The windows stay where
 * the second layout draws them and clear the floor in both; every other screen measured is below it.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';
import {
  AUTO_BUTTON,
  BUTTON_INK_MIN,
  BUTTON_INK_STRONG,
  readFacts,
  SPEED_BUTTON,
  WINDOW_RADIUS,
  type FrameFacts,
} from './facts.ts';
import { screenStandings, settlesAgainst } from './screens.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

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

    const facts = readFacts(image);
    if (!battleHudUp(facts)) return unknown;
    const confidence = facts.speedInk >= BUTTON_INK_STRONG && facts.autoInk >= BUTTON_INK_STRONG ? 1 : 0.8;
    const toggles = battleToggles(image);
    return {
      screen: 'combat',
      atMs: frame.atMs,
      confidence,
      ...(toggles === null ? {} : { speedOn: toggles.speedOn, autoOn: toggles.autoOn }),
    };
  }
}

/**
 * The two battle toggles' highlight on this frame, or null off the reference size. A toggle that is on
 * is drawn gold (warm); one that is off is drawn white/grey. Measured 2026-11-03 over the same 60×60
 * windows the facts count:
 *
 * | frame | 倍速 window | 自動 window |
 * | --- | --- | --- |
 * | `alice-command-phase.jpg` (both off) | 2.3 | 1.2 |
 * | `command-phase.jpg` (speed on, auto off) | **56.4** | 1.0 |
 * | a live auto battle (auto on) | 1.6 | **39.5** |
 *
 * The operator's battle order is speed → opener → auto → finish, and both buttons are toggles, so the
 * loop presses one only when the frame says it is off (operator rule 2026-11-03).
 */
export function battleToggles(image: RgbaImage): { speedOn: boolean; autoOn: boolean } | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  return {
    speedOn: warmthIn(image, SPEED_BUTTON) >= TOGGLE_WARM_MIN,
    autoOn: warmthIn(image, AUTO_BUTTON) >= TOGGLE_WARM_MIN,
  };
}

/** A toggle is drawn gold when on and white/grey when off; measured on 39.5–56.4 against 1.0–2.3. */
const TOGGLE_WARM_MIN = 20;

/** Mean of `max(r, g) - b` in the toggle's own 60×60 window: gold scores high, white and grey near zero. */
function warmthIn(image: RgbaImage, centre: { x: number; y: number }): number {
  const { data, width } = image;
  let sum = 0;
  let count = 0;
  for (let y = centre.y - WINDOW_RADIUS; y <= centre.y + WINDOW_RADIUS; y += 1) {
    const row = y * width;
    for (let x = centre.x - WINDOW_RADIUS; x <= centre.x + WINDOW_RADIUS; x += 1) {
      const offset = (row + x) * 4;
      sum += Math.max(data[offset]!, data[offset + 1]!) - data[offset + 2]!;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * The battle HUD's evidence, without the frame: both button windows are lit, and no screen fact
 * rules a battle out. The command phase's party panel is drawn by the same HUD, so the reader that
 * names the active member (`party.ts`) asks this before it trusts a card.
 */
export function battleHudUp(facts: FrameFacts): boolean {
  if (facts.speedInk < BUTTON_INK_MIN || facts.autoInk < BUTTON_INK_MIN) return false;
  return !settlesAgainst(screenStandings(facts), 'combat');
}
