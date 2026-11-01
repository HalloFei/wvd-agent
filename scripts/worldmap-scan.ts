#!/usr/bin/env tsx
/**
 * Snake-scan the world map at one zoom level, in both axes, measuring every move.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-scan.ts --out .tmp/atlas/scan-in --zoom in --step 320 --cols 20 --rows 20
 *
 * The zoom is reached the way the operator does it: three 放大 presses from the 缩小 clamp. Each
 * move is a 500 ms drag from the quietest empty patch of the current frame, then a 1.4 s settle (the
 * map glides after release), then the shift is measured by NCC between the frames either side. A
 * move whose shift is zero is retried from other start points; two zero moves in a row are an edge,
 * and the scan reverses. Every frame is saved with its cumulative placement (relative to the first
 * frame), so the stitcher only has to paste.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';

const STRIP = { x: 480, y: 0, w: 960, h: 1080 };
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const outDir = option('out', '.tmp/atlas/scan');
const zoom = option('zoom', 'in');
const step = Number(option('step', '320'));
const maxCols = Number(option('cols', '20'));
const maxRows = Number(option('rows', '20'));
const PARK = { x: 200, y: 540 };
const ZOOM_IN_BUTTON = { x: 824, y: 1_013 };
const ZOOM_OUT_BUTTON = { x: 723, y: 1_013 };
mkdirSync(outDir, { recursive: true });
const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();
const manifest: Record<string, unknown>[] = [];
let index = 0;

async function grab(): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return (await captureJpeg(client)).bytes; } catch { await wait(150); }
  }
  throw new Error('capture never became fresh');
}
async function screenOf(bytes: Uint8Array): Promise<string> {
  const frame = { atMs: performance.now(), width: 1920, height: 1080, toRgba: async () => decodeJpeg(bytes) };
  if ((await mapSee.observe(frame as never)).screen === 'worldmap') return 'worldmap';
  return (await townSee.observe(frame as never)).screen;
}
async function ensureMap(): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') return true;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  return false;
}
interface Gray { w: number; h: number; d: Float64Array }
function gray(bytes: Uint8Array, f: number): Gray {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const w = Math.floor(960 / f), h = Math.floor(1080 / f);
  const d = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
      const at = ((y * f + dy) * img.width + STRIP.x + x * f + dx) * 4;
      sum += (img.data[at]! * 299 + img.data[at + 1]! * 587 + img.data[at + 2]! * 114) / 1000;
    }
    d[y * w + x] = sum / (f * f);
  }
  return { w, h, d };
}
function ncc(a: Gray, ax: number, ay: number, b: Gray, bx: number, by: number, tw: number, th: number): number {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const va = a.d[(ay + y) * a.w + ax + x]!, vb = b.d[(by + y) * b.w + bx + x]!;
    sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
  }
  const cov = sab - sa * sb / n, v1 = saa - sa * sa / n, v2 = sbb - sb * sb / n;
  return v1 <= 0 || v2 <= 0 ? -1 : cov / Math.sqrt(v1 * v2);
}
/**
 * The content shift between two frames, searched narrowly around the shift the drag predicts.
 *
 * The pan gain measured at maximum zoom is 0.22-0.66 of the drag, so a wide search is not needed and
 * is actively harmful: the map's parchment is self-similar at that magnification and a full-range
 * NCC locks onto wrong peaks (seen 2026-11-01 — a pure horizontal drag measured as a 288 px diagonal).
 */
function measureShift(before: Gray8, after: Gray8, drag: { dx: number; dy: number }): { dx: number; dy: number; score: number } {
  const tw = 40, th = 32;
  const px = Math.floor((before.g8.w - tw) / 2), py = Math.floor((before.g8.h - th) / 2);
  const predicted = { dx: Math.round((drag.dx * 0.4) / 8), dy: Math.round((drag.dy * 0.4) / 8) };
  const range = Math.max(6, Math.round((Math.hypot(drag.dx, drag.dy) * 0.45) / 8));
  let best = { score: -2, dx: 0, dy: 0 };
  for (let oy = predicted.dy - range; oy <= predicted.dy + range; oy++) for (let ox = predicted.dx - range; ox <= predicted.dx + range; ox++) {
    const bx = px + ox, by = py + oy;
    if (bx < 0 || by < 0 || bx + tw > before.g8.w || by + th > before.g8.h) continue;
    const score = ncc(before.g8, px, py, after.g8, bx, by, tw, th);
    if (score > best.score) best = { score, dx: ox, dy: oy };
  }
  return { dx: best.dx * 8, dy: best.dy * 8, score: best.score };
}
interface Gray8 { bytes: Uint8Array; g8: Gray; g4: Gray }
async function parked(): Promise<Gray8> {
  await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 });
  await wait(220);
  const bytes = await grab();
  return { bytes, g8: gray(bytes, 8), g4: gray(bytes, 4) };
}
/** quietest 64x64 patch, so a press does not land on a node or a label */
function quietPoint(frame: Gray): { x: number; y: number } {
  let best = { x: 760, y: 540, score: Number.POSITIVE_INFINITY };
  for (let y = 120; y < 900; y += 40) for (let x = 560; x < 1_340; x += 40) {
    const bx = Math.floor((x - STRIP.x) / 8), by = Math.floor(y / 8);
    let sum = 0, sum2 = 0, n = 0, max = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const value = frame.d[(by + dy) * frame.w + bx + dx]!;
      sum += value; sum2 += value * value; n++;
      if (value > max) max = value;
    }
    const mean = sum / n;
    if (max > 200 || mean < 25) continue;
    const variance = sum2 / n - mean * mean;
    if (variance < best.score) best = { x, y, score: variance };
  }
  return { x: best.x, y: best.y };
}
const STARTS: Record<string, { x: number; y: number }[]> = {
  east: [{ x: 700, y: 420 }, { x: 660, y: 700 }, { x: 740, y: 260 }],
  west: [{ x: 1_240, y: 420 }, { x: 1_280, y: 700 }, { x: 1_200, y: 260 }],
  south: [{ x: 720, y: 800 }, { x: 1_100, y: 800 }, { x: 720, y: 900 }],
  north: [{ x: 720, y: 300 }, { x: 1_100, y: 300 }, { x: 720, y: 220 }],
};
type Direction = 'east' | 'west' | 'south' | 'north';
const VECTOR: Record<Direction, { dx: number; dy: number }> = {
  east: { dx: -step, dy: 0 },   // the content follows the pointer: drag left to look east
  west: { dx: step, dy: 0 },
  south: { dx: 0, dy: -step },
  north: { dx: 0, dy: step },
};
async function moveOnce(current: Gray8, direction: Direction): Promise<{ frame: Gray8; shift: { dx: number; dy: number } } | null> {
  const vector = VECTOR[direction];
  const quiet = quietPoint(current.g8);
  const starts = [{ x: quiet.x, y: quiet.y }, ...STARTS[direction]!];
  for (const start of starts) {
    const from = {
      x: Math.max(STRIP.x + 40, Math.min(STRIP.x + STRIP.w - 40 - vector.dx, start.x)),
      y: Math.max(80, Math.min(1_000 - vector.dy, start.y)),
    };
    await sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: from.x + vector.dx, y2: from.y + vector.dy, durationMs: 500 });
    await wait(1_400);
    const after = await parked();
    const shift = measureShift(current, after, vector);
    if (Math.abs(shift.dx) <= 12 && Math.abs(shift.dy) <= 12) continue;
    if (shift.score < 0.55) continue;
    return { frame: after, shift: { dx: shift.dx, dy: shift.dy } };
  }
  return null;
}
function save(frame: Gray8, tag: string, placement: { x: number; y: number }, extra: Record<string, unknown> = {}): void {
  const name = String(index).padStart(3, '0') + '-' + tag + '.jpg';
  index += 1;
  writeFileSync(outDir + '/' + name, frame.bytes);
  manifest.push({ frame: name, placement, ...extra });
  writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, zoom, step, frames: manifest }, null, 1));
}

try {
  await focusGame(client);
  if (!(await ensureMap())) { console.log('the world map is not reachable'); process.exit(1); }
  // the operator's ladder: clamp with 缩小, then three 放大 presses for the maximum zoom
  for (let i = 0; i < 8; i++) { await sendInput(client, { op: 'key', scan: 0x10, holdMs: 60 }); await wait(450); }
  if (zoom === 'in') {
    for (let i = 0; i < 3; i++) { await sendInput(client, { op: 'tap', x: ZOOM_IN_BUTTON.x, y: ZOOM_IN_BUTTON.y, count: 1 }); await wait(650); }
  }
  let current = await parked();
  save(current, 'start', { x: 0, y: 0 });
  // corner: drag right and down until two moves in a row change nothing
  for (const direction of ['west', 'north'] as Direction[]) {
    let misses = 0;
    for (let i = 0; i < 16 && misses < 2; i += 1) {
      const moved = await moveOnce(current, direction);
      if (moved === null) { misses += 1; continue; }
      misses = 0;
      current = moved.frame;
    }
  }
  let placement = { x: 0, y: 0 };
  save(current, 'corner', placement);
  let rows = 0;
  for (; rows < maxRows; rows += 1) {
    let columns = 0;
    for (; columns < maxCols; columns += 1) {
      const direction: Direction = rows % 2 === 0 ? 'east' : 'west';
      const moved = await moveOnce(current, direction);
      if (moved === null) {
        // one no-move is not an edge: a swallowed press is retried inside moveOnce, so this is it
        break;
      }
      current = moved.frame;
      placement = { x: placement.x - moved.shift.dx, y: placement.y - moved.shift.dy };
      save(current, 'tile-r' + rows + 'c' + (columns + 1), placement, { direction, shift: moved.shift });
    }
    console.log('row', rows, 'columns', columns, 'placement', placement.x, placement.y);
    if (columns === 0) break;
    const down = await moveOnce(current, 'south');
    if (down === null) break;
    current = down.frame;
    placement = { x: placement.x - down.shift.dx, y: placement.y - down.shift.dy };
    save(current, 'tile-r' + (rows + 1) + 'c0', placement, { direction: 'south', shift: down.shift });
  }
  writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, zoom, step, rows, placement, frames: manifest }, null, 1));
  console.log(JSON.stringify({ ok: true, outDir, zoom, rows, frames: manifest.length, placement }));
} finally {
  client.close();
}
