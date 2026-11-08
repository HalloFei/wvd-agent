/**
 * The 一键恢复 dialog: the heal's own page, and the only proof that the sparkle press landed.
 *
 * Measured 2026-11-09 on `testdata/screens/2026-11-09-heal/quick-heal-1920.jpg` (the live dialog): the
 * page `一键恢复` is a centred panel with two gold-plated buttons side by side — 关闭 (left, centre
 * ~850,802) and 恢复 (right, centre ~1087,802). **Both** templates must match at their measured
 * places, which no other measured page draws: the dialog is therefore named only by its own pair.
 *
 * The reader carries the **恢复 button's matched point** — the World presses that, not a fixed
 * coordinate. The live dialog's button sits 42 px above the coordinate the old heal code carried
 * (1070,813), which is why the old "press 恢复" could be sent and do nothing.
 *
 * The dialog is drawn **over the character page**, and the page's X 关闭 tile stays visible below the
 * panel: the quick-heal reader must be asked **before** the character-page reader (the chain's order),
 * or every dialog frame is named as the page.
 */
import type { Frame, Observation, Perceiver, PixelRect, Point, RgbaImage } from '../contracts.ts';
import { findTemplate, type MatchTemplate } from './match.ts';
import { QUICK_HEAL_CANCEL, QUICK_HEAL_RESTORE } from './quick-heal-template.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The floor the two recorded buttons support (an exact pair on the dialog, unmatched elsewhere). */
export const QUICK_HEAL_FLOOR = 0.7;

const template = (entry: { readonly box: { readonly width: number; readonly height: number }; readonly grayBase64: string }): MatchTemplate => ({
  width: entry.box.width,
  height: entry.box.height,
  gray: Uint8Array.from(Buffer.from(entry.grayBase64, 'base64')),
});

export const QUICK_HEAL_RESTORE_TEMPLATE: MatchTemplate = template(QUICK_HEAL_RESTORE);
export const QUICK_HEAL_CANCEL_TEMPLATE: MatchTemplate = template(QUICK_HEAL_CANCEL);

/** The button bands: the dialog's row, a little wider than the plates so a moved panel still matches. */
const RESTORE_BAND: PixelRect = { x: 955, y: 730, width: 290, height: 130 };
const CANCEL_BAND: PixelRect = { x: 715, y: 730, width: 290, height: 130 };

/** The dialog's two matched buttons on this frame. */
export interface QuickHealMatch {
  /** The 恢复 button's centre: the press target. */
  readonly at: Point;
  /** The 关闭 button's centre: a scope test's way out. */
  readonly cancel: Point;
  readonly score: number;
}

/** The dialog on this frame, or null. Cheap: two small-band matches. */
export function findQuickHeal(image: RgbaImage): QuickHealMatch | null {
  if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return null;
  const restore = findTemplate(image, RESTORE_BAND, QUICK_HEAL_RESTORE_TEMPLATE, { scales: [1], minScore: QUICK_HEAL_FLOOR });
  if (restore === null) return null;
  const cancel = findTemplate(image, CANCEL_BAND, QUICK_HEAL_CANCEL_TEMPLATE, { scales: [1], minScore: QUICK_HEAL_FLOOR });
  if (cancel === null) return null;
  return {
    at: { x: Math.round(restore.at.x + restore.width / 2), y: Math.round(restore.at.y + restore.height / 2) },
    cancel: { x: Math.round(cancel.at.x + cancel.width / 2), y: Math.round(cancel.at.y + cancel.height / 2) },
    score: Math.min(restore.score, cancel.score),
  };
}

/** Names the 一键恢复 dialog; unknown when the two button plates are not both drawn. */
export class QuickHealPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    const match = findQuickHeal(image);
    if (match === null) return unknown;
    return { screen: 'quick-heal', atMs: frame.atMs, confidence: match.score, at: match.at, cancel: match.cancel };
  }
}
