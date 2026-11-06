import { describe, expect, it } from 'vitest';
import { numbersOf, ppmOf } from '../src/perception/readout-ocr.ts';

describe('the readout OCR escalation', () => {
  it('takes the two integers in reading order, whatever the labels do around them', () => {
    expect(numbersOf('X: 16 Y: 4')).toEqual({ x: 16, y: 4 });
    expect(numbersOf('X: 13 Y: 25')).toEqual({ x: 13, y: 25 });
    // The OCR's box grouping put the labels either side of the values on this frame.
    expect(numbersOf(':X Y: 19 2')).toEqual({ x: 19, y: 2 });
    expect(numbersOf('X: Y: 20 14')).toEqual({ x: 20, y: 14 });
  });

  it('refuses anything that is not exactly two integers', () => {
    expect(numbersOf('X: Y:')).toBeNull();
    expect(numbersOf('X: 16')).toBeNull();
    expect(numbersOf('X: 16 Y: 4 9')).toBeNull();
    expect(numbersOf('')).toBeNull();
  });

  it('writes the band as a binary PPM the OCR can open', () => {
    const image = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).fill(128) };
    const ppm = ppmOf(image, { x: 1, y: 0, width: 2, height: 2 });
    const header = ppm.subarray(0, 11).toString('ascii');
    expect(header).toBe('P6\n2 2\n255\n');
    expect(ppm.length).toBe(11 + 2 * 2 * 3);
  });
});
