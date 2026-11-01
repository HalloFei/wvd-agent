#!/usr/bin/env tsx
/**
 * Probe: does the world map pan on a key hold, and is the distance repeatable?
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-keyprobe.ts
 *
 * The drag actuator is not deterministic: identical drags moved the map 144-264 px at max zoom-in,
 * because the game smooths pointer motion. A key hold has no pointer path, so if the map listens to
 * it the step may be a fixed distance. This probe measures that before any script relies on it:
 *
 *  - for each of W A S D, three 150 ms holds, one 450 ms hold and one 60 ms tap;
 *  - a control trial with no key, which measures the noise floor (the map can move on its own);
 *  - every trial starts from the same kind of position: the view is nudged 150 px back into the map
 *    so a key that pans toward the corner clamps is not read as "does nothing";
 *  - the displacement is measured between two frames, not assumed.
 *
 * Output: a table on stdout and .tmp/atlas/keyprobe/report.json. It does not zoom out and does not
 * tap a node.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';
import type { PixelRect, RgbaImage } from '../src/contracts.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf('--' + name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1]! : fallback;
};
const outDir = option('out', '.tmp/atlas/keyprobe');
mkdirSync(outDir, { recursive: true });

const ZOOM_IN = { x: 824, y: 1_013 };
const PARK = { x: 200, y: 540 };
const KEYS = [
  { name: 'W', scan: 0x11 },
  { name: 'A', scan: 0x1e },
  { name: 'S', scan: 0x1f },
  { name: 'D', scan: 0x20 },
];
const HOLDS = [
  { label: 'none', press: false, holdMs: 0 },
  { label: 'tap', press: true, holdMs: 60 },
  { label: '150a', press: true, holdMs: 150 },
  { label: '150b', press: true, holdMs: 150 },
  { label: '150c', press: true, holdMs: 150 },
  { label: '450', press: true, holdMs: 450 },
];

const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();

async function grab(): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return (await captureJpeg(client)).bytes; } catch { await wait(150); }
  }
  throw new Error('no frame');
}
async function screenOf(bytes: Uint8Array): Promise<string> {
  const frame = { atMs: performance.now(), width: 1920, height: 1080, toRgba: async () => decodeJpeg(bytes) };
  if ((await mapSee.observe(frame as never)).screen === 'worldmap') return 'worldmap';
  return (await townSee.observe(frame as never)).screen;
}
async function ensureMap(): Promise<boolean> {
  for (let i = 0; i < 10; i += 1) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') return true;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  return false;
}
/** park the pointer on the black pillar so no hover art is drawn into the measurement */
async function parked(): Promise<Uint8Array> {
  await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 });
  await wait(220);
  return grab();
}
function luma(image: RgbaImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return ((image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000) | 0;
}
/** The displacement of the map content between two frames, by matching a patch of the first. */
function displacement(before: Uint8Array, after: Uint8Array): { dx: number; dy: number; score: number } | null {
  const a = decodeJpeg(before);
  const b = decodeJpeg(after);
  const patch = { x: 620, y: 350, width: 240, height: 200 };
  const gray = new Uint8Array(patch.width * patch.height);
  for (let y = 0; y < patch.height; y += 1) {
    for (let x = 0; x < patch.width; x += 1) gray[y * patch.width + x] = luma(a, patch.x + x, patch.y + y);
  }
  const area: PixelRect = { x: MAP_STRIP.x, y: MAP_STRIP.y, width: MAP_STRIP.width, height: MAP_STRIP.height };
  const match = findTemplate(b, area, { width: patch.width, height: patch.height, gray }, { scales: [1], minScore: 0.7 });
  if (match === null) return null;
  return { dx: match.at.x - patch.x, dy: match.at.y - patch.y, score: Number(match.score.toFixed(3)) };
}
async function drag(dx: number, dy: number): Promise<void> {
  await sendInput(client, { op: 'drag', x1: 760, y1: 540, x2: 760 + dx, y2: 540 + dy, durationMs: 450 });
  await wait(1_100);
}
/** view away from the top-left corner: content dragged left and up */
async function nudge(): Promise<void> { await drag(-150, -150); }
/** drag the content right and down until it stops: the view sits at the map's top-left corner */
async function toTopLeft(): Promise<number> {
  let previous: Uint8Array | null = null;
  for (let i = 0; i < 6; i += 1) {
    await drag(420, 340);
    const bytes = await parked();
    if (previous !== null && displacement(previous, bytes) === null) return i;
    previous = bytes;
  }
  return 8;
}
async function zoomMaxIn(): Promise<number> {
  let previous: Float64Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 });
    await wait(700);
    const image = decodeJpeg(await grab());
    const signature = new Float64Array(120 * 135);
    for (let y = 0; y < 135; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        let sum = 0;
        for (let by = 0; by < 8; by += 1) {
          for (let bx = 0; bx < 8; bx += 1) sum += luma(image, MAP_STRIP.x + x * 8 + bx, y * 8 + by);
        }
        signature[y * 120 + x] = sum / 64;
      }
    }
    if (previous !== null) {
      let delta = 0;
      for (let k = 0; k < signature.length; k += 1) delta += Math.abs(signature[k]! - previous[k]!);
      if (delta / signature.length < 0.4) return i;
    }
    previous = signature;
  }
  return 8;
}

interface Trial { key: string; hold: string; dx: number | null; dy: number | null; score: number | null }
const trials: Trial[] = [];
try {
  await focusGame(client);
  if (!(await ensureMap())) { console.log(JSON.stringify({ ok: false, reason: 'no world map' })); process.exit(1); }
  const zoomSteps = await zoomMaxIn();
  console.log('max zoom-in after', zoomSteps, 'presses of the + button');
  for (const key of KEYS) {
    const cornerDrags = await toTopLeft();
    console.log('--- key', key.name, '(corner after', cornerDrags, 'drags)');
    for (const hold of HOLDS) {
      await nudge();
      const before = await parked();
      if (hold.press) await sendInput(client, { op: 'key', scan: key.scan, holdMs: hold.holdMs });
      await wait(650);
      const after = await grab();
      const shift = displacement(before, after);
      const row: Trial = { key: key.name, hold: hold.label, dx: shift?.dx ?? null, dy: shift?.dy ?? null, score: shift?.score ?? null };
      trials.push(row);
      console.log(key.name, hold.label.padEnd(5), 'dx', String(row.dx).padStart(5), 'dy', String(row.dy).padStart(5), 'score', row.score);
    }
  }
  writeFileSync(outDir + '/report.json', JSON.stringify({ zoomSteps, trials }, null, 1));
  console.log(JSON.stringify({ ok: true, zoomSteps, trials: trials.length }));
} finally {
  client.close();
}
