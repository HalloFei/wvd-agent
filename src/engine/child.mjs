#!/usr/bin/env node
/**
 * The engine child. Plain ESM (R9): the World ships raw TypeScript and is loaded by the host's
 * tsx, but this process is spawned with `process.execPath` and inherits none of that, so it must
 * start under both a plain `node` and `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * This file is the protocol thread only: it speaks contracts §5 over stdin/stdout, pumps the global
 * stop hotkey, and sends input. Rendering runs on two workers — a capture thread (PrintWindow and
 * the client-area DIB) feeding a JPEG encoder thread over a MessagePort (R20a) — so a tap never
 * queues behind a render. The newest encoded frame is all this thread keeps; `capture` answers from
 * it with `ageMs`, and a frame older than three ticks is `timeout` (R11).
 *
 * Input is measured, not guessed: `tap`/`key` replies carry `{ inputMs }`, request receipt to the
 * final `SendInput` (R20b). A failed stop-hotkey registration and a JPEG fallback are `engineProblem`
 * events, never silent (R13, R23).
 */
import { MessageChannel, Worker } from 'node:worker_threads';
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

let stopping = false;
let latest = null; // { jpeg: Buffer, width, height, capturedAt }

// Two render threads, connected to each other: the capture worker sends pixels on this channel and
// the encoder worker returns the spent buffers on it. Only JPEGs reach this thread.
const channel = new MessageChannel();
const captureWorker = new Worker(new URL('./capture-worker.mjs', import.meta.url), {
  workerData: { title, port: channel.port1 },
  transferList: [channel.port1],
});
const encoderWorker = new Worker(new URL('./jpeg-worker.mjs', import.meta.url), {
  workerData: { quality, port: channel.port2 },
  transferList: [channel.port2],
});

function onWorkerMessage(message) {
  if (!message) return;
  switch (message.kind) {
    case 'frame':
      latest = {
        jpeg: Buffer.from(message.jpeg),
        width: message.width,
        height: message.height,
        capturedAt: message.capturedAt,
      };
      return;
    case 'problem':
      write(encodeEvent({ kind: 'engineProblem', detail: message.detail }));
      return;
    case 'log':
      log(message.message);
      return;
    case 'ready':
      log(`worker ${message.role} ready (node=${message.node ?? process.version}${message.role === 'encoder' ? `, gdiplus=${message.gdiplus}` : ''})`);
      return;
    default:
  }
}

captureWorker.on('message', onWorkerMessage);
encoderWorker.on('message', onWorkerMessage);
for (const [name, worker] of [['capture', captureWorker], ['encoder', encoderWorker]]) {
  worker.on('error', (error) => {
    log(`${name} worker failed: ${error?.stack ?? error}`);
    shutdown(1);
  });
  worker.on('exit', (code) => {
    if (stopping) return;
    log(`${name} worker exited (${code})`);
    shutdown(1);
  });
}

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

log(`ready node=${process.version} title="${title}" hotkey=${hotkeyState} quality=${quality}`);

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

async function dispatch(request, receivedAt) {
  switch (request.op) {
    case 'foreground': {
      const hwnd = win32.findWindow(title);
      return { foreground: hwnd !== 0 && win32.isForeground(hwnd) };
    }
    case 'capture': {
      // demand wakes the render threads; the reply still comes from the newest frame
      captureWorker.postMessage({ op: 'demand' });
      if (!win32.findWindow(title)) throw new EngineFailure('unavailable', 'window-not-found');
      if (!latest) throw new EngineFailure('timeout', 'no-frame');
      const jpeg = latest.jpeg.toString('base64');
      const ageMs = performance.now() - latest.capturedAt;
      if (isStaleFrame(ageMs)) throw new EngineFailure('timeout', 'stale-frame');
      return { jpeg, width: latest.width, height: latest.height, ageMs };
    }
    case 'tap': {
      await win32.tap(requireWindow(), request.x, request.y, request.count);
      return { inputMs: performance.now() - receivedAt };
    }
    case 'key': {
      await win32.holdKey(requireWindow(), request.scan, request.holdMs);
      return { inputMs: performance.now() - receivedAt };
    }
    default:
      throw new EngineFailure('unavailable', 'unknown-op');
  }
}

async function handle(id, request, receivedAt) {
  try {
    write(encodeReply({ id, ok: true, value: await dispatch(request, receivedAt) }));
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
    const receivedAt = performance.now();
    const message = decodeLine(line);
    if (!message || !('request' in message)) {
      log('dropped a malformed line');
      continue;
    }
    const { id, request } = message.request;
    queue = queue.then(() => handle(id, request, receivedAt));
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
  for (const worker of [captureWorker, encoderWorker]) {
    try {
      worker.postMessage({ op: 'stop' });
    } catch {
      // worker already gone
    }
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }
  try {
    win32.unregisterStopHotkey();
  } catch {
    // the process is going away; the OS releases the hotkey with it
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
