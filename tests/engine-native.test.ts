import { MessageChannel, Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { createJpegEncoder, decodeJpeg, gdiplusProblem } from '../src/engine/gdiplus.mjs';

const WINDOWS = process.platform === 'win32';

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

/** RGBA of a quadrant centre, from the decoded frame. */
function centre(decoded: { width: number; height: number; data: Uint8Array }, quadrant: number): number[] {
  const x = Math.floor(decoded.width / 4) + (quadrant % 2) * Math.floor(decoded.width / 2);
  const y = Math.floor(decoded.height / 4) + Math.floor(quadrant / 2) * Math.floor(decoded.height / 2);
  const offset = (y * decoded.width + x) * 4;
  return [...decoded.data.subarray(offset, offset + 4)];
}

describe('native JPEG path', () => {
  it.skipIf(!WINDOWS)('round-trips a synthetic 1920x1080 BGRA frame through the GDI+ encoder and decoder (R22)', () => {
    const encoder = createJpegEncoder(90);
    if (!encoder) throw new Error(`GDI+ unavailable: ${gdiplusProblem()}`);
    const width = 1920;
    const height = 1080;
    const bgra = quadrantFrame(width, height);

    const jpegBytes = encoder.encode(bgra, width, height);

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

  it.skipIf(!WINDOWS)('the encoder worker uses GDI+ and reports no problem on a working machine', async () => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('../src/engine/jpeg-worker.mjs', import.meta.url), {
      workerData: { quality: 80, port: port2 },
      transferList: [port2],
    });
    try {
      const messages: Array<Record<string, unknown>> = [];
      const frame = new Promise((resolve) => worker.on('message', (message) => {
        messages.push(message);
        if (message.kind === 'frame') resolve(message);
      }));
      const width = 64;
      const height = 48;
      const pixels = quadrantFrame(width, height);
      port1.postMessage({ seq: 1, pixels: pixels.buffer, width, height, capturedAt: 0 }, [pixels.buffer as ArrayBuffer]);
      const encoded = (await frame) as { width: number; height: number; jpeg: Uint8Array };
      expect(encoded.width).toBe(width);
      expect(encoded.height).toBe(height);
      expect([...new Uint8Array(encoded.jpeg).subarray(0, 2)]).toEqual([0xff, 0xd8]);
      expect(messages.some((message) => message.kind === 'problem')).toBe(false);
    } finally {
      worker.terminate();
      port1.close();
    }
  }, 20000);

  it.skipIf(!WINDOWS)('the encoder worker falls back to jpeg-js and reports native-encoder-unavailable (R23)', async () => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('../src/engine/jpeg-worker.mjs', import.meta.url), {
      workerData: { quality: 80, forceJpegJs: true, port: port2 },
      transferList: [port2],
    });
    try {
      const problems: Array<Record<string, unknown>> = [];
      const frame = new Promise((resolve) => worker.on('message', (message) => {
        if (message.kind === 'problem') problems.push(message);
        if (message.kind === 'frame') resolve(message);
      }));
      const width = 64;
      const height = 48;
      const pixels = quadrantFrame(width, height);
      port1.postMessage({ seq: 1, pixels: pixels.buffer, width, height, capturedAt: 0 }, [pixels.buffer as ArrayBuffer]);
      const encoded = (await frame) as { width: number; height: number; jpeg: Uint8Array };
      expect(problems).toEqual([{ kind: 'problem', detail: 'native-encoder-unavailable' }]);
      expect(encoded.width).toBe(width);
      expect(encoded.height).toBe(height);
      expect([...new Uint8Array(encoded.jpeg).subarray(0, 2)]).toEqual([0xff, 0xd8]);
    } finally {
      worker.terminate();
      port1.close();
    }
  }, 20000);
});
