/**
 * The engine's JPEG encoder thread. Frames arrive from the capture worker on a MessagePort; encoded
 * frames go to the protocol thread on `parentPort`. GDI+ is the encoder; `jpeg-js` is the fallback,
 * and a fallback is never silent — it posts `native-encoder-unavailable`, which the child forwards
 * as `engineProblem` so a session cannot time a QTE on a 5 fps path without being told (R23).
 *
 * `workerData.forceJpegJs` exists so the fallback path can be tested without a machine where GDI+
 * is broken; production never sets it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { createJpegEncoder, gdiplusProblem } from './gdiplus.mjs';

const quality = Number(workerData?.quality ?? 75);
const forceJpegJs = Boolean(workerData?.forceJpegJs);
/** MessagePort to the capture worker: frames in, spent buffers back. */
const frames = workerData.port;

let encoder = null;
let reportedFallback = false;

function reportFallback(detail) {
  if (reportedFallback) return;
  reportedFallback = true;
  parentPort.postMessage({ kind: 'problem', detail: 'native-encoder-unavailable' });
  parentPort.postMessage({ kind: 'log', message: `JPEG encoder fallback: jpeg-js (${detail})` });
}

if (forceJpegJs) {
  reportFallback('forced by workerData');
} else {
  try {
    encoder = createJpegEncoder(quality);
  } catch (error) {
    encoder = null;
    reportFallback(error?.message ?? String(error));
  }
  if (!encoder) reportFallback(gdiplusProblem() || 'gdiplus-unavailable');
}

parentPort.postMessage({ kind: 'ready', role: 'encoder', gdiplus: encoder !== null });

/** jpeg-js wants RGBA; the frame is BGRA. Copy so the buffer the capture worker reuses keeps BGRA. */
function jpegJs(bgra, width, height) {
  const rgba = Uint8Array.from(bgra);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const blue = rgba[offset];
    rgba[offset] = rgba[offset + 2];
    rgba[offset + 2] = blue;
  }
  return Buffer.from(jpeg.encode({ data: rgba, width, height }, quality).data);
}

frames.on('message', (message) => {
  if (!message || typeof message.seq !== 'number') return;
  const { seq, pixels, width, height, capturedAt } = message;
  const bgra = new Uint8Array(pixels);
  const started = performance.now();
  let bytes = null;
  if (encoder) {
    try {
      bytes = encoder.encode(bgra, width, height);
    } catch (error) {
      encoder = null;
      reportFallback(error?.message ?? String(error));
    }
  }
  if (!bytes) bytes = jpegJs(bgra, width, height);
  const encodeMs = +(performance.now() - started).toFixed(1);
  parentPort.postMessage({ kind: 'frame', seq, jpeg: bytes, width, height, capturedAt, encodeMs });
  frames.postMessage({ buffer: pixels }, [pixels]);
});
