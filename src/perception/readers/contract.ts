/**
 * The numerals-reader seam: one rectangle of a frame in, one named number or `null` out.
 *
 * The opener's 由谁打开? panel failed live on 2026-11-07 for a reason no click could explain: the panel
 * was recognised and then refused by its own reader, because the digit atlases are means of glyphs
 * recorded through the old JPEG decode and perception now hands over raw pixels. The atlases were
 * never the fact — the number is — so the seam is a **reader contract**: a caller names the region it
 * wants read and a reader answers a value, a confidence and **which tier answered**. Perception must
 * not encode a property of the capture pipeline; a tier is free to refuse, and the caller names the
 * fact (contracts §0.6).
 *
 * `rule` and `template` are the fast tiers; `ocr` is the escalation, invoked only when they refuse
 * (the model is an escalation, not a layer). The tiers are realisations, not layers: a caller may
 * swap one out without changing, and `autoReader` reports which one answered so a run that starts
 * falling through the fast tiers is visible before it dies.
 */
import type { RgbaImage } from '../../contracts.ts';

/** Which tier named the number. The mix is the health metric, not an implementation detail. */
export type Tier = 'rule' | 'template' | 'ocr';

/**
 * A rectangle in the frame's own device pixels. The same shape as the engine's `PixelRect`, on
 * purpose: a reader is handed the crop it must read (the measured opener fields are pixel rects),
 * never fractions, so nothing re-derives a region. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the caller knows about the field it is reading.
 *
 * - `digits` — the field's expected length, when known. A reader may use it to segment or to refuse
 *   an answer whose length contradicts the field.
 * - `label` — the field's label, for a reader that needs context. Measured 2026-11-07: a context-free
 *   87 x 16 slice of 陷阱发现 reads nothing, while the crop that carries the label reads `陷阱发现38`.
 *   A read therefore covers `region ∪ label` (see `readCoverage`).
 * - `min` / `max` — sanity bounds. A number outside them is a **refusal**, not an answer: a value the
 *   field cannot carry is evidence the read went wrong.
 */
export interface ReadHint {
  readonly digits?: 1 | 2 | 3;
  readonly label?: Region;
  readonly min?: number;
  readonly max?: number;
}

/** One read: the number the frame carries, how strongly it supports it (0..1), and who read it. */
export interface Numerals {
  readonly value: number;
  readonly confidence: number;
  readonly tier: Tier;
}

/**
 * Every numerals reader: a frame and the rectangle to read, plus what the caller knows about the
 * field. Asynchronous because an escalation may leave the process; a fast tier settles immediately.
 * Never throws — an unreadable field is `null` (contracts §3).
 */
export interface NumeralsReader {
  read(image: RgbaImage, region: Region, hint?: ReadHint): Promise<Numerals | null>;
}

/** Is the rectangle wholly inside the frame, with positive integer geometry? */
function inside(image: RgbaImage, region: Region): boolean {
  const { x, y, width, height } = region;
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(width) && Number.isInteger(height)
    && width > 0 && height > 0
    && x >= 0 && y >= 0 && x + width <= image.width && y + height <= image.height;
}

/**
 * The pixels a read must cover: `region`, plus the hint's label when it carries one. Null when
 * either rectangle is not wholly inside the frame — a read that would have to clip is a refusal,
 * not a guessed crop.
 */
export function readCoverage(image: RgbaImage, region: Region, hint?: ReadHint): Region | null {
  if (!inside(image, region)) return null;
  const label = hint?.label;
  if (label === undefined) return region;
  if (!inside(image, label)) return null;
  const x = Math.min(region.x, label.x);
  const y = Math.min(region.y, label.y);
  const width = Math.max(region.x + region.width, label.x + label.width) - x;
  const height = Math.max(region.y + region.height, label.y + label.height) - y;
  return { x, y, width, height };
}

/** Does the number satisfy the hint's sanity bounds? Absent bounds accept every number. */
export function withinHint(value: number, hint?: ReadHint): boolean {
  if (hint?.min !== undefined && value < hint.min) return false;
  if (hint?.max !== undefined && value > hint.max) return false;
  return true;
}
