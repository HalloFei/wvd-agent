/**
 * The battle's skill panel: **locating** its 確定 button, not assuming where it is.
 *
 * A quick-slot tap opens the skill's detail panel; the skill does not resolve until 確定 is pressed.
 * The panel is drawn by the game at a position that moves between frames: the same 拉巴迪奥斯的秘术
 * panel measured 2026-11-05 had its buttons at y 975–1035 and the live frame of 2026-11-07 22:16 has
 * them at y 976–1037, so the fixed point the cast used (1 053, 1 005) landed on the panel body and the
 * run sat on the panel for 48 s (twice). The operator's rule (2026-11-07): *read the panel and tap the
 * confirmation button once you see it* — the same "locate, then press" the chest path uses.
 *
 * The sample is the button itself, centred on the button, so a match's centre **is** the tap point.
 * It is the same control on every skill panel (取消 / 確定 are the panel's chrome, not its content),
 * so one sample covers every skill.
 */
import type { PixelRect, Point, RgbaImage } from '../contracts.ts';
import { BATTLE_PANEL_CONFIRM_BASE64 } from './battle-panel-template.ts';
import { findTemplate } from './match.ts';

export const BATTLE_PANEL_CONFIRM_WIDTH = 57;
export const BATTLE_PANEL_CONFIRM_HEIGHT = 33;

/** The sample, in the matcher's own shape: luma bytes of the button, centred on its centre. */
export const BATTLE_PANEL_CONFIRM = {
  width: BATTLE_PANEL_CONFIRM_WIDTH,
  height: BATTLE_PANEL_CONFIRM_HEIGHT,
  gray: Uint8Array.from(Buffer.from(BATTLE_PANEL_CONFIRM_BASE64, 'base64')),
} as const;

/**
 * Where the panel's controls can be drawn: the **lower half's middle**, as fractions of the frame, so
 * the band follows the window's size. It is a search region, not a press: the press is the match.
 */
export function battlePanelBand(width: number, height: number): PixelRect {
  return {
    x: Math.round(width * 0.25),
    y: Math.round(height * 0.70),
    width: Math.round(width * 0.5),
    height: Math.round(height * 0.30),
  };
}

/** Under this the window is not the 確定 button (measured: 0.98–1.00 on the panel, < 0.5 elsewhere). */
export const BATTLE_PANEL_CONFIRM_MIN_SCORE = 0.85;

/** The panel's 確定, located on this frame, or null when the panel is not on it. */
export interface SkillPanelConfirm {
  /** The button's centre: the point to press. */
  readonly at: Point;
  /** The matcher's correlation; the caller logs it, nothing decides from it. */
  readonly score: number;
}

/**
 * Find the skill panel's 確定 on a frame. Null when the panel is not drawn — never a guessed point,
 * because a press into the panel's body or the battle behind it changes nothing and looks like a
 * lost input.
 */
export function locateSkillPanelConfirm(
  frame: RgbaImage,
  options: { band?: PixelRect; minScore?: number } = {},
): SkillPanelConfirm | null {
  const band = options.band ?? battlePanelBand(frame.width, frame.height);
  const match = findTemplate(frame, band, BATTLE_PANEL_CONFIRM, {
    scales: [1],
    minScore: options.minScore ?? BATTLE_PANEL_CONFIRM_MIN_SCORE,
  });
  if (match === null) return null;
  return {
    at: { x: match.at.x + Math.floor(match.width / 2), y: match.at.y + Math.floor(match.height / 2) },
    score: match.score,
  };
}
