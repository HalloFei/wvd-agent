#!/usr/bin/env node
/**
 * The engine child. Plain ESM (R9): the World ships raw TypeScript and is loaded by the host's
 * tsx, but this process is spawned with `process.execPath` and inherits none of that, so it must
 * start under both a plain `node` and `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * It owns every Win32 call (./win32-native.mjs), speaks contracts §5 over stdin/stdout — one JSON
 * message per line, never raw BGRA — and pumps the thread message queue on a timer so the global
 * stop hotkey is serviced beside the protocol loop, not blocked by a capture (R3).
 *
 * Requests are handled one at a time, in arrival order: there is one window and one input stream,
 * and two overlapping inputs have no meaning. A request that the queue cannot answer in time is
 * the parent's `timeout`; the child never invents one.
 */
import jpeg from 'jpeg-js';
import { decodeLine, encodeEvent, encodeReply, LineDecoder } from './protocol.mjs';
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

// A hotkey that cannot be registered must not take the engine down with it; it is logged, and the
// World still gets frames and input. The operator was told about the stop key in the console.
let hotkeyState = 'off';
if (hotkey) {
  const registered = win32.registerStopHotkey(hotkey);
  hotkeyState = registered.ok ? hotkey : `failed(${registered.detail})`;
  if (!registered.ok) log(`stop hotkey ${hotkey} not registered: ${registered.detail}`);
}
log(`ready node=${process.version} title="${title}" hotkey=${hotkeyState}`);

/** JPEG is encoded here, so only bytes plus their size leave the child (design §7.3). */
function frameValue({ width, height, bgra }) {
  for (let offset = 0; offset < bgra.length; offset += 4) {
    const blue = bgra[offset];
    bgra[offset] = bgra[offset + 2];
    bgra[offset + 2] = blue;
  }
  const encoded = jpeg.encode({ data: bgra, width, height }, quality);
  return { jpeg: Buffer.from(encoded.data).toString('base64'), width, height };
}

/** Throws a named failure when the window is not on screen; every op except `foreground` needs it. */
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
    case 'capture':
      return frameValue(win32.capture(requireWindow()));
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

function failureReply(id, error) {
  if (error instanceof win32.Refused) return { id, ok: false, error: 'rejected', detail: error.detail };
  if (error instanceof EngineFailure) {
    return error.detail === undefined
      ? { id, ok: false, error: error.error }
      : { id, ok: false, error: error.error, detail: error.detail };
  }
  return { id, ok: false, error: 'unavailable', detail: String(error?.message ?? error) };
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

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearInterval(pump);
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
