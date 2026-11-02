/**
 * The battle screen (contracts §2 `combat`).
 *
 * A battle is named by its two round buttons — 倍速 (speed) and 自动 (auto) — drawn at fixed points of
 * the 1920×1080 client area. The test is a near-white ink fraction in a 60×60 window at each: the
 * icons are near-white, the HUD behind them is not, and both windows must clear the floor.
 *
 * The windows alone cannot separate a battle from a map — the B1F map's walls fill both (0.0355 and
 * 0.0212 on `nav-1024-0213/popup.jpg`) — so the frame's evidence is checked first: `screens.ts`
 * rules `combat` out on any frame with a minimap or a centred title bar, and this perceiver refuses
 * to answer when it has. The same rule protects the classifier, so a map whose parser refuses the
 * frame is never fought on.
 *
 * Measured 2026-10-25 over 1920×1080 frames:
 *
 * | frame | speed window | auto window | verdict |
 * | --- | --- | --- | --- |
 * | battle (5 frames, both layouts) | 0.0086–0.0314 | 0.0107–0.0153 | combat |
 * | 3-D dungeon view | 0 | 0 | not |
 * | dungeon maps (5 frames) | 0.0008–0.0019 | 0–0.0374 | not |
 * | town, Dungeon Select, opener, chest QTE | ≤0.0005 | 0.0067–0.0110 | not |
 *
 * The buttons move between battle layouts: at the ends of the command row, (655,700) and
 * (1 205,700), while it is up, and at (694,716) and (1 241,716) with it down. The windows stay where
 * the second layout draws them and clear the floor in both; every other screen measured is below it.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';
import { BUTTON_INK_MIN, BUTTON_INK_STRONG, readFacts, type FrameFacts } from './facts.ts';
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
    return { screen: 'combat', atMs: frame.atMs, confidence };
  }
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
