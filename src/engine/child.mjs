#!/usr/bin/env node
/**
 * The engine child. Plain ESM (R9): the World ships raw TypeScript and is loaded by the host's
 * tsx, but this process is spawned with `process.execPath` and inherits none of that, so it must
 * start under both a plain `node` and `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * It owns every Win32 call (./win32-native.mjs), speaks contracts §5 over stdin/stdout — one JSON
 * message per line, never raw BGRA — and pumps the thread message queue on a timer so the global
 * stop hotkey is serviced beside the protocol loop (R3).
 *
 * Capture runs on its own cadence (R11): the loop keeps the newest encoded frame and `capture`
 * requests answer from that slot immediately, reporting how old it is. A frame older than three
 * ticks is `timeout` instead, because a stale frame that looks fresh is how a QTE tap lands in the
 * hazard gap. JPEG encoding happens on a worker thread (./jpeg-worker.mjs) so capture and encode
 * overlap; this thread only renders and copies.
 *
 * Requests are handled one at a time, in arrival order: there is one window and one input stream,
 * and two overlapping inputs have no meaning. A request that the queue cannot answer in time is
 * the parent's `timeout`; the child never invents one.
 */
import { Worker } from 'node:worker_threads';
import { decodeLine, encodeEvent, encodeReply, isStaleFrame, LineDecoder } from './protocol.mjs';
import * as win32 from './win32-native.mjs';

/** A failure the child can name; anything else becomes `unavailable` with its message. */
class EngineFailure extends Error {
  constructor(error, detail) {
    super(detail ?? error);
    this.name = 'EngineFailure';
    this.error = error;
    this.detail = detail;
  }
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

const title = option('title', 'WizardryVariantsDaphne');
const hotkey = option('hotkey', 'Ctrl+Alt+W');
const quality = Math.min(95, Math.max(30, Number(option('quality', '75')) || 75));

const log = (message) => process.stderr.write(`[wvd-engine] ${message}\n`);
const write = (line) => {
  try {
    process.stdout.write(line);
  } catch {
    // the parent is gone; stdin will end or the process will be killed
  }
};

// A hotkey that cannot be registered must not take the engine down with it, but the World must know
// the emergency stop does not exist (R13): it reports `engineProblem` and Task 10 stops the session.
let hotkeyState = 'off';
if (hotkey) {
  const registered = win32.registerStopHotkey(hotkey);
  hotkeyState = registered.ok ? hotkey : `failed(${registered.detail})`;
  if (!registered.ok) {
    log(`stop hotkey ${hotkey} not registered: ${registered.detail}`);
    write(encodeEvent({ kind: 'engineProblem', detail: 'stop-hotkey-unregistered' }));
  }
}

// ---------------------------------------------------------------------------------------------
// Continuous capture: the newest encoded frame is all the World ever gets, and its age is reported.

let latest = null; // { jpeg: Buffer, width, height, capturedAt }
let stopping = false;
let nextSeq = 0;
let inFlight = 0;
const capturedAtBySeq = new Map();
const freeBuffers = [];
const MAX_IN_FLIGHT = 2;

const encoder = new Worker(new URL('./jpeg-worker.mjs', import.meta.url), { workerData: { quality } });
encoder.on('message', (message) => {
  if (!message) return;
  if (message.kind === 'log') {
    log(message.message);
    return;
  }
  if ('ready' in message) return;
  if (typeof message.seq !== 'number') return;
  const capturedAt = capturedAtBySeq.get(message.seq);
  capturedAtBySeq.delete(message.seq);
  inFlight = Math.max(0, inFlight - 1);
  if (capturedAt !== undefined) {
    latest = { jpeg: Buffer.from(message.jpeg), width: message.width, height: message.height, capturedAt };
  }
  if (message.pixels) {
    freeBuffers.push(new Uint8Array(message.pixels));
    if (freeBuffers.length > MAX_IN_FLIGHT) freeBuffers.shift();
  }
});
encoder.on('error', (error) => {
  log(`encoder failed: ${error?.stack ?? error}`);
  shutdown(1);
});
encoder.on('exit', (code) => {
  if (stopping) return;
  log(`encoder exited (${code})`);
  shutdown(1);
});

let lastCaptureLog = 0;

function captureLoop() {
  if (stopping) return;
  const hwnd = win32.findWindow(title);
  if (!hwnd) {
    // the game is not up yet; keep the engine alive and let capture age out to `timeout`
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
    frame = win32.captureClient(hwnd, freeBuffers.pop() ?? null);
  } catch (error) {
    if (capturedAt - lastCaptureLog > 5000) {
      log(`capture: ${error?.message ?? error}`);
      lastCaptureLog = capturedAt;
    }
    setTimeout(captureLoop, 50);
    return;
  }
  if (stopping) return;
  const seq = nextSeq++;
  capturedAtBySeq.set(seq, capturedAt);
  inFlight++;
  // the pixels move to the encoder thread; they come back with the JPEG
  encoder.postMessage({ seq, pixels: frame.bgra.buffer, width: frame.width, height: frame.height }, [frame.bgra.buffer]);
  setImmediate(captureLoop);
}

log(`ready node=${process.version} title="${title}" hotkey=${hotkeyState} quality=${quality}`);
setImmediate(captureLoop);

// ---------------------------------------------------------------------------------------------
// Protocol loop

function failureReply(id, error) {
  if (error instanceof win32.Refused) return { id, ok: false, error: 'rejected', detail: error.detail };
  if (error instanceof EngineFailure) {
    return error.detail === undefined
      ? { id, ok: false, error: error.error }
      : { id, ok: false, error: error.error, detail: error.detail };
  }
  return { id, ok: false, error: 'unavailable', detail: String(error?.message ?? error) };
}

/** Throws a named failure when the window is not on screen; input needs it. */
function requireWindow() {
  const hwnd = win32.findWindow(title);
  if (!hwnd) throw new EngineFailure('unavailable', 'window-not-found');
  return hwnd;
}

async function dispatch(request) {
  switch (request.op) {
    case 'foreground': {
      const hwnd = win32.findWindow(title);
      return { foreground: hwnd !== 0 && win32.isForeground(hwnd) };
    }
    case 'capture': {
      if (!win32.findWindow(title)) throw new EngineFailure('unavailable', 'window-not-found');
      if (!latest) throw new EngineFailure('timeout', 'no-frame');
      const jpeg = latest.jpeg.toString('base64');
      const ageMs = performance.now() - latest.capturedAt;
      if (isStaleFrame(ageMs)) throw new EngineFailure('timeout', 'stale-frame');
      return { jpeg, width: latest.width, height: latest.height, ageMs };
    }
    case 'tap':
      await win32.tap(requireWindow(), request.x, request.y, request.count);
      return null;
    case 'key':
      await win32.holdKey(requireWindow(), request.scan, request.holdMs);
      return null;
    default:
      throw new EngineFailure('unavailable', 'unknown-op');
  }
}

async function handle(id, request) {
  try {
    write(encodeReply({ id, ok: true, value: await dispatch(request) }));
  } catch (error) {
    write(encodeReply(failureReply(id, error)));
  }
}

// Requests run in arrival order; the chain is the serialization.
let queue = Promise.resolve();

const decoder = new LineDecoder();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of decoder.push(chunk)) {
    const message = decodeLine(line);
    if (!message || !('request' in message)) {
      log('dropped a malformed line');
      continue;
    }
    const { id, request } = message.request;
    queue = queue.then(() => handle(id, request));
  }
});

// WM_HOTKEY only ever lives in this thread's queue; nothing else pumps it.
const pump = setInterval(() => {
  try {
    if (win32.pollStopHotkey() > 0) write(encodeEvent({ kind: 'stopHotkey' }));
  } catch (error) {
    log(`hotkey pump: ${error?.message ?? error}`);
  }
}, 16);
pump.unref();

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearInterval(pump);
  try {
    encoder.terminate();
  } catch {
    // already gone
  }
  try {
    win32.unregisterStopHotkey();
  } catch {
    // the process is going away; the OS releases the hotkey with it
  }
  try {
    win32.releaseCaptureSurface();
  } catch {
    // nothing left to release
  }
  process.exitCode = code;
  process.stdin.pause();
  // an empty write's callback runs after every reply already queued, so none is truncated
  process.stdout.write('', () => process.exit(code));
}

process.stdout.on('error', () => shutdown(0));
process.stdin.on('end', () => {
  // finish the request in flight, then leave: the parent closed the pipe
  queue.then(() => shutdown(0));
});
process.on('exit', () => {
  try {
    win32.unregisterStopHotkey();
  } catch {
    // nothing to do while exiting
  }
});
process.on('uncaughtException', (error) => {
  log(`fatal: ${error?.stack ?? error}`);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  log(`fatal: ${error?.stack ?? error}`);
  shutdown(1);
});
