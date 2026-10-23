/**
 * The engine's render thread: it owns the window (PrintWindow, BitBlt, the DIB surfaces) and hands
 * frames to the encoder worker over a MessagePort. The protocol thread stays free to answer input
 * immediately, which is R20a's whole point.
 *
 * The loop is gated on demand: it only renders while a `capture` request has arrived within the last
 * three ticks (300 ms at the default). A World that stops asking stops the 30 fps render instead of
 * burning the farmer's machine, and the next request wakes it.
 *
 * Buffers — not pixel pointers — move between the workers: a worker's native memory is not part of
 * the message contract, and the encoder must own the bytes it reads. The encoder returns each buffer
 * on the same port, so a steady-state frame allocates nothing but the JPEG.
 */
import { parentPort, workerData } from 'node:worker_threads';
import * as win32 from './win32-native.mjs';

const title = workerData.title;
/** MessagePort to the encoder worker: frames out, spent buffers back. */
const frames = workerData.port;
const MAX_IN_FLIGHT = 2;
const DEMAND_MS = 300;

// no demand yet: the first capture request starts the engine, not process start
let lastDemandAt = Number.NEGATIVE_INFINITY;
let stopping = false;
let nextSeq = 0;
let inFlight = 0;
let lastErrorLog = 0;
const free = [];

const log = (message) => parentPort.postMessage({ kind: 'log', message });

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
  if (inFlight >= MAX_IN_FLIGHT) {
    setTimeout(captureLoop, 1);
    return;
  }
  const capturedAt = performance.now();
  let frame;
  try {
    frame = win32.captureClient(hwnd, free.pop() ?? null);
  } catch (error) {
    const at = performance.now();
    if (at - lastErrorLog > 5000) {
      log(`capture: ${error?.message ?? error}`);
      lastErrorLog = at;
    }
    setTimeout(captureLoop, 50);
    return;
  }
  inFlight++;
  frames.postMessage(
    { seq: nextSeq++, pixels: frame.bgra.buffer, width: frame.width, height: frame.height, capturedAt },
    [frame.bgra.buffer],
  );
  setImmediate(captureLoop);
}

frames.on('message', (message) => {
  if (!message || !message.buffer) return;
  free.push(new Uint8Array(message.buffer));
  inFlight = Math.max(0, inFlight - 1);
});

parentPort.on('message', (message) => {
  if (message && message.op === 'demand') lastDemandAt = performance.now();
  if (message && message.op === 'stop') {
    stopping = true;
    try {
      win32.releaseCaptureSurface();
    } finally {
      process.exit(0);
    }
  }
});

parentPort.postMessage({ kind: 'ready', role: 'capture', node: process.version });
setImmediate(captureLoop);
