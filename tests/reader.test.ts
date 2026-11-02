import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import {
  correlationAt,
  isClientFrame,
  lumaPatch,
  regionPixels,
  sampleRegion,
  StripLibraryReader,
  type LibraryEntry,
} from '../src/perception/reader.ts';

/**
 * The reader primitive (operator rule 2026-11-03: *a reader is a primitive module; similar readers
 * inherit a basic reader class*). These pin the contract every reader shares: a region of a frame in,
 * `{ value, confidence }` or null out, and no throw.
 *
 * The strips here are synthetic so the numbers are exact: a strip of two columns is matched against
 * itself, against a different strip, and against nothing.
 */
function image(width: number, height: number, paint: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = paint(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** A strip 40 px wide, 8 tall: a dark field with a bright block at a given column. */
function stripAt(column: number): (x: number, y: number) => number {
  return (x) => (x >= column && x < column + 12 ? 220 : 30);
}

describe('the reader primitive', () => {
  it('states a region in fractions and rounds it to pixels', () => {
    const frame = image(200, 100, () => 0);
    expect(regionPixels(frame, { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.8 })).toEqual({ x0: 20, y0: 20, x1: 120, y1: 80 });
    expect(isClientFrame(frame)).toBe(false);
    expect(isClientFrame(image(1920, 1080, () => 0))).toBe(true);
  });

  it('correlates a patch with itself at 1, and unrelated strips near 0', () => {
    const frame = image(80, 8, stripAt(10));
    const patch = lumaPatch(frame, { x: 10, y: 0 }, 40, 8);
    expect(correlationAt(frame, { x: 10, y: 0 }, patch)).toBeCloseTo(1, 5);
    const other = lumaPatch(image(80, 8, stripAt(50)), { x: 10, y: 0 }, 40, 8);
    expect(correlationAt(frame, { x: 10, y: 0 }, other)).toBeLessThan(0.9);
  });

  it('labels a strip from its measured library, and answers null off the floor', () => {
    const frame = image(300, 40, stripAt(100));
    const region = { x0: 0.33, y0: 0.2, x1: 0.53, y1: 0.5 };
    const entry: LibraryEntry = { label: '归还', ...sampleRegion(frame, region, 60, 12) };
    const reader = new StripLibraryReader('harken-row-3', region, [entry], 0.9);
    expect(reader.read(frame)).toEqual({ value: { label: '归还', score: 1 }, confidence: 1 });

    // A row the library has never seen is a null, not the closest name.
    const unseen = image(300, 40, stripAt(40));
    expect(reader.read(unseen)).toBeNull();
    // And a frame too small for the region is a null too, not an exception.
    expect(reader.read(image(20, 20, () => 0))).toBeNull();
  });
});
