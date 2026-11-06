import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { decodeJpeg, gdiplusProblem } from '../src/engine/gdiplus.mjs';

const WINDOWS = process.platform === 'win32';

/**
 * The native JPEG **decoder**, without the native encoder it used to round-trip with. The encoder was
 * deleted with the vision module (2026-11-07): the child publishes raw BGRA and the World encodes only
 * escalation snapshots, with jpeg-js. Here jpeg-js is therefore the producer and GDI+ the consumer —
 * the two halves of the surviving artifact path — so the fixture still proves channel order, stride
 * and orientation agree between them without the crashing COM `Seek` the encoder needed.
 */

/** BGRA quadrants with very different colours, so a channel swap or a stride error is visible. */
function quadrantFrame(width: number, height: number): Uint8Array {
  const colors = [
    [20, 40, 200],   // blue-ish   B,G,R
    [200, 30, 30],   // red-ish
    [30, 180, 50],   // green-ish
    [220, 200, 20],  // yellow-ish
  ];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const quadrant = (y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1);
      const offset = (y * width + x) * 4;
      data[offset] = colors[quadrant][0];
      data[offset + 1] = colors[quadrant][1];
      data[offset + 2] = colors[quadrant][2];
      data[offset + 3] = 255;
    }
  }
  return data;
}

/** BGRA (the capture's order) to the RGBA jpeg-js encodes; the swap is its own inverse. */
function toRgba(bgra: Uint8Array): Uint8Array {
  const rgba = Uint8Array.from(bgra);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const blue = rgba[offset];
    rgba[offset] = rgba[offset + 2];
    rgba[offset + 2] = blue;
  }
  return rgba;
}

/** RGBA of a quadrant centre, from the decoded frame. */
function centre(decoded: { width: number; height: number; data: Uint8Array }, quadrant: number): number[] {
  const x = Math.floor(decoded.width / 4) + (quadrant % 2) * Math.floor(decoded.width / 2);
  const y = Math.floor(decoded.height / 4) + Math.floor(quadrant / 2) * Math.floor(decoded.height / 2);
  const offset = (y * decoded.width + x) * 4;
  return [...decoded.data.subarray(offset, offset + 4)];
}

describe('native JPEG decode', () => {
  it.skipIf(!WINDOWS)('decodes a 1920x1080 frame to RGBA with the channel order intact', () => {
    const width = 1920;
    const height = 1080;
    const bgra = quadrantFrame(width, height);

    const jpegBytes = Uint8Array.from(jpeg.encode({ data: toRgba(bgra), width, height }, 90).data);

    expect(jpegBytes.length).toBeGreaterThan(1000);
    expect([...jpegBytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const decoded = decodeJpeg(jpegBytes);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.data.length).toBe(width * height * 4);
    // JPEG is lossy, the channel order and quadrant placement are not
    const expected = [[200, 40, 20, 255], [30, 30, 200, 255], [50, 180, 30, 255], [20, 200, 220, 255]];
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const actual = centre(decoded, quadrant);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(actual[channel] - expected[quadrant][channel])).toBeLessThanOrEqual(8);
      }
    }
  });

  it.skipIf(gdiplusProblem() !== '')('refuses bytes that are not a JPEG', () => {
    // failure is a value at every other boundary; the decoder itself throws and the caller decides
    expect(() => decodeJpeg(Uint8Array.of(1, 2, 3))).toThrow();
  });
});
