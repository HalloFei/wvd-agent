#!/usr/bin/env tsx
/**
 * Measure the WVD world map from the live window: the zoom ladder, the pan gain, and the
 * max-zoom-in sweep the atlas is stitched from.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-probe.ts ladder
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-probe.ts gain
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-probe.ts sweep --cols 10 --rows 10
 *
 * The probe takes the foreground (the engine refuses input otherwise) and drives only the map's own
 * keys (Q 缩小 / E 放大) and drags. It never taps a node: the only press is a drag, whose long move
 * keeps the game from reading it as a click. Frames land in .tmp/atlas/<stamp>/ beside
 * manifest.json; the cursor's end point of every drag is recorded so the stitcher can mask it.
 *
 * The frame is 1920x1080; the map itself is drawn in the centre strip (x 480..1440, full height),
 * black pillars left and right with the zoom/close legend drawn over them.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, sendInput } from '../src/engine/win32.ts';
import { WorldMapPerceiver } from '../src/perception/location.ts';

const TITLE = 'WizardryVariantsDaphne';
const Q = 0x10;
const E = 0x12;
const PRESS_MS = 60;
const ZOOM_SETTLE_MS = 450;
const DRAG_SETTLE_MS = 380;
const DRAG_MS = 400;
/** The map strip; drags start and end inside it. */
const STRIP = { x0: 480, x1: 1440, y0: 0, y1: 1080 };
/** Where the cursor is parked for a clean frame: the black pillar, away from every control. */
const PARK = { x: 200, y: 540 };
/** A frame whose mean abs luma difference is under this is the same picture. */
const SAME_FRAME = 0.8;

const args = process.argv.slice(2);
const phase = args[0] ?? 'ladder';
function option(name: string, fallback: string): string {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = option('out', '.tmp/atlas/' + stamp);
const maxCols = Number(option('cols', '10'));
const maxRows = Number(option('rows', '10'));
const step = Number(option('step', '600'));
mkdirSync(dir, { recursive: true });

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const manifest: Record<string, unknown>[] = [];
let frameIndex = 0;

const child = startEngine({ title: TITLE, jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });

const press = (scan: number) => sendInput(client, { op: 'key', scan, holdMs: PRESS_MS });
const tap = (at: { x: number; y: number }) => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 1 });
const drag = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs: DRAG_MS });

/** The frame's luma, box-averaged to 240x135, for a change test that ignores the cursor. */
function signature(bytes: Uint8Array): Float64Array {
  const image = decodeJpeg(bytes as never) as { data: Uint8Array; width: number; height: number };
  const width = 240;
  const height = 135;
  const block = 8;
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let by = 0; by < block; by += 1) {
        for (let bx = 0; bx < block; bx += 1) {
          const at = ((y * block + by) * image.width + x * block + bx) * 4;
          sum += (image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000;
        }
      }
      out[y * width + x] = sum / (block * block);
    }
  }
  return out;
}

function meanAbsDiff(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index]! - b[index]!);
  return sum / a.length;
}

interface Shot {
  readonly name: string;
  readonly sig: Float64Array;
  readonly moved: boolean;
}

let previous: Float64Array | null = null;

/**
 * The engine renders on demand and its render loop sleeps after 300 ms without a request, so the
 * first capture after a pause can name an old frame and be refused as stale. The request itself
 * wakes the loop; one short retry is enough, and it is what the World's 10 Hz loop gets for free.
 */
async function captureFresh(): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await captureJpeg(client);
    } catch (error) {
      lastError = error;
      const detail = (error as { detail?: string }).detail;
      if (detail !== 'stale-frame') throw error;
      await wait(80);
    }
  }
  throw lastError;
}

async function shot(tag: string, extra: Record<string, unknown> = {}): Promise<Shot> {
  const captured = await captureFresh();
  const name = String(frameIndex).padStart(3, '0') + '-' + tag + '.jpg';
  frameIndex += 1;
  writeFileSync(dir + '/' + name, captured.bytes);
  const sig = signature(captured.bytes);
  const moved = previous === null ? true : meanAbsDiff(previous, sig) > SAME_FRAME;
  manifest.push({ frame: name, at: Date.now(), moved, ...extra });
  previous = sig;
  return { name, sig, moved };
}

const worldMap = new WorldMapPerceiver();
async function screenOf(bytes: Uint8Array, width: number, height: number): Promise<string> {
  const frame = { atMs: performance.now(), width, height, toRgba: async () => decodeJpeg(new Uint8Array(bytes) as never) };
  const observation = await worldMap.observe(frame as never);
  return observation.screen;
}

async function screenNow(): Promise<string> {
  const captured = await captureFresh();
  return screenOf(captured.bytes, captured.width, captured.height);
}

/** A fresh frame's signature, without writing it to the manifest. */
async function freshSig(): Promise<Float64Array> {
  const captured = await captureFresh();
  return signature(captured.bytes);
}

/** Poll until two frames agree: a zoom or pan animation must finish before a frame is evidence. */
async function waitStill(): Promise<Float64Array> {
  let previousSig = await freshSig();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(150);
    const next = await freshSig();
    if (meanAbsDiff(previousSig, next) < 0.5) return next;
    previousSig = next;
  }
  return previousSig;
}

/** One zoom press and the frame it leaves, until two presses in a row change nothing. */
async function zoomToClamp(scan: number, tag: string, limit = 16): Promise<{ steps: number; clamped: boolean }> {
  let steady = 0;
  let steps = 0;
  let before = await freshSig();
  for (let index = 1; index <= limit; index += 1) {
    const sent = await press(scan);
    if (!sent.ok) throw new Error('zoom press refused: ' + JSON.stringify(sent));
    const after = await waitStill();
    const changed = meanAbsDiff(before, after) > 1.0;
    await shot(tag + '-' + index);
    steps = index;
    if (changed) steady = 0;
    else steady += 1;
    if (steady >= 2) return { steps, clamped: true };
    before = after;
  }
  return { steps, clamped: false };
}

/** Drag by (dx, dy) from a quiet point of the current view, then capture. */
async function panStep(dx: number, dy: number, tag: string): Promise<Shot> {
  const before = await captureFresh();
  const rgba = decodeJpeg(new Uint8Array(before.bytes) as never) as { data: Uint8Array; width: number; height: number };
  const quiet = quietStart(rgba);
  const from = {
    x: Math.max(500, Math.min(1_420 - dx, quiet.x - Math.sign(dx) * 0)),
    y: Math.max(40, Math.min(1_040 - dy, quiet.y)),
  };
  const to = { x: from.x + dx, y: from.y + dy };
  const sent = await drag(from, to);
  if (!sent.ok) throw new Error('drag refused: ' + JSON.stringify(sent));
  await wait(DRAG_SETTLE_MS);
  return shot(tag, { drag: { from, to }, cursorAt: to });
}

async function park(): Promise<void> {
  const sent = await tap(PARK);
  if (!sent.ok) throw new Error('park tap refused: ' + JSON.stringify(sent));
  await wait(160);
}

async function ladder(): Promise<Record<string, unknown>> {
  const screen = await screenNow();
  if (screen !== 'worldmap') throw new Error('not on the world map: ' + screen);
  const origin = await shot('ladder-origin');
  const out = await zoomToClamp(Q, 'out');
  const maxOut = await shot('max-out');
  const into = await zoomToClamp(E, 'in');
  const maxIn = await shot('max-in');
  // The park tap is only used by the sweep; prove it is inert here.
  const beforePark = await shot('park-before');
  await park();
  const afterPark = await shot('park-after', { cursorAt: PARK });
  const parkScreen = await screenNow();
  return {
    phase: 'ladder',
    screenAtStart: screen,
    outSteps: out.steps,
    inSteps: into.steps,
    outClamped: out.clamped,
    inClamped: into.clamped,
    parkInert: parkScreen === 'worldmap' && meanAbsDiff(beforePark.sig, afterPark.sig) < 6,
    parkScreen,
    frames: { origin: origin.name, maxOut: maxOut.name, maxIn: maxIn.name },
  };
}

async function gain(): Promise<Record<string, unknown>> {
  const measured: Record<string, unknown>[] = [];
  for (const dx of [200, 400, 600]) {
    const before = await shot('gain-' + dx + '-a');
    const from = { x: 1400, y: 540 };
    const to = { x: 1400 - dx, y: 540 };
    const sent = await drag(from, to);
    if (!sent.ok) throw new Error('drag refused: ' + JSON.stringify(sent));
    await wait(DRAG_SETTLE_MS);
    const after = await shot('gain-' + dx + '-b', { drag: { from, to }, cursorAt: to });
    measured.push({ dx, before: before.name, after: after.name });
    const back = await drag(to, from);
    if (!back.ok) throw new Error('drag refused: ' + JSON.stringify(back));
    await wait(DRAG_SETTLE_MS);
    await shot('gain-' + dx + '-c', { drag: { from: to, to: from }, cursorAt: from });
  }
  return { phase: 'gain', measured };
}

/**
 * The drag must start on empty map: a press on a node, its label or the party marker is swallowed
 * by that element and the map does not move (the guide says "an empty parchment point"). So each
 * pan picks the quietest 64x64 patch of the current frame inside the strip — lowest luma variance,
 * no glow (a node's light column) and no black (the vignette).
 */
function quietStart(rgba: { data: Uint8Array; width: number }): { x: number; y: number } {
  let best = { x: 960, y: 540, score: Number.POSITIVE_INFINITY };
  for (let y = 40; y + 64 < 1_040; y += 32) {
    for (let x = 500; x + 64 < 1_420; x += 32) {
      let sum = 0;
      let sum2 = 0;
      let max = 0;
      let count = 0;
      for (let dy = 0; dy < 64; dy += 4) {
        for (let dx = 0; dx < 64; dx += 4) {
          const at = ((y + dy) * rgba.width + x + dx) * 4;
          const luma = (rgba.data[at]! * 299 + rgba.data[at + 1]! * 587 + rgba.data[at + 2]! * 114) / 1000;
          sum += luma;
          sum2 += luma * luma;
          if (luma > max) max = luma;
          count += 1;
        }
      }
      const mean = sum / count;
      if (max > 200) continue;
      if (mean < 25) continue;
      const variance = sum2 / count - mean * mean;
      if (variance < best.score) best = { x: x + 32, y: y + 32, score: variance };
    }
  }
  return { x: best.x, y: best.y };
}

/** Strip-only luma signature: the black pillars and the cursor cannot hide a pan. */
function stripSig(bytes: Uint8Array): Float64Array {
  const image = decodeJpeg(bytes as never) as { data: Uint8Array; width: number; height: number };
  const width = 120;
  const height = 135;
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let by = 0; by < 8; by += 1) {
        for (let bx = 0; bx < 8; bx += 1) {
          const at = ((y * 8 + by) * image.width + 480 + x * 8 + bx) * 4;
          sum += (image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000;
        }
      }
      out[y * width + x] = sum / 64;
    }
  }
  return out;
}

async function dragtest(): Promise<Record<string, unknown>> {
  const cases = [
    { from: { x: 960, y: 540 }, to: { x: 660, y: 540 }, ms: 350 },
    { from: { x: 660, y: 540 }, to: { x: 960, y: 540 }, ms: 350 },
    { from: { x: 960, y: 540 }, to: { x: 260, y: 540 }, ms: 400 },
    { from: { x: 260, y: 540 }, to: { x: 960, y: 540 }, ms: 400 },
    { from: { x: 520, y: 540 }, to: { x: 1220, y: 540 }, ms: 400 },
    { from: { x: 1220, y: 540 }, to: { x: 520, y: 540 }, ms: 400 },
    { from: { x: 1400, y: 540 }, to: { x: 900, y: 540 }, ms: 400 },
    { from: { x: 960, y: 540 }, to: { x: 960, y: 240 }, ms: 400 },
  ];
  const results: Record<string, unknown>[] = [];
  for (const item of cases) {
    const before = await captureFresh();
    const sent = await sendInput(client, {
      op: 'drag',
      x1: item.from.x, y1: item.from.y, x2: item.to.x, y2: item.to.y, durationMs: item.ms,
    });
    await wait(450);
    const after = await captureFresh();
    const diff = meanAbsDiff(stripSig(before.bytes), stripSig(after.bytes));
    results.push({
      from: item.from, to: item.to, ms: item.ms,
      ok: sent.ok,
      detail: sent.ok ? undefined : JSON.stringify(sent),
      movedPx: diff.toFixed(2),
    });
  }
  return { phase: 'dragtest', results, screenAtEnd: await screenNow() };
}

async function limits(): Promise<Record<string, unknown>> {
  const screen = await screenNow();
  if (screen !== 'worldmap') throw new Error('not on the world map: ' + screen);
  const start = await shot('limits-start');
  const into = await zoomToClamp(E, 'limits-in');
  const maxIn = await shot('limits-max-in');
  const out = await zoomToClamp(Q, 'limits-out');
  const maxOut = await shot('limits-max-out');
  return {
    phase: 'limits',
    screenAtStart: screen,
    inSteps: into.steps,
    inClamped: into.clamped,
    outSteps: out.steps,
    outClamped: out.clamped,
    frames: { start: start.name, maxIn: maxIn.name, maxOut: maxOut.name },
  };
}

async function sweep(): Promise<Record<string, unknown>> {
  const zoom = option('zoom', 'in');
  const clamp = await zoomToClamp(zoom === 'out' ? Q : E, 'sweep-zoom-' + zoom);
  const screen = await screenNow();
  if (screen !== 'worldmap') throw new Error('left the world map before the sweep: ' + screen);
  await park();
  await shot('sweep-parked', { cursorAt: PARK });
  // To the left edge: the camera goes left as the content goes right.
  for (let index = 0; index < 16; index += 1) {
    const frame = await panStep(step, 0, 'to-left-' + index);
    if (!frame.moved) break;
  }
  // To the top edge: the camera goes up as the content goes down.
  for (let index = 0; index < 16; index += 1) {
    const frame = await panStep(0, step, 'to-top-' + index);
    if (!frame.moved) break;
  }
  let frames = 1;
  let rows = 0;
  for (let row = 0; row < maxRows; row += 1) {
    const direction = row % 2 === 0 ? -step : step;
    let columns = 0;
    for (let column = 0; column < maxCols; column += 1) {
      const frame = await panStep(direction, 0, 'r' + row + 'c' + (column + 1));
      if (!frame.moved) break;
      frames += 1;
      columns += 1;
    }
    rows += 1;
    if (columns === 0) break;
    const down = await panStep(0, -step, 'down-' + row);
    if (!down.moved) break;
    frames += 1;
  }
  return { phase: 'sweep', zoom, clamp, frames, rows, screenAtEnd: await screenNow() };
}

const results: Record<string, unknown>[] = [];
try {
  if (phase === 'ladder' || phase === 'gain' || phase === 'sweep' || phase === 'dragtest') {
    console.error('wvd probe: taking the foreground and driving the world map (' + phase + ')');
  }
  if (phase === 'ladder' || phase === 'gain') results.push(await ladder());
  if (phase === 'limits') results.push(await limits());
  if (phase === 'dragtest') results.push(await dragtest());
  if (phase === 'gain') results.push(await gain());
  if (phase === 'sweep') results.push(await sweep());
} finally {
  writeFileSync(dir + '/manifest.json', JSON.stringify({ dir, phase, results, manifest }, null, 1));
  client.close();
}
console.log(JSON.stringify({ ok: true, dir, results, frames: manifest.length }, null, 1));
