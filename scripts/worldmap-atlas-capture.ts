#!/usr/bin/env tsx
/**
 * Capture the whole world map as a grid of frames, panning in BOTH axes.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-atlas-capture.ts --out .tmp/atlas/out --zoom out
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-atlas-capture.ts --out .tmp/atlas/in  --zoom in --step 250
 *
 * The map follows the pointer (measured 2.05-2.48 px per px of drag) and clamps at its own edges,
 * so the capture is a corner-to-corner serpentine that *measures* every move instead of assuming
 * one: the real content shift of each drag is found by NCC between the frames either side of it, and
 * three zero-shift drags from different start points mean an edge. Placements are cumulative and the
 * first frame is the map's top-left corner, so the stitcher only has to paste.
 *
 * Every frame is written as the game's own 1920x1080 q90 JPEG, with a manifest entry per frame:
 * placement, the drag that produced it, and the measured shift.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';

const STRIP = { x: 480, y: 0, w: 960, h: 1080 };
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const outDir = option('out', '.tmp/atlas/capture');
const zoom = option('zoom', 'out');
const step = Number(option('step', '250'));
const maxCols = Number(option('cols', '14'));
const maxRows = Number(option('rows', '14'));
const PARK = { x: 200, y: 540 };
const DRAG_MS = 420;
/** The map glides after release: a short wait measures the glide, not the drag (seen 2026-11-01). */
const SETTLE_MS = 1_200;
mkdirSync(outDir, { recursive: true });

const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Gray { w: number; h: number; d: Float64Array }
interface Frame { name: string; gray8: Gray; gray4: Gray }
let index = 0;
const manifest: Record<string, unknown>[] = [];

function grayOf(bytes: Uint8Array, factor: number): Gray {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const w = Math.floor(STRIP.w / factor), h = Math.floor(STRIP.h / factor);
  const d = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const at = ((y * factor + dy) * img.width + STRIP.x + x * factor + dx) * 4;
      sum += (img.data[at]! * 299 + img.data[at + 1]! * 587 + img.data[at + 2]! * 114) / 1000;
    }
    d[y * w + x] = sum / (factor * factor);
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
async function grab(): Promise<{ bytes: Uint8Array; gray8: Gray; gray4: Gray }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const { bytes } = await captureJpeg(client);
      return { bytes, gray8: grayOf(bytes, 8), gray4: grayOf(bytes, 4) };
    } catch {
      await wait(150);
    }
  }
  throw new Error('capture never became fresh');
}
async function parkedGrab(): Promise<{ bytes: Uint8Array; gray8: Gray; gray4: Gray }> {
  await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 });
  await wait(140);
  return grab();
}
function saveFrame(tag: string, grabbed: { bytes: Uint8Array; gray8: Gray; gray4: Gray }, placement: { x: number; y: number }, extra: Record<string, unknown> = {}): Frame {
  const name = String(index).padStart(3, '0') + '-' + tag + '.jpg';
  index += 1;
  writeFileSync(outDir + '/' + name, grabbed.bytes);
  manifest.push({ frame: name, placement, ...extra });
  return { name, gray8: grabbed.gray8, gray4: grabbed.gray4 };
}
/** The content shift between two frames, coarse at 8x then refined at 4x. */
function measureShift(a: Frame, b: Frame, approx: number): { dx: number; dy: number; score: number } {
  const tw = 40, th = 30;
  const px = Math.floor((a.gray8.w - tw) / 2), py = Math.floor((a.gray8.h - th) / 2);
  const range = Math.min(110, Math.max(20, Math.round(approx / 8 * 3)));
  let best = { score: -2, dx: 0, dy: 0 };
  for (let oy = -range; oy <= range; oy += 1) for (let ox = -range; ox <= range; ox += 1) {
    const bx = px + ox, by = py + oy;
    if (bx < 0 || by < 0 || bx + tw > b.gray8.w || by + th > b.gray8.h) continue;
    const score = ncc(a.gray8, px, py, b.gray8, bx, by, tw, th);
    if (score > best.score) best = { score, dx: ox, dy: oy };
  }
  // refine at 4x around the coarse answer
  const tw4 = tw * 2, th4 = th * 2;
  const px4 = px * 2, py4 = py * 2;
  let refined = { score: best.score, dx: best.dx * 2, dy: best.dy * 2 };
  for (let oy = best.dy * 2 - 8; oy <= best.dy * 2 + 8; oy++) for (let ox = best.dx * 2 - 8; ox <= best.dx * 2 + 8; ox++) {
    const bx = px4 + ox, by = py4 + oy;
    if (bx < 0 || by < 0 || bx + tw4 > b.gray4.w || by + th4 > b.gray4.h) continue;
    const score = ncc(a.gray4, px4, py4, b.gray4, bx, by, tw4, th4);
    if (score > refined.score) refined = { score, dx: ox, dy: oy };
  }
  return { dx: refined.dx * 4, dy: refined.dy * 4, score: refined.score };
}

/**
 * The quietest 64x64 patch of the current view inside the strip. A press on a node, its label or the
 * party marker is swallowed by that element, so a drag must start on empty map; picking the lowest
 * luma variance here is what keeps a serpentine from stalling on a node it happens to cross.
 */
function quietPoint(gray4: Gray): { x: number; y: number } {
  const f = 4;
  let best = { x: 720, y: 540, score: Number.POSITIVE_INFINITY };
  for (let y = 40; y + 64 < 1_020; y += 24) {
    for (let x = 500; x + 64 < 1_400; x += 24) {
      const bx = Math.floor(x / f), by = Math.floor(y / f), bw = 64 / f, bh = 64 / f;
      let sum = 0, sum2 = 0, n = 0, max = 0;
      for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) {
        const value = gray4.d[(by + dy) * gray4.w + bx + dx]!;
        sum += value; sum2 += value * value; n++;
        if (value > max) max = value;
      }
      const mean = sum / n;
      if (max > 200 || mean < 25) continue;
      const variance = sum2 / n - mean * mean;
      if (variance < best.score) best = { x: x + 32, y: y + 32, score: variance };
    }
  }
  return { x: best.x, y: best.y };
}

type Direction = 'left' | 'right' | 'up' | 'down';
const STARTS: Record<Direction, { x: number; y: number }[]> = {
  // dragging moves the content with the pointer, so to bring the camera left the pointer moves right
  left: [{ x: 700, y: 420 }, { x: 660, y: 660 }, { x: 740, y: 260 }],
  right: [{ x: 1200, y: 420 }, { x: 1260, y: 660 }, { x: 1140, y: 260 }],
  up: [{ x: 720, y: 760 }, { x: 1100, y: 760 }, { x: 720, y: 840 }],
  down: [{ x: 720, y: 340 }, { x: 1100, y: 340 }, { x: 720, y: 260 }],
};
const VECTOR: Record<Direction, { dx: number; dy: number }> = {
  left: { dx: step, dy: 0 },
  right: { dx: -step, dy: 0 },
  up: { dx: 0, dy: -step },
  down: { dx: 0, dy: step },
};

/**
 * One serpentine move: drag, measure the real shift, and only keep the moved view. A zero shift
 * from three different start points is an edge. Returns the new view and its placement.
 */
async function move(
  current: Frame,
  placement: { x: number; y: number },
  direction: Direction,
  save = true,
): Promise<{ frame: Frame; placement: { x: number; y: number } } | null> {
  const vector = VECTOR[direction];
  const quiet = quietPoint(current.gray4);
  const starts = [{ x: quiet.x, y: quiet.y }, ...STARTS[direction]];
  for (const start of starts) {
    const from = {
      x: Math.max(STRIP.x + 40, Math.min(STRIP.x + STRIP.w - 40 - vector.dx, start.x)),
      y: Math.max(60, Math.min(STRIP.h - 60 - vector.dy, start.y)),
    };
    const to = { x: from.x + vector.dx, y: from.y + vector.dy };
    await sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs: DRAG_MS });
    await wait(SETTLE_MS);
    const grabbed = await parkedGrab();
    const after: Frame = { name: '', gray8: grabbed.gray8, gray4: grabbed.gray4 };
    const shift = measureShift(current, after, Math.hypot(vector.dx, vector.dy));
    if (Math.abs(shift.dx) <= 10 && Math.abs(shift.dy) <= 10) continue;
    const next = { x: placement.x - shift.dx, y: placement.y - shift.dy };
    const saved = save
      ? saveFrame('tile', grabbed, next, { direction, drag: { from, to }, shift: { dx: shift.dx, dy: shift.dy } })
      : { name: '', gray8: grabbed.gray8, gray4: grabbed.gray4 };
    return { frame: saved, placement: next };
  }
  return null;
}

try {
  await focusGame(client);
  // The caller opens the world map: the town's icon point sits one button-width from the map's own
  // 关闭 button, so a blind "open" tap can close an already-open map instead.
  const scan = zoom === 'in' ? 0x12 : 0x10;
  for (let i = 0; i < 8; i++) {
    await sendInput(client, { op: 'key', scan, holdMs: 60 });
    await wait(450);
  }
  // corner: left then up until both stop
  let cornerGrabbed = await parkedGrab();
  let corner = saveFrame('start', cornerGrabbed, { x: 0, y: 0 }, { note: 'arrival view' });
  // north-west corner: drag right (camera west) and drag down (camera north)
  for (const direction of ['left', 'down'] as Direction[]) {
    for (let i = 0; i < 14; i++) {
      const moved = await move(corner, { x: 0, y: 0 }, direction, false);
      if (moved === null) break;
      corner = moved.frame;
    }
  }
  // the corner view is the map's top-left: its coordinate is the atlas origin
  const cornerShot = saveFrame('corner', await parkedGrab(), { x: 0, y: 0 }, { note: 'top-left corner' });
  let placement = { x: 0, y: 0 };
  let current = cornerShot;
  console.log('corner reached');
  let rows = 0;
  for (; rows < maxRows; rows++) {
    let columns = 0;
    for (; columns < maxCols; columns++) {
      const direction: Direction = rows % 2 === 0 ? 'right' : 'left';
      const moved = await move(current, placement, direction);
      if (moved === null) break;
      current = moved.frame;
      placement = moved.placement;
    }
    console.log('row', rows, 'columns', columns, 'placement', placement.x, placement.y);
    writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, zoom, step, rows, placement, frames: manifest }, null, 1));
    if (columns === 0) break;
    // next row is south of this one: drag up, the map content follows the pointer
    const down = await move(current, placement, 'up');
    if (down === null) break;
    current = down.frame;
    placement = down.placement;
  }
  writeFileSync(outDir + '/manifest.json', JSON.stringify({ outDir, zoom, step, rows, placement, frames: manifest }, null, 1));
  console.log(JSON.stringify({ ok: true, outDir, zoom, rows, frames: manifest.length, placement }));
} finally {
  client.close();
}
