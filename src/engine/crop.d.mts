/**
 * Types of the `.mjs` frame cropper (crop.mjs), so the World's TypeScript tests see the same pure
 * function the encoder thread runs. Kept beside the implementation; the two change together.
 */

import type { PixelRect } from '../contracts.ts';

/** A top-down BGRA buffer with the size it now describes. */
export interface CroppedBgra {
  /** The source buffer itself when the rect is the whole frame, otherwise a fresh buffer. */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The `rect` part of a `width`×`height` frame — the same `PixelRect` as `capture.crop`
 *  (contracts §5); throws `RangeError` on a nonsense rect or one that does not fit the frame. */
export declare function cropBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  rect: PixelRect,
): CroppedBgra;
