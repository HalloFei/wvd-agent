import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { STILL_FRACTION, movedFraction, sceneIsStill, sceneSignature } from '../src/frames/stillness.ts';

/** An image of one luma, or of a function of (x, y), in grey. */
function image(width: number, height: number, value: number | ((x: number, y: number) => number)): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const luma = typeof value === 'number' ? value : value(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = luma;
      data[offset + 1] = luma;
      data[offset + 2] = luma;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('scene stillness', () => {
  it('calls the same frame still, including JPEG-sized noise below the luma boundary', () => {
    const previous = sceneSignature(image(1920, 1080, 90));
    // JPEG noise moves a sample by a few luma, never by MOVED_LUMA: it is not motion.
    const noisy = sceneSignature(image(1920, 1080, (x, y) => 90 + ((x + y) % 5)));

    expect(sceneIsStill(previous, noisy)).toBe(true);
    expect(movedFraction(previous, noisy)).toBe(0);
  });

  it('calls a changed scene moving', () => {
    const before = sceneSignature(image(1920, 1080, (x) => (x < 960 ? 30 : 200)));
    const after = sceneSignature(image(1920, 1080, (x) => (x < 960 ? 200 : 30)));

    expect(sceneIsStill(before, after)).toBe(false);
    expect(movedFraction(before, after)).toBeGreaterThan(0.9);
  });

  it('tolerates the measured particle flicker of a stopped party', () => {
    // navigation §3a: two frames 2.5 s apart differed by 1.3 % — flicker, not walking. A patch on
    // ~1 % of the frame must still read as still, or arrival could never be seen at all.
    const before = sceneSignature(image(1920, 1080, 60));
    const after = sceneSignature(image(1920, 1080, (x, y) => (
      x < 96 && y < 216 ? 255 : 60
    )));

    expect(movedFraction(before, after)).toBeLessThan(STILL_FRACTION);
    expect(sceneIsStill(before, after)).toBe(true);
  });

  it('does not treat two frame sizes as the same scene', () => {
    expect(sceneIsStill(sceneSignature(image(1920, 1080, 60)), sceneSignature(image(1280, 720, 60))))
      .toBe(false);
  });

  it('reads dimensions from the image, and a 1x1 frame is one sample', () => {
    expect(sceneSignature(image(1, 1, 42))).toMatchObject({ columns: 1, rows: 1 });
    // 1920/16 = 120 columns, 1080/16 = 67.5 → 68 rows
    expect(sceneSignature(image(1920, 1080, 42))).toMatchObject({ columns: 120, rows: 68 });
  });

  it('treats a malformed (short) image as black instead of throwing', () => {
    const short: RgbaImage = { data: new Uint8Array(4), width: 100, height: 100 };

    expect(() => sceneSignature(short)).not.toThrow();
    expect(sceneSignature(short).luma[0]).toBe(0);
  });
});
