/**
 * Types of the `.mjs` GDI+ module (gdiplus.mjs). Kept beside the implementation; the two change
 * together.
 */

/** Decoded pixels, RGBA, row-major. */
export interface RgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface JpegEncoder {
  /** Top-down BGRA in, JPEG bytes out. */
  encode(bgra: Uint8Array, width: number, height: number): Uint8Array;
}

/** An encoder over GDI+, or null when GDI+ cannot start (fall back to jpeg-js and say so). */
export declare function createJpegEncoder(quality: number): JpegEncoder | null;

/** Decode a JPEG to RGBA; throws when GDI+ cannot start or the bytes are unreadable. */
export declare function decodeJpeg(bytes: Uint8Array): RgbaFrame;

/** Copy 32bpp top-down pixels out of native memory with any stride; exported for its row test. */
export declare function copyStrided(source: unknown, stride: number, width: number, height: number): Uint8Array;

/** Why GDI+ is unavailable; empty when it is available. */
export declare function gdiplusProblem(): string;
