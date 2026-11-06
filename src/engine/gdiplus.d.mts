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

/** Decode a JPEG to RGBA; throws when GDI+ cannot start or the bytes are unreadable. */
export declare function decodeJpeg(bytes: Uint8Array): RgbaFrame;

/** Why GDI+ is unavailable; empty when it is available. */
export declare function gdiplusProblem(): string;
