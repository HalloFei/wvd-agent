/**
 * The engine's JPEG encoder, on its own thread: `child.mjs` captures at ~30 fps on the main thread
 * while this thread encodes the previous frame (R12). GDI+ is the encoder; `jpeg-js` is the fallback
 * behind the same `encode(bgra, width, height)` call when GDI+ cannot start, so a machine without
 * the flat API still produces frames.
 *
 * Buffers are handed back after each frame so the capture loop reuses them instead of allocating
 * 8 MB per frame. The BGRA buffer is copied before the jpeg-js path swaps channels, so a frame that
 * falls back never corrupts the buffer the native encoder will see next.
 */
import { parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import * as win32 from './win32-native.mjs';

const quality = Number(workerData?.quality ?? 75);
const report = (message) => parentPort.postMessage({ kind: 'log', message });

let encoder = null;
let nativeProblem = '';
try {
  encoder = win32.createJpegEncoder(quality);
  if (!encoder) nativeProblem = win32.gdiplusProblem() || 'gdiplus-unavailable';
} catch (error) {
  nativeProblem = error?.message ?? String(error);
}
report(encoder ? 'jpeg encoder: gdi+ (native)' : `jpeg encoder: jpeg-js fallback (${nativeProblem})`);
parentPort.postMessage({ ready: true, gdiplus: encoder !== null });

/** jpeg-js wants RGBA; the capture is BGRA. Copy so the pooled buffer keeps its GDI+ layout. */
function jpegJs(bgra, width, height) {
  const rgba = Uint8Array.from(bgra);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const blue = rgba[offset];
    rgba[offset] = rgba[offset + 2];
    rgba[offset + 2] = blue;
  }
  return Buffer.from(jpeg.encode({ data: rgba, width, height }, quality).data);
}

parentPort.on('message', (message) => {
  if (!message || typeof message.seq !== 'number') return;
  const { seq, pixels, width, height } = message;
  const bgra = new Uint8Array(pixels);
  const started = performance.now();
  let bytes = null;
  if (encoder) {
    try {
      bytes = encoder.encode(bgra, width, height);
    } catch (error) {
      report(`GDI+ encode failed (${error?.message ?? error}); jpeg-js from here on`);
      encoder = null;
    }
  }
  if (!bytes) bytes = jpegJs(bgra, width, height);
  const encodeMs = +(performance.now() - started).toFixed(1);
  parentPort.postMessage({ seq, jpeg: bytes, pixels, width, height, encodeMs }, [pixels]);
});
