import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { judgeSnapshot } from '../src/escalation/image.ts';
import { decodePng } from '../src/perception/ledger.ts';

/** A frame whose pixels are `fill` and whose declared size is the same. */
function frameOf(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Frame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = fill(x, y);
      const at = (y * width + x) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = a;
    }
  }
  return { atMs: 0, width, height, toRgba: async () => ({ data, width, height }) };
}

describe('the judged frame', () => {
  it('encodes the frame the reader judged, losslessly, at the frame s own size', async () => {
    // The point of the whole function: the evidence must be the picture the decision was made on. A
    // second capture is a different instant (2026-11-08: the loop escalated a correct dungeon and the
    // saved frame was the menu an Esc had just opened).
    const frame = frameOf(4, 3, (x, y) => [x * 40, y * 60, 7, 255]);
    const judged = await judgeSnapshot(frame, 1_920);

    expect(judged).not.toBeNull();
    expect(judged!.jpeg.width).toBe(4);
    expect(judged!.jpeg.height).toBe(3);
    expect(judged!.jpeg.bytes.subarray(0, 2)).toEqual(Uint8Array.of(0xff, 0xd8));

    const png: RgbaImage = decodePng(Buffer.from(judged!.png.bytes));
    expect(png.width).toBe(4);
    expect(png.height).toBe(3);
    expect(Array.from(png.data.subarray(0, 4))).toEqual([0, 0, 7, 255]);
    expect(Array.from(png.data.subarray((2 * 4 + 3) * 4, (2 * 4 + 3) * 4 + 4))).toEqual([120, 120, 7, 255]);
  });

  it('downscales to the width the model reads, and never upscales', async () => {
    const frame = frameOf(8, 8, () => [4, 8, 16, 255]);
    const judged = await judgeSnapshot(frame, 4);
    expect(judged!.jpeg.width).toBe(4);
    expect(judged!.jpeg.height).toBe(4);
    const png = decodePng(Buffer.from(judged!.png.bytes));
    expect(png.width).toBe(4);
    // A box average of one colour is that colour.
    expect(Array.from(png.data.subarray(0, 4))).toEqual([4, 8, 16, 255]);

    const wide = await judgeSnapshot(frame, 10_000);
    expect(wide!.png.width).toBe(8);
  });

  it('refuses a frame whose pixels disagree with the size it declares', async () => {
    // A source that lies about its own frame cannot be filed as evidence: the caller falls back to
    // its capture, and no wrong picture is stored beside a claim.
    const liar: Frame = {
      atMs: 0,
      width: 1920,
      height: 1080,
      toRgba: async () => ({ data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 }),
    };
    expect(await judgeSnapshot(liar, 1_920)).toBeNull();
  });

  it('refuses a frame whose pixels cannot be read at all', async () => {
    const unreadable: Frame = {
      atMs: 0,
      width: 4,
      height: 4,
      toRgba: async () => { throw new Error('decode failed'); },
    };
    expect(await judgeSnapshot(unreadable, 1_920)).toBeNull();
  });
});
