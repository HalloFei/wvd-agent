import { describe, expect, it } from 'vitest';
import { cropBgra } from '../src/engine/crop.mjs';

// BGRA quadrants, as the capture worker produces them: blue TL, red TR, green BL, yellow BR.
function quadrants(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const colours = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      data.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return data;
}

describe('cropBgra', () => {
  it('copies exactly the rectangle, row by row, at the right stride', () => {
    const source = quadrants(192, 108);
    const cropped = cropBgra(source, 192, 108, { x: 96, y: 54, width: 96, height: 54 });
    expect(cropped.width).toBe(96);
    expect(cropped.height).toBe(54);
    expect(cropped.pixels).toHaveLength(96 * 54 * 4);
    // the bottom-right quadrant is yellow everywhere
    for (let offset = 0; offset < cropped.pixels.length; offset += 4) {
      expect([...cropped.pixels.subarray(offset, offset + 4)]).toEqual([0, 255, 255, 255]);
    }
  });

  it('returns the source buffer when the rect is the whole frame', () => {
    const source = quadrants(192, 108);
    const cropped = cropBgra(source, 192, 108, { x: 0, y: 0, width: 192, height: 108 });
    expect(cropped.pixels).toBe(source);
  });

  it.each([
    ['past the right edge', { x: 100, y: 0, width: 100, height: 10 }],
    ['past the bottom edge', { x: 0, y: 100, width: 10, height: 100 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 10 }],
    ['negative origin', { x: -1, y: 0, width: 10, height: 10 }],
    ['fractional', { x: 0.5, y: 0, width: 10, height: 10 }],
  ])('refuses a rect %s', (_label, rect) => {
    expect(() => cropBgra(quadrants(192, 108), 192, 108, rect as never)).toThrow(RangeError);
  });
});
