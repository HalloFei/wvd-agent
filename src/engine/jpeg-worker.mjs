/**
 * The engine's JPEG encoder thread. Frames arrive from the capture worker on a MessagePort; encoded
 * frames go to the protocol thread on `parentPort`. GDI+ is the encoder; `jpeg-js` is the fallback,
 * and a fallback is never silent — it posts `native-encoder-unavailable`, which the child forwards
 * as `engineProblem` so a session cannot time a QTE on a 5 fps path without being told (R23).
 *
 * The perception path is untouched here: a frame with no variant pending is encoded at its native
 * size. The child can ask for one frame variant (`{ op: 'snapshot', snapshotId, maxWidth?, crop? }`):
 * exactly one following frame is either box-filtered down (`maxWidth`) or copied to one rectangle
 * (`crop`) before encoding, and the reply carries the size of the JPEG it actually encoded — plus,
 * for a crop, the rectangle it used. Both transformations happen over the BGRA buffer, not the JPEG,
 * and `scale.mjs`/`crop.mjs` are pure modules so the arithmetic is unit-tested without a window
 * (contracts §5).
 *
 * `workerData.forceJpegJs` exists so the fallback path can be tested without a machine where GDI+
 * is broken; production never sets it.
 */
import { parentPort, workerData } from 'node:worker_threads';
import jpeg from 'jpeg-js';
import { cropBgra } from './crop.mjs';
import { createJpegEncoder, gdiplusProblem } from './gdiplus.mjs';
import { scaleBgra } from './scale.mjs';

const quality = Number(workerData?.quality ?? 75);
const forceJpegJs = Boolean(workerData?.forceJpegJs);
/** MessagePort to the capture worker: frames in, spent buffers back. */
const frames = workerData.port;

let encoder = null;
let reportedFallback = false;
/**
 * Frame variants waiting for a frame. One directive is consumed per frame; the protocol thread
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

/** The protocol thread asked for a downscaled or cropped JPEG of a following frame, or cancelled one. */
parentPort.on('message', (message) => {
  if (!message || message.op !== 'snapshot') return;
  if (message.snapshotId === null || message.snapshotId === undefined) {
    pendingSnapshots.length = 0; // the request timed out: do not scale or crop a frame nobody will read
    return;
  }
  pendingSnapshots.push({
    snapshotId: message.snapshotId,
    maxWidth: message.maxWidth,
    crop: message.crop,
  });
});

/**
 * Copy `request.crop` out of the frame, then encode only the copy, so a QTE sample decodes a band
 * rather than all of a 1920x1080 frame. The frame-fit check is the child's, because only it knows the
 * frame; a rect that still does not copy is reported on the existing failure channel with the same
 * detail, never answered with the whole frame.
 */
function replyWithCrop(request, bgra, width, height, seq, capturedAt) {
  const cropStarted = performance.now();
  let cropped;
  try {
    cropped = cropBgra(bgra, width, height, request.crop);
  } catch {
    parentPort.postMessage({
      kind: 'snapshot-problem',
      snapshotId: request.snapshotId,
      detail: 'crop-out-of-frame',
    });
    return;
  }
  const cropMs = +(performance.now() - cropStarted).toFixed(1);
  try {
    const encodeStarted = performance.now();
    const bytes = encodeFrame(cropped.pixels, cropped.width, cropped.height);
    const encodeMs = +(performance.now() - encodeStarted).toFixed(1);
    parentPort.postMessage({
      kind: 'snapshot',
      snapshotId: request.snapshotId,
      seq,
      jpeg: bytes,
      width: cropped.width,
      height: cropped.height,
      capturedAt,
      cropMs,
      encodeMs,
      // the rectangle actually used, which the protocol thread states in its reply
      crop: { x: request.crop.x, y: request.crop.y, width: cropped.width, height: cropped.height },
    });
  } catch (error) {
    parentPort.postMessage({
      kind: 'snapshot-problem',
      snapshotId: request.snapshotId,
      detail: `snapshot-failed: ${error?.message ?? error}`,
    });
  }
}

frames.on('message', (message) => {
  if (!message || typeof message.seq !== 'number') return;
  const { seq, pixels, width, height, capturedAt } = message;
  const bgra = new Uint8Array(pixels);

  const started = performance.now();
  const bytes = encodeFrame(bgra, width, height);
  const encodeMs = +(performance.now() - started).toFixed(1);
  parentPort.postMessage({ kind: 'frame', seq, jpeg: bytes, width, height, capturedAt, encodeMs });

  // The variant is produced from the same BGRA the loop's frame just used, before the buffer goes
  // back to the capture worker. A variant request is the only thing that ever pays this cost.
  const request = pendingSnapshots.shift();
  if (request) {
    if (request.crop) {
      replyWithCrop(request, bgra, width, height, seq, capturedAt);
    } else {
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
  }

  frames.postMessage({ buffer: pixels }, [pixels]);
});
