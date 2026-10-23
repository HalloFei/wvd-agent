#!/usr/bin/env node
/**
 * Engine benchmark. Measures the shipped frame path through the real modules, in one runtime and
 * then under Electron-as-Node when it can be found (R22):
 *
 * - capture round trip: World → child protocol, from the request to the reply;
 * - cadence and age: the child's own frame production, inferred from the replies' `ageMs`;
 * - decode: the World-side native GDI+ decode of a real frame (the `toRgba()` path, R19);
 * - encode: the native GDI+ encode of a synthetic 1920×1080 BGRA frame (the worker's path, R12).
 *
 * Usage: node scripts/bench-engine.mjs --title="<window title>" [--frames=120] [--json]
 * The window must already be open; the bench never launches or touches the game. In the JSON mode
 * the Electron run is spawned automatically; set WVD_ELECTRON to point at an electron binary when
 * the checkout layout does not expose one, or the Electron section is skipped with the reason.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJpegEncoder, decodeJpeg, gdiplusProblem } from '../src/engine/gdiplus.mjs';
import { LineDecoder, decodeLine, encodeRequest } from '../src/engine/protocol.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const CHILD = join(ROOT, 'src', 'engine', 'child.mjs');
const SELF = fileURLToPath(import.meta.url);

const args = parseArgs(process.argv.slice(2));
const title = args.title ?? process.env.WVD_BENCH_WINDOW;
const frames = Number(args.frames ?? 120);
const json = Boolean(args.json);

if (!title) {
  console.error('usage: node scripts/bench-engine.mjs --title="<already-open window title>" [--frames=120] [--json]');
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (const argument of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match) continue;
    out[match[1]] = match[2] ?? true;
  }
  return out;
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const round = (value) => +value.toFixed(1);
const stats = (values) => ({
  p50: round(median(values)),
  p90: round(percentile(values, 0.9)),
  max: round(Math.max(...values)),
});

/** A tiny §5 client over stdio, the same codec the World uses. */
function spawnEngine() {
  const child = spawn(process.execPath, [CHILD, `--title=${title}`, '--hotkey='], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { log += chunk; });
  const pending = new Map();
  let nextId = 1;
  const decoder = new LineDecoder();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of decoder.push(chunk)) {
      const message = decodeLine(line);
      if (!message || !('reply' in message)) continue;
      const resolve = pending.get(message.reply.id);
      if (!resolve) continue;
      pending.delete(message.reply.id);
      resolve(message.reply);
    }
  });
  child.on('close', () => {
    for (const resolve of pending.values()) resolve({ id: -1, ok: false, error: 'unavailable', detail: 'engine exited' });
    pending.clear();
  });
  return {
    child,
    log: () => log.trim(),
    request(request) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          resolve({ id, ok: false, error: 'timeout', detail: 'bench timeout' });
        }, 15000);
        pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
        child.stdin.write(encodeRequest(id, request));
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

async function waitForFirstFrame(engine) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const reply = await engine.request({ op: 'capture' });
    if (reply.ok) return reply;
    if (reply.error !== 'timeout') throw new Error(`capture failed: ${reply.error} ${reply.detail ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no frame within 5 s');
}

async function measure() {
  const engine = spawnEngine();
  try {
    const first = await waitForFirstFrame(engine);
    const width = first.value.width;
    const height = first.value.height;

    // capture round trip + age + cadence, on fresh frames
    const roundTrips = [];
    const ages = [];
    const instants = [];
    let lastBytes = Buffer.from(first.value.jpeg, 'base64');
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      const reply = await engine.request({ op: 'capture' });
      const t1 = performance.now();
      if (!reply.ok) continue;
      roundTrips.push(t1 - t0);
      ages.push(reply.value.ageMs);
      const implied = t1 - reply.value.ageMs;
      if (instants.length === 0 || implied - instants[instants.length - 1] > 2) instants.push(implied);
      lastBytes = Buffer.from(reply.value.jpeg, 'base64');
      // pace the samples so the cadence is observed over ~50 distinct frames, not starved by requests
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const intervals = instants.slice(1).map((value, index) => value - instants[index]).filter((value) => value > 0);

    // World-side native decode of a real frame (the toRgba() path)
    const decodeTimes = [];
    let decoded = null;
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      decoded = decodeJpeg(lastBytes);
      decodeTimes.push(performance.now() - t0);
    }

    // native encode of a synthetic 1920×1080 frame (the worker's path)
    const encoder = createJpegEncoder(75);
    if (!encoder) throw new Error(`native encoder unavailable: ${gdiplusProblem()}`);
    const synthetic = new Uint8Array(1920 * 1080 * 4);
    for (let offset = 0; offset < synthetic.length; offset += 4) {
      synthetic[offset] = offset & 0xff;
      synthetic[offset + 1] = (offset >> 8) & 0xff;
      synthetic[offset + 2] = (offset >> 16) & 0xff;
      synthetic[offset + 3] = 255;
    }
    const encodeTimes = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      encoder.encode(synthetic, 1920, 1080);
      encodeTimes.push(performance.now() - t0);
    }

    return {
      runtime: { node: process.version, electron: process.versions.electron ?? null },
      window: { width, height },
      samples: { capture: roundTrips.length, frames: instants.length, decode: decodeTimes.length, encode: encodeTimes.length },
      roundTripMs: stats(roundTrips),
      ageMs: stats(ages),
      cadenceMs: stats(intervals),
      fps: round(1000 / median(intervals)),
      decodeMs: stats(decodeTimes),
      decoded: [decoded.width, decoded.height],
      encodeMs: stats(encodeTimes),
      frameBytes: lastBytes.length,
      gdiplus: gdiplusProblem() || 'ok',
      childLog: engine.log(),
    };
  } finally {
    engine.close();
  }
}

/** Electron binary from WVD_ELECTRON, or the usual checkout layout above the repository. */
function findElectron() {
  if (process.env.WVD_ELECTRON) return existsSync(process.env.WVD_ELECTRON) ? process.env.WVD_ELECTRON : null;
  let dir = ROOT;
  for (let depth = 0; depth < 8; depth++) {
    for (const candidate of [
      join(dir, 'node_modules', 'electron', 'dist', 'electron.exe'),
      join(dir, 'Coopanion', 'node_modules', 'electron', 'dist', 'electron.exe'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function format(result) {
  const runtime = result.runtime.electron ? `Electron ${result.runtime.electron} (Node ${result.runtime.node})` : `Node ${result.runtime.node}`;
  return [
    `runtime: ${runtime}`,
    `window: ${result.window.width}x${result.window.height}, ${result.frameBytes} JPEG bytes, GDI+ ${result.gdiplus}`,
    `capture round trip  p50 ${result.roundTripMs.p50} ms  p90 ${result.roundTripMs.p90} ms  max ${result.roundTripMs.max} ms  (${result.samples.capture} samples)`,
    `frame age          p50 ${result.ageMs.p50} ms  p90 ${result.ageMs.p90} ms`,
    `cadence            p50 ${result.cadenceMs.p50} ms  p90 ${result.cadenceMs.p90} ms  ~${result.fps} fps  (${result.samples.frames} frames)`,
    `decode (World)     p50 ${result.decodeMs.p50} ms  p90 ${result.decodeMs.p90} ms  ${result.decoded[0]}x${result.decoded[1]}  (${result.samples.decode} samples)`,
    `encode (GDI+)      p50 ${result.encodeMs.p50} ms  p90 ${result.encodeMs.p90} ms  1920x1080  (${result.samples.encode} samples)`,
  ].join('\n');
}

const result = await measure();
if (json) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

console.log(`\n== ${process.versions.electron ? 'Electron-as-Node' : 'Node'} ==`);
console.log(format(result));

if (!process.versions.electron) {
  const electron = findElectron();
  if (!electron) {
    console.log('\nelectron: skipped (no Electron binary found; set WVD_ELECTRON to run it)');
  } else {
    const run = spawnSync(electron, [SELF, `--title=${title}`, `--frames=${frames}`, '--json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 180000,
    });
    const line = run.stdout.trim().split('\n').filter((entry) => entry.startsWith('{')).pop();
    if (!line) {
      console.log(`\nelectron: skipped (run failed: ${(run.stderr || '').trim().slice(0, 300)})`);
    } else {
      const electronResult = JSON.parse(line);
      console.log('\n== Electron-as-Node ==');
      console.log(format(electronResult));
    }
  }
}
