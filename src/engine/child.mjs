#!/usr/bin/env node
/**
 * The engine child. Plain ESM (R9): the World ships raw TypeScript and is loaded by the host's
 * tsx, but this process is spawned with `process.execPath` and inherits none of that, so it must
 * start under both a plain `node` and `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * This file is the protocol thread only: it speaks contracts §5 over stdin/stdout, pumps the global
 * stop hotkey, and sends input. Rendering runs on one worker (PrintWindow and the client-area DIB)
 * that publishes each frame into the shared frame channel named by `--channel`, so a tap never
 * queues behind a render. The protocol thread keeps the newest frame's **metadata** — `{ seq,
 * capturedAtMs, width, height }` — and `capture` answers with it plus `ageMs`; the pixels never
 * travel on the pipe, and there is no encoder in this process (the vision module, 2026-11-07).
 *
 * A frame older than three ticks is `timeout` (R11), and a `capture` request wakes the render
 * thread, which stops on its own after three idle ticks. The protocol thread touches the channel's
 * heartbeat on a short timer so the supervisor can tell "idle" from "dead": the render loop stopping
 * is not a dead child.
 *
 * Input is measured, not guessed: `tap`/`key` replies carry `{ inputMs }`, request receipt to the
 * final `SendInput` (R20b). A failed stop-hotkey registration is an `engineProblem` event, never
 * silent (R13).
 */
import { Worker } from 'node:worker_threads';
import { inputAcknowledgement } from './gestures.mjs';
import { decodeLine, encodeEvent, encodeReply, isStaleFrame, LineDecoder } from './protocol.mjs';
import { openChannel } from './vision/channel.mjs';
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
const channelName = option('channel', '');
const channelBytes = Number(option('channel-bytes', '0')) || 0;

const log = (message) => process.stderr.write(`[wvd-engine] ${message}\n`);
const write = (line) => {
  try {
    process.stdout.write(line);
  } catch {
    // the parent is gone; stdin will end or the process will be killed
  }
};

let stopping = false;
/** The newest published frame's metadata: `{ seq, capturedAtMs, width, height }`. No pixels. */
let latest = null;
/** Capture requests waiting for a publish stamped at or after their own request. */
const publishWaiters = new Set();

/**
 * How long the child looks again after `SetForegroundWindow` did not take on the first check. The
 * activation can land a frame or two later; one immediate check would report a refusal the World
 * would believe. The World retries with its own buffer after a refused attempt.
 */
const FOCUS_RECHECK_MS = 120;

/**
 * How often the protocol thread proves it is alive in the channel. `capturedAtMs` doubles as the
 * heartbeat on every publish; the render thread stops when nothing demands frames, so an idle child
 * must still move the clock or the World's supervisor would restart a healthy process.
 */
const HEARTBEAT_MS = 250;

/**
 * How long one `capture` may wait for the frame its own demand produced. The render loop wakes in a
 * frame or two of a demand and publishes within ~30 ms; a second is the hold the World's stale rule
 * never sees, because the World stamps the reply it gets and a hung render is `stale-frame`.
 */
const CAPTURE_WAIT_MS = 1_000;

// The first capture request ever waits for the render thread to produce a frame (bounded), so
// startup is not a spurious `timeout`. The timer is cleared when the frame wins, and later requests
// never wait: a render-hung child must not charge 500 ms to every serialized request.
let firstFrameSeen = false;
let resolveFirstFrame;
const firstFrame = new Promise((resolve) => { resolveFirstFrame = resolve; });
const warmup = new Promise((resolve) => {
  const timer = setTimeout(resolve, 500);
  firstFrame.then(() => {
    clearTimeout(timer);
    resolve();
  });
});
let firstCaptureRequested = false;

// The protocol thread's own handle on the channel: it writes the heartbeat and nothing else. The
// writer that publishes pixels is the render worker's handle (each thread opens the region itself).
let channel = null;
if (channelName && channelBytes > 0) {
  try {
    channel = openChannel(channelName, channelBytes);
  } catch (error) {
    log(`channel unusable: ${error?.message ?? error}`);
  }
}

const captureWorker = new Worker(new URL('./capture-worker.mjs', import.meta.url), {
  workerData: { title, channelName, channelBytes },
});

function onWorkerMessage(message) {
  if (!message) return;
  switch (message.kind) {
    case 'published':
      latest = {
        seq: message.seq,
        capturedAtMs: message.capturedAtMs,
        width: message.width,
        height: message.height,
      };
      if (!firstFrameSeen) {
        firstFrameSeen = true;
        resolveFirstFrame();
      }
      // A capture request is answered with the frame its own demand produced, never with the frame
      // the previous demand left behind (live 2026-11-07: that frame was stale by the time it arrived).
      for (const waiter of publishWaiters) {
        if (message.capturedAtMs >= waiter.sinceMs) {
          publishWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(latest);
        }
      }
      return;
    case 'problem':
      write(encodeEvent({ kind: 'engineProblem', detail: message.detail }));
      return;
    case 'log':
      log(message.message);
      return;
    case 'ready':
      log(`worker ${message.role} ready (node=${message.node ?? process.version})`);
      return;
    default:
  }
}

captureWorker.on('message', onWorkerMessage);
captureWorker.on('error', (error) => {
  log(`capture worker failed: ${error?.stack ?? error}`);
  shutdown(1);
});
captureWorker.on('exit', (code) => {
  if (stopping) return;
  log(`capture worker exited (${code})`);
  shutdown(1);
});

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

log(`ready node=${process.version} title="${title}" hotkey=${hotkeyState} channel=${channel === null ? 'none' : channelName}`);

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
    case 'focus': {
      const hwnd = requireWindow();
      if (win32.focusWindow(hwnd)) return { foreground: true };
      await new Promise((resolve) => setTimeout(resolve, FOCUS_RECHECK_MS));
      return { foreground: win32.isForeground(hwnd) };
    }
    case 'capture': {
      // demand wakes the render thread; the reply still comes from the newest published frame
      captureWorker.postMessage({ op: 'demand' });
      if (!win32.findWindow(title)) throw new EngineFailure('unavailable', 'window-not-found');
      if (!latest && !firstCaptureRequested) {
        firstCaptureRequested = true;
        await warmup;
      }
      if (!latest) throw new EngineFailure('timeout', 'no-frame');
      // The frame this request woke, not the one the previous demand left: the render loop stops
      // 300 ms after the last demand, and the old frame is stale by the time the next tick asks.
      const sinceMs = Date.now();
      const frame = await new Promise((resolve, reject) => {
        const waiter = {
          sinceMs,
          resolve,
          timer: setTimeout(() => {
            publishWaiters.delete(waiter);
            reject(new EngineFailure('timeout', 'stale-frame'));
          }, CAPTURE_WAIT_MS),
        };
        publishWaiters.add(waiter);
        if (latest.capturedAtMs >= sinceMs) {
          publishWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          resolve(latest);
        }
      });
      // The channel's own clock is Date.now(): the child and the World do not share a monotonic one.
      const ageMs = Date.now() - frame.capturedAtMs;
      if (isStaleFrame(ageMs)) throw new EngineFailure('timeout', 'stale-frame');
      // metadata only: the World reads the pixels from the slot `seq` names
      return { seq: frame.seq, width: frame.width, height: frame.height, ageMs };
    }
    case 'tap': {
      await win32.tap(requireWindow(), request.x, request.y, request.count);
      return inputAcknowledgement(receivedAt);
    }
    case 'key': {
      await win32.holdKey(requireWindow(), request.scan, request.holdMs);
      return inputAcknowledgement(receivedAt);
    }
    case 'drag': {
      await win32.drag(requireWindow(), request.x1, request.y1, request.x2, request.y2, request.durationMs);
      return inputAcknowledgement(receivedAt);
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

// The supervisor's liveness signal: an idle render loop (no demand) must not look like a dead child.
const heartbeat = channel === null ? null : setInterval(() => {
  try {
    channel.heartbeat(Date.now());
  } catch (error) {
    log(`heartbeat: ${error?.message ?? error}`);
  }
}, HEARTBEAT_MS);
heartbeat?.unref?.();

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearInterval(pump);
  if (heartbeat !== null) clearInterval(heartbeat);
  try {
    // holdKey cancellation: a key or button still down is released before the process goes away
    win32.releaseHeld();
  } catch {
    // nothing is held, or the device is already gone
  }
  try {
    captureWorker.postMessage({ op: 'stop' });
  } catch {
    // worker already gone
  }
  try {
    captureWorker.terminate();
  } catch {
    // already gone
  }
  try {
    win32.unregisterStopHotkey();
  } catch {
    // the process is going away; the OS releases the hotkey with it
  }
  if (channel !== null) {
    try {
      channel.dispose();
    } catch {
      // the OS drops the view with the process
    }
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
    win32.releaseHeld();
  } catch {
    // nothing to release
  }
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
