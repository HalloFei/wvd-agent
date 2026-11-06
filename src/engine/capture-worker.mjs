/**
 * The engine's render thread: it owns the window (PrintWindow, BitBlt, the DIB surfaces), and it is the
 * process that publishes **raw BGRA frames into the shared channel** — there is no encoder in the
 * child any more, and the protocol thread only hears that a frame was published (the vision module,
 * contracts §5).
 *
 * The loop is gated on demand: it only renders while a `capture` request has arrived within the last
 * three ticks (300 ms at the default). A World that stops asking stops the 30 fps render instead of
 * burning the farmer's machine, and the next request wakes it.
 *
 * One frame buffer is reused: `publish` copies the pixels into the mapping and returns, so the next
 * capture can overwrite the buffer. A frame that is not the channel's size is never published — the
 * reader's slots are the window's size, and a slot holding another size is a frame nobody can parse.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openChannel } from './vision/channel.mjs';
import * as win32 from './win32-native.mjs';

const title = workerData.title;
const channelName = workerData.channelName ?? '';
const channelBytes = workerData.channelBytes ?? 0;
const DEMAND_MS = 300;

// no demand yet: the first capture request starts the engine, not process start
let lastDemandAt = Number.NEGATIVE_INFINITY;
let stopping = false;
let lastErrorLog = 0;
let buffer = null;
let channel = null;
let lastMismatch = '';

const log = (message) => parentPort.postMessage({ kind: 'log', message });

if (channelName && channelBytes > 0) {
  try {
    channel = openChannel(channelName, channelBytes);
    log(`channel ready: ${channel.name} ${channel.layout.width}x${channel.layout.height} ${channel.layout.slots} slots`);
  } catch (error) {
    // A channel this child cannot open is a capture it cannot serve; say why, never crash silently.
    log(`channel unusable: ${error?.message ?? error}`);
  }
} else {
  log('channel: no --channel was given, so nothing can be captured');
}

function captureLoop() {
  if (stopping) return;
  const now = performance.now();
  if (now - lastDemandAt > DEMAND_MS) {
    // no capture request within three ticks: stop rendering, keep the thread ready
    setTimeout(captureLoop, 50);
    return;
  }
  const hwnd = win32.findWindow(title);
  if (!hwnd) {
    setTimeout(captureLoop, 100);
    return;
  }
  if (channel === null) {
    setTimeout(captureLoop, 100);
    return;
  }
  const capturedAtMs = Date.now();
  let frame;
  try {
    frame = win32.captureClient(hwnd, buffer);
  } catch (error) {
    const at = performance.now();
    if (at - lastErrorLog > 5000) {
      log(`capture: ${error?.message ?? error}`);
      lastErrorLog = at;
    }
    setTimeout(captureLoop, 50);
    return;
  }
  // The buffer is ours again as soon as publish() returns: it copied the pixels into the mapping.
  buffer = frame.bgra;
  const layout = channel.layout;
  if (frame.width !== layout.width || frame.height !== layout.height) {
    const size = `${frame.width}x${frame.height}`;
    if (lastMismatch !== size) {
      lastMismatch = size;
      log(`capture: ${size} does not fit the ${layout.width}x${layout.height} channel, not publishing`);
    }
    setTimeout(captureLoop, 100);
    return;
  }
  lastMismatch = '';
  let published;
  try {
    published = channel.publish(frame.bgra, capturedAtMs);
  } catch (error) {
    const at = performance.now();
    if (at - lastErrorLog > 5000) {
      log(`publish: ${error?.message ?? error}`);
      lastErrorLog = at;
    }
    setTimeout(captureLoop, 50);
    return;
  }
  // The protocol thread keeps this frame's metadata and answers `capture` from it.
  parentPort.postMessage({
    kind: 'published',
    seq: published.seq,
    capturedAtMs,
    width: frame.width,
    height: frame.height,
  });
  setImmediate(captureLoop);
}

parentPort.on('message', (message) => {
  if (message && message.op === 'demand') lastDemandAt = performance.now();
  if (message && message.op === 'stop') {
    stopping = true;
    try {
      win32.releaseCaptureSurface();
    } finally {
      if (channel !== null) {
        try {
          channel.dispose();
        } catch {
          // the process is going away; the OS drops the view with it
        }
      }
      process.exit(0);
    }
  }
});

parentPort.postMessage({
  kind: 'ready',
  role: 'capture',
  node: process.version,
  channel: channel === null ? null : channel.name,
});
setImmediate(captureLoop);
