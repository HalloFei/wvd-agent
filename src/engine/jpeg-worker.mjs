/**
 * The engine's JPEG encoder thread. Frames arrive from the capture worker on a MessagePort; encoded
 * frames go to the protocol thread on `parentPort`. GDI+ is the encoder; `jpeg-js` is the fallback,
 * and a fallback is never silent — it posts `native-encoder-unavailable`, which the child forwards
 * as `engineProblem` so a session cannot time a QTE on a 5 fps path without being told (R23).
 *
 * The perception path is untouched here: a frame with no snapshot pending is encoded at its native
 * size. When the child asks for a downscaled snapshot (`{ op: 'snapshot', snapshotId, maxWidth }`),
 * exactly one following frame is box-filtered before encoding, and the snapshot reply carries the
 * size of the JPEG it actually encoded. The scaling happens over the BGRA buffer, not the JPEG, and
 * `scale.mjs` is a pure module so the arithmetic is unit-tested without a window (contracts §5).
 *
 * `workerData.forceJpegJs` exists so the fallback path can be tested without a machine where GDI+
 * is broken; production never sets it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { createJpegEncoder, gdiplusProblem } from './gdiplus.mjs';
import { scaleBgra } from './scale.mjs';

const quality = Number(workerData?.quality ?? 75);
const forceJpegJs = Boolean(workerData?.forceJpegJs);
/** MessagePort to the capture worker: frames in, spent buffers back. */
const frames = workerData.port;

let encoder = null;
let reportedFallback = false;
/**
 * Downscaled snapshots waiting for a frame. One directive is consumed per frame; the protocol thread
 * serializes capture requests, but a queue rather than a slot means a slow reply cannot overwrite a
 * second request. A `snapshotId: null` directive clears the queue (a timed-out request cancelling).
 */
const pendingSnapshots = [];

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

/** Encode BGRA with GDI+, falling back to jpeg-js; the buffer is only read, never kept. */
function encodeFrame(bgra, width, height) {
  if (encoder) {
    try {
      return encoder.encode(bgra, width, height);
    } catch (error) {
      encoder = null;
      reportFallback(error?.message ?? String(error));
    }
  }
  return jpegJs(bgra, width, height);
}

/** The protocol thread asked for a downscaled JPEG of a following frame, or cancelled one. */
parentPort.on('message', (message) => {
  if (!message || message.op !== 'snapshot') return;
  if (message.snapshotId === null || message.snapshotId === undefined) {
    pendingSnapshots.length = 0; // the request timed out: do not scale a frame nobody will read
    return;
  }
  pendingSnapshots.push({ snapshotId: message.snapshotId, maxWidth: message.maxWidth });
});

frames.on('message', (message) => {
  if (!message || typeof message.seq !== 'number') return;
  const { seq, pixels, width, height, capturedAt } = message;
  const bgra = new Uint8Array(pixels);

  const started = performance.now();
  const bytes = encodeFrame(bgra, width, height);
  const encodeMs = +(performance.now() - started).toFixed(1);
  parentPort.postMessage({ kind: 'frame', seq, jpeg: bytes, width, height, capturedAt, encodeMs });

  // The snapshot is scaled from the same BGRA the loop's frame just used, before the buffer goes
  // back to the capture worker. A snapshot is the only thing that ever pays this cost.
  const request = pendingSnapshots.shift();
  if (request) {
    try {
      const scaleStarted = performance.now();
      const scaled = scaleBgra(bgra, width, height, request.maxWidth);
      const scaleMs = +(performance.now() - scaleStarted).toFixed(1);
      const scaledStarted = performance.now();
      const scaledBytes = encodeFrame(scaled.pixels, scaled.width, scaled.height);
      const scaledEncodeMs = +(performance.now() - scaledStarted).toFixed(1);
      parentPort.postMessage({
        kind: 'snapshot',
        snapshotId: request.snapshotId,
        seq,
        jpeg: scaledBytes,
        width: scaled.width,
        height: scaled.height,
        capturedAt,
        scaleMs,
        encodeMs: scaledEncodeMs,
      });
    } catch (error) {
      parentPort.postMessage({
        kind: 'snapshot-problem',
        snapshotId: request.snapshotId,
        detail: `snapshot-failed: ${error?.message ?? error}`,
      });
    }
  }

  frames.postMessage({ buffer: pixels }, [pixels]);
});
