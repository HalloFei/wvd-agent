/**
 * Readers: the primitive that turns a region of a frame into a value.
 *
 * A reader is one module with one job — `read(image)` answers a value and its confidence, or null
 * when the evidence is not there. It never throws into the loop (contracts §3), and its region is
 * stated as **fractions of a 16:9 frame**, so one measurement serves every client size the World may
 * meet (contracts §0.5) — except the readers whose controls are drawn against the fixed 1920×1080
 * client, which say so and use client pixels.
 *
 * The base fixes what every reader shares, which is the modular point (operator rule 2026-11-03:
 * *similar readers can all inherit a basic reader class; similar attributes*):
 *
 * - the frame shape it accepts (16:9, at the client's size);
 * - the region it reads, and the conversion to pixels;
 * - the luma rule every real realisation in this package uses;
 * - the answer shape: `{ value, confidence }` or `null`.
 *
 * The **realisation is free**: a glyph template match (`GlyphReader`), a strip compared against a
 * measured library (`StripLibraryReader`), a count of ink, a structural parse of a dialog. Changing
 * a realisation must not change the caller — the same contract, the same null.
 */
import type { Point, RgbaImage } from '../contracts.ts';

/** A region of a frame, as fractions of its width and height (0..1). */
export interface ReadRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** One reader's answer: the value it read, and how strongly the frame supports it (0..1). */
export interface ReadResult<T> {
  readonly value: T;
  readonly confidence: number;
}

/** A small luma patch a template reader matches: the measure's own bytes, its size, and its name. */
export interface LumaPatch {
  readonly width: number;
  readonly height: number;
  /** Row-major luma, `width * height` bytes. */
  readonly gray: Uint8Array;
}

/** Every reader in the package: a region of a frame in, one typed value or null out. */
export abstract class FrameReader<T> {
  protected constructor(readonly name: string) {}

  /** Read the frame, or null. Never throws: a decode failure is the caller's null. */
  abstract read(image: RgbaImage): ReadResult<T> | null;
}

/** The client's shape: a reader that keys on the fixed 1920×1080 layout says so once. */
export function isClientFrame(image: RgbaImage): boolean {
  return image.width === 1_920 && image.height === 1_080;
}

/** The region's pixels on this frame; a fractional region rounds outward so nothing is clipped. */
export function regionPixels(image: RgbaImage, region: ReadRegion): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, Math.round(image.width * region.x0)),
    y0: Math.max(0, Math.round(image.height * region.y0)),
    x1: Math.min(image.width, Math.round(image.width * region.x1)),
    y1: Math.min(image.height, Math.round(image.height * region.y1)),
  };
}

/** Luma of one pixel, 0..255 (the package's one luma rule). */
export function lumaAt(image: RgbaImage, x: number, y: number): number {
  const offset = (y * image.width + x) * 4;
  return (image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1_000;
}

/** A patch of the frame's luma, for a reader that compares strips or builds a library entry. */
export function lumaPatch(image: RgbaImage, at: Point, width: number, height: number): LumaPatch {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = Math.round(lumaAt(image, at.x + x, at.y + y));
    }
  }
  return { width, height, gray };
}

/**
 * Normalised cross-correlation of a patch against the frame at `at`, −1..1. 1 is an exact match and
 * two unrelated strips sit near 0; a flat patch answers 0 rather than dividing by nothing.
 */
export function correlationAt(image: RgbaImage, at: Point, patch: LumaPatch): number {
  const { width, height, gray } = patch;
  if (at.x < 0 || at.y < 0 || at.x + width > image.width || at.y + height > image.height) return 0;
  let templateMean = 0;
  let frameMean = 0;
  for (let index = 0; index < gray.length; index += 1) templateMean += gray[index]!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) frameMean += lumaAt(image, at.x + x, at.y + y);
  }
  templateMean /= gray.length;
  frameMean /= gray.length;
  let numerator = 0;
  let templateEnergy = 0;
  let frameEnergy = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const template = gray[y * width + x]! - templateMean;
      const frame = lumaAt(image, at.x + x, at.y + y) - frameMean;
      numerator += template * frame;
      templateEnergy += template * template;
      frameEnergy += frame * frame;
    }
  }
  const denominator = Math.sqrt(templateEnergy * frameEnergy);
  return denominator < 1e-6 ? 0 : numerator / denominator;
}

/**
 * The frame's luma over a fractional region, sampled into a fixed `width × height` patch. This is what
 * makes a measured library **frame-size independent**: the entry was sampled once at some size, and a
 * reader samples whatever frame it is given into the same grid before comparing.
 */
export function sampleRegion(image: RgbaImage, region: ReadRegion, width: number, height: number): LumaPatch {
  const box = regionPixels(image, region);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = box.y0 + Math.floor(((y + 0.5) / height) * (box.y1 - box.y0));
    for (let x = 0; x < width; x += 1) {
      const sx = box.x0 + Math.floor(((x + 0.5) / width) * (box.x1 - box.x0));
      gray[y * width + x] = Math.round(lumaAt(image, Math.min(sx, image.width - 1), Math.min(sy, image.height - 1)));
    }
  }
  return { width, height, gray };
}

/** One entry of a measured library: the name a patch carries, and the patch. */
export interface LibraryEntry extends LumaPatch {
  readonly label: string;
}

/**
 * A reader that matches strips against a **measured library** — the pattern the loot-item database
 * and the harken's floor rows share: the control is a fixed band, its content differs by the label,
 * and the labels are learned from frames instead of assumed.
 */
export class StripLibraryReader extends FrameReader<{ label: string; score: number }> {
  readonly #library: readonly LibraryEntry[];
  readonly #region: ReadRegion;
  readonly #floor: number;

  constructor(name: string, region: ReadRegion, library: readonly LibraryEntry[], floor: number) {
    super(name);
    this.#region = region;
    this.#library = library;
    this.#floor = floor;
  }

  read(image: RgbaImage): ReadResult<{ label: string; score: number }> | null {
    let best: { label: string; score: number } | null = null;
    for (const entry of this.#library) {
      // Sampling the frame into the entry's own grid makes the comparison frame-size independent.
      const sample = sampleRegion(image, this.#region, entry.width, entry.height);
      const score = correlation(sample, entry);
      if (best === null || score > best.score) best = { label: entry.label, score };
    }
    if (best === null || best.score < this.#floor) return null;
    return { value: best, confidence: best.score };
  }
}

/** Correlation of two patches of the same size, −1..1; the patch-vs-patch form of `correlationAt`. */
export function correlation(a: LumaPatch, b: LumaPatch): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const count = a.gray.length;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < count; index += 1) {
    meanA += a.gray[index]!;
    meanB += b.gray[index]!;
  }
  meanA /= count;
  meanB /= count;
  let numerator = 0;
  let energyA = 0;
  let energyB = 0;
  for (let index = 0; index < count; index += 1) {
    const left = a.gray[index]! - meanA;
    const right = b.gray[index]! - meanB;
    numerator += left * right;
    energyA += left * left;
    energyB += right * right;
  }
  const denominator = Math.sqrt(energyA * energyB);
  return denominator < 1e-6 ? 0 : numerator / denominator;
}
