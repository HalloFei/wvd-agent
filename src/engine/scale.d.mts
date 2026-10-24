/**
 * Types of the `.mjs` snapshot downscaler (scale.mjs), so the World's TypeScript tests see the same
 * pure functions the encoder thread runs. Kept beside the implementation; the two change together.
 */

/** A top-down BGRA buffer with the size it now describes. */
export interface ScaledBgra {
  /** The source buffer itself when no scaling is needed, otherwise a fresh buffer. */
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The size a `maxWidth` request produces; throws `RangeError` on a nonsense frame or request. */
export declare function scaledSize(
  width: number,
  height: number,
  maxWidth: number,
): { readonly width: number; readonly height: number };

/** A box filter from `width`×`height` down to at most `maxWidth`; never upscales, never copies then. */
export declare function scaleBgra(
  bgra: Uint8Array,
  width: number,
  height: number,
  maxWidth: number,
): ScaledBgra;
