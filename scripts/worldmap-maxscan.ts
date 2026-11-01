#!/usr/bin/env tsx
/**
 * Scan the whole world map at maximum zoom-in and save one frame per tile, with placements.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-maxscan.ts --out .tmp/atlas/maxscan
 *
 * The zoom is found the operator's way: press 放大 until the frame stops changing (no 缩小 first).
 * The pointer is parked in the black pillar before every capture, so the cursor is not baked into
 * the map. Movement is a 450 px drag, a 1.3 s settle, then a full-frame NCC against the previous
 * tile — a narrow search around the drag's expected shift, big template, so the parchment cannot
 * pull the match onto a wrong peak. Two consecutive no-move steps are an edge and the scan reverses.
 * Every tile is written immediately with its cumulative placement, so a crash loses one tile.
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
const outDir = option('out', '.tmp/atlas/maxscan');
const step = Number(option('step', '450'));
const maxCols = Number(option('cols', '16'));
const maxRows = Number(option('rows', '16'));
const PARK = { x: 200, y: 540 };
const ZOOM_IN = { x: 824, y: 1_013 };
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
interface Frame { bytes: Uint8Array; g4: Gray; g8: Gray }
async function parked(): Promise<Frame> {
  await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 });
  await wait(200);
  const bytes = await grab();
  return { bytes, g4: gray(bytes, 4), g8: gray(bytes, 8) };
}
/**
 * The content shift between two frames, coarse at 8x over the whole range the drag can produce
 * (the measured pan gain at max zoom runs 0.15-0.66 of the drag), then refined at 4x. A large
 * template (400x280 screen px) keeps the self-similar parchment from producing a false peak.
 */
function measure(a: Frame, b: Frame, drag: { dx: number; dy: number }): { dx: number; dy: number; score: number } {
  const g8a = a.g8, g8b = b.g8;
  const tw = 50, th = 35;
  const px = Math.floor((g8a.w - tw) / 2), py = Math.floor((g8a.h - th) / 2);
  const span = Math.max(12, Math.round((Math.hypot(drag.dx, drag.dy) * 0.85) / 8));
  let best = { score: -2, dx: 0, dy: 0 };
  for (let oy = -span; oy <= span; oy++) for (let ox = -span; ox <= span; ox++) {
    const bx = px + ox, by = py + oy;
    if (bx < 0 || by < 0 || bx + tw > g8a.w || by + th > g8a.h) continue;
    const score = ncc(g8a, px, py, g8b, bx, by, tw, th);
    if (score > best.score) best = { score, dx: ox, dy: oy };
  }
  // refine at 4x around the coarse answer
  const tw4 = 150, th4 = 110;
  const px4 = Math.floor((a.g4.w - tw4) / 2), py4 = Math.floor((a.g4.h - th4) / 2);
  const cx = Math.round((best.dx * 8) / 4), cy = Math.round((best.dy * 8) / 4);
  let refined = { score: best.score, dx: best.dx * 8, dy: best.dy * 8 };
  for (let oy = cy - 8; oy <= cy + 8; oy++) for (let ox = cx - 8; ox <= cx + 8; ox++) {
    const bx = px4 + ox, by = py4 + oy;
    if (bx < 0 || by < 0 || bx + tw4 > a.g4.w || by + th4 > a.g4.h) continue;
    const score = ncc(a.g4, px4, py4, b.g4, bx, by, tw4, th4);
    if (score > refined.score) refined = { score, dx: ox * 4, dy: oy * 4 };
  }
  return refined;
}
function quiet(frame: Gray): { x: number; y: number } {
  let best = { x: 760, y: 540, score: Number.POSITIVE_INFINITY };
  for (let y = 120; y < 900; y += 40) for (let x = 560; x < 1_340; x += 40) {
    const bx = Math.floor((x - STRIP.x) / 4), by = Math.floor(y / 4);
    let sum = 0, sum2 = 0, n = 0, max = 0;
    for (let dy = 0; dy < 16; dy++) for (let dx = 0; dx < 16; dx++) {
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
  south: [{ x: 720, y: 780 }, { x: 1_100, y: 780 }, { x: 720, y: 900 }],
  north: [{ x: 720, y: 300 }, { x: 1_100, y: 300 }, { x: 720, y: 220 }],
};
type Direction = 'east' | 'west' | 'south' | 'north';
const VECTOR: Record<Direction, { dx: number; dy: number }> = {
  east: { dx: -step, dy: 0 },
  west: { dx: step, dy: 0 },
  south: { dx: 0, dy: -step },
  north: { dx: 0, dy: step },
};
const PREDICTED_GAIN = 0.4;
async function stepTo(current: Frame, direction: Direction): Promise<{ frame: Frame; shift: { dx: number; dy: number } } | null> {
  const vector = VECTOR[direction];
  const q = quiet(current.g4);
  const starts = [{ x: q.x, y: q.y }, ...STARTS[direction]!];
  for (const start of starts) {
    const from = {
      x: Math.max(STRIP.x + 40, Math.min(STRIP.x + STRIP.w - 40 - vector.dx, start.x)),
      y: Math.max(80, Math.min(1_000 - vector.dy, start.y)),
    };
    await sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: from.x + vector.dx, y2: from.y + vector.dy, durationMs: 500 });
    await wait(1_300);
    const after = await parked();
    const shift = measure(current, after, vector);
    if (Math.abs(shift.dx) <= 8 && Math.abs(shift.dy) <= 8) continue;
    if (shift.score < 0.5) continue;
    return { frame: after, shift: { dx: shift.dx, dy: shift.dy } };
  }
  return null;
}
function save(frame: Frame, tag: string, placement: { x: number; y: number }, extra: Record<string, unknown> = {}): void {
  const name = String(index).padStart(3, '0') + '-' + tag + '.jpg';
  index += 1;
  writeFileSync(outDir + '/' + name, frame.bytes);
  manifest.push({ frame: name, placement, ...extra });
  writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, step, frames: manifest }, null, 1));
}

try {
  await focusGame(client);
  if (!(await ensureMap())) { console.log('the world map is not reachable'); process.exit(1); }
  // the operator's zoom rule: press 放大 until the frame stops changing
  let reference = await parked();
  for (let press = 0; press < 10; press += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 });
    await wait(650);
    const after = await parked();
    let sum = 0;
    for (let i = 0; i < reference.g8.d.length; i++) sum += Math.abs(reference.g8.d[i]! - after.g8.d[i]!);
    const change = sum / reference.g8.d.length;
    console.log('zoom press', press + 1, 'change', Number(change.toFixed(2)));
    if (change < 0.8 && press > 0) break;
    reference = after;
  }
  let current = await parked();
  save(current, 'start', { x: 0, y: 0 });
  // corner: west then north, two no-move steps each
  for (const direction of ['west', 'north'] as Direction[]) {
    let misses = 0;
    for (let i = 0; i < 24 && misses < 2; i += 1) {
      const moved = await stepTo(current, direction);
      if (moved === null) { misses += 1; continue; }
      misses = 0;
      current = moved.frame;
    }
  }
  let placement = { x: 0, y: 0 };
  save(current, 'corner', placement);
  console.log('corner reached');
  let rows = 0;
  for (; rows < maxRows; rows += 1) {
    let columns = 0;
    for (; columns < maxCols; columns += 1) {
      const direction: Direction = rows % 2 === 0 ? 'east' : 'west';
      const moved = await stepTo(current, direction);
      if (moved === null) break;
      current = moved.frame;
      placement = { x: placement.x - moved.shift.dx, y: placement.y - moved.shift.dy };
      save(current, 'tile-r' + rows + 'c' + (columns + 1), placement, { direction, shift: moved.shift });
    }
    console.log('row', rows, 'columns', columns, 'placement', placement.x, placement.y);
    if (columns === 0) break;
    const south = await stepTo(current, 'south');
    if (south === null) break;
    current = south.frame;
    placement = { x: placement.x - south.shift.dx, y: placement.y - south.shift.dy };
    save(current, 'tile-r' + (rows + 1) + 'c0', placement, { direction: 'south', shift: south.shift });
  }
  writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, step, rows, placement, frames: manifest }, null, 1));
  console.log(JSON.stringify({ ok: true, outDir, rows, frames: manifest.length, placement }));
} finally {
  client.close();
}
