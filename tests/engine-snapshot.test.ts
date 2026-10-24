import { MessageChannel, Worker } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';

/** Four BGRA quadrants, so a scaled frame's decoded corners still say which source quadrant they came from. */
function quadrants(width: number, height: number): Uint8Array {
  const colours = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255]];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      data.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return data;
}

/** The worker, plus a queue that keeps messages in order and a `frame` helper that waits for one. */
function openWorker() {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('../src/engine/jpeg-worker.mjs', import.meta.url), {
    workerData: { quality: 80, forceJpegJs: true, port: port2 },
    transferList: [port2],
  });
  const queue: Array<Record<string, unknown>> = [];
  let wake: (() => void) | null = null;
  worker.on('message', (message) => {
    queue.push(message);
    wake?.();
    wake = null;
  });
  const take = async (): Promise<Record<string, unknown>> => {
    while (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
    return queue.shift()!;
  };
  const frame = async (seq: number): Promise<Record<string, unknown>> => {
    const pixels = quadrants(192, 108);
    port1.postMessage({ seq, pixels: pixels.buffer, width: 192, height: 108, capturedAt: seq }, [pixels.buffer as ArrayBuffer]);
    for (;;) {
      const message = await take();
      if (message.kind === 'frame' && message.seq === seq) return message;
    }
  };
  const ready = async () => {
    for (;;) {
      const message = await take();
      if (message.kind === 'ready') return message;
    }
  };
  const close = () => {
    worker.terminate();
    port1.close();
  };
  return { worker, queue, take, frame, ready, close };
}

/**
 * The encoder worker's snapshot path, without a window and without GDI+ (jpeg-js is forced, which the
 * worker already reports as a fallback): the loop's frames stay native, and only the frame a
 * `{ op: 'snapshot' }` names is scaled before it is encoded.
 */
describe('encoder worker snapshot path', () => {
  it('scales exactly the frame a snapshot asked for and reports the size it encoded', async () => {
    const { worker, queue, take, frame, ready, close } = openWorker();
    try {
      expect(await ready()).toMatchObject({ kind: 'ready', role: 'encoder', gdiplus: false });

      // the perception path: no snapshot pending, no scaling
      const nativeFirst = await frame(1);
      expect(nativeFirst.width).toBe(192);
      expect(nativeFirst.height).toBe(108);

      // one snapshot request, applied to the next frame only
      worker.postMessage({ op: 'snapshot', snapshotId: 7, maxWidth: 96 });
      // let the directive reach the worker before the frame it should apply to
      await new Promise((resolve) => setTimeout(resolve, 50));
      const nativeSecond = await frame(2);
      expect(nativeSecond.width).toBe(192);
      const snapshot = await take();
      expect(snapshot).toMatchObject({ kind: 'snapshot', snapshotId: 7, seq: 2, width: 96, height: 54, capturedAt: 2 });
      const decoded = jpeg.decode(Buffer.from(snapshot.jpeg as Uint8Array), { useTArray: true, formatAsRGBA: true });
      expect(decoded.width).toBe(96);
      expect(decoded.height).toBe(54);

      // and the directive is spent: the next frame is native again, with no extra snapshot behind it
      const nativeThird = await frame(3);
      expect(nativeThird.width).toBe(192);
      expect(nativeThird.height).toBe(108);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(queue.filter((message) => message.kind === 'snapshot')).toHaveLength(0);
    } finally {
      close();
    }
  }, 20000);

  it('drops a snapshot directive when the request that wanted it timed out', async () => {
    const { worker, queue, frame, ready, close } = openWorker();
    try {
      await ready();
      worker.postMessage({ op: 'snapshot', snapshotId: 9, maxWidth: 64 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // the child's timeout cancels the directive before any frame arrives
      worker.postMessage({ op: 'snapshot', snapshotId: null });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect((await frame(1)).width).toBe(192);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(queue.filter((message) => message.kind === 'snapshot')).toHaveLength(0);
    } finally {
      close();
    }
  }, 20000);
});
