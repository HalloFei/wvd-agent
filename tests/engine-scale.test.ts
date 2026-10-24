import { describe, expect, it } from 'vitest';
import { scaleBgra, scaledSize } from '../src/engine/scale.mjs';

// BGRA, top-down, as the capture worker produces it. Corner colours are chosen so a channel swap,
// a transposed box or a wrong stride shows up immediately.
const BLUE = [255, 0, 0, 255];
const RED = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const YELLOW = [0, 255, 255, 255];

/** Four quadrants: blue top-left, red top-right, green bottom-left, yellow bottom-right. */
function quadrants(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = y < height / 2 ? (x < width / 2 ? BLUE : RED) : (x < width / 2 ? GREEN : YELLOW);
      data.set(colour, (y * width + x) * 4);
    }
  }
  return data;
}

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return [...pixels.subarray(offset, offset + 4)];
}

/** A 1921-wide frame: columns 0..959 red, the rest blue (the odd source width is the point). */
function oddWidthBands(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(x < 960 ? RED : BLUE, (y * width + x) * 4);
    }
  }
  return data;
}

describe('snapshot downscaler', () => {
  it('keeps the aspect ratio and rounds the height, for even and odd source widths', () => {
    expect(scaledSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize(1921, 1081, 1280)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize(1366, 768, 1024)).toEqual({ width: 1024, height: 576 });
  });

  it('never upscales a frame that is already narrower than the request', () => {
    expect(scaledSize(1920, 1080, 2560)).toEqual({ width: 1920, height: 1080 });
    expect(scaledSize(1920, 1080, 1920)).toEqual({ width: 1920, height: 1080 });
  });

  it('clamps a height that would round to zero to one row', () => {
    expect(scaledSize(10000, 1, 1000)).toEqual({ width: 1000, height: 1 });
  });

  it('rejects nonsense sizes instead of guessing', () => {
    expect(() => scaledSize(0, 1080, 1280)).toThrow(RangeError);
    expect(() => scaledSize(1920, 0, 1280)).toThrow(RangeError);
    expect(() => scaledSize(1920, 1080, 1280.5)).toThrow(RangeError);
    expect(() => scaledSize(1920, 1080, 0)).toThrow(RangeError);
    expect(() => scaledSize(1920, 1080, Number.NaN)).toThrow(RangeError);
  });

  it('box-filters 1920x1080 to 1280x720 with the four corner colours intact', () => {
    const scaled = scaleBgra(quadrants(1920, 1080), 1920, 1080, 1280);

    expect(scaled.width).toBe(1280);
    expect(scaled.height).toBe(720);
    expect(scaled.pixels.length).toBe(1280 * 720 * 4);
    expect(pixelAt(scaled.pixels, 1280, 0, 0)).toEqual(BLUE);
    expect(pixelAt(scaled.pixels, 1280, 1279, 0)).toEqual(RED);
    expect(pixelAt(scaled.pixels, 1280, 0, 719)).toEqual(GREEN);
    expect(pixelAt(scaled.pixels, 1280, 1279, 719)).toEqual(YELLOW);
  });

  it('does not smear an odd-width boundary by half a pixel', () => {
    const scaled = scaleBgra(oddWidthBands(1921, 1081), 1921, 1081, 1280);

    expect(scaled.width).toBe(1280);
    expect(scaled.height).toBe(720);
    // 960 red columns over 1921 map to target column ~639: only that one may blend, and the columns
    // either side must be the pure band colour
    expect(pixelAt(scaled.pixels, 1280, 638, 0)).toEqual(RED);
    expect(pixelAt(scaled.pixels, 1280, 640, 0)).toEqual(BLUE);
    const boundary = pixelAt(scaled.pixels, 1280, 639, 0);
    expect(boundary[0]).toBeGreaterThan(0); // some blue
    expect(boundary[2]).toBeGreaterThan(0); // some red
    // the box splits 959/960 exactly, so the two channels differ by at most the odd rounding unit
    expect(Math.abs(boundary[0] - boundary[2])).toBeLessThanOrEqual(1);
    expect(boundary[0] + boundary[2]).toBeGreaterThanOrEqual(254);
    expect(boundary[0] + boundary[2]).toBeLessThanOrEqual(256);
  });

  it('tiles a non-integer reduction exactly, with no column or row counted twice', () => {
    // 11 -> 5: the box boundaries land on 0,2,4,7,9,11; a floor/ceil filter would double-count the
    // shared columns and answer 10,30,50,70,90 instead of 5,25,50,75,95
    const width = 11;
    const source = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        source.set([x * 10, y * 10, 0, 255], (y * width + x) * 4);
      }
    }

    const scaled = scaleBgra(source, width, width, 5);

    expect(scaled.width).toBe(5);
    expect(scaled.height).toBe(5);
    const columnMeans = [5, 25, 50, 75, 95];
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        expect(pixelAt(scaled.pixels, 5, x, y), `pixel ${x},${y}`).toEqual([columnMeans[x], columnMeans[y], 0, 255]);
      }
    }
  });

  it('returns the source untouched when the request is too large to apply', () => {
    const source = quadrants(64, 36);
    const scaled = scaleBgra(source, 64, 36, 128);

    expect(scaled.pixels).toBe(source);
    expect(scaled.width).toBe(64);
    expect(scaled.height).toBe(36);
  });

  it('scales a one-pixel-tall frame to one row instead of producing nothing', () => {
    const width = 10000;
    const source = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) source.set(x < width / 2 ? BLUE : RED, x * 4);

    const scaled = scaleBgra(source, width, 1, 1000);

    expect(scaled.width).toBe(1000);
    expect(scaled.height).toBe(1);
    expect(scaled.pixels.length).toBe(1000 * 4);
    expect(pixelAt(scaled.pixels, 1000, 0, 0)).toEqual(BLUE);
    expect(pixelAt(scaled.pixels, 1000, 999, 0)).toEqual(RED);
  });
});
