#!/usr/bin/env tsx
/**
 * What does a click in the black pillar do? The settle probe showed a tap at (200,540) pans the map
 * 270 px over 750 ms — the "park" point was never inert. This maps the trigger: which points pan,
 * which direction, how far, and whether a second tap adds more.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';
import type { PixelRect, RgbaImage } from '../src/contracts.ts';

const outDir = '.tmp/atlas/edgeprobe';
mkdirSync(outDir, { recursive: true });
const PATCH = { x: 620, y: 350, width: 240, height: 200 };
const ZOOM_IN = { x: 824, y: 1_013 };
const POINTS = [
  { name: 'right-mid', x: 1_700, y: 540 },
  { name: 'left-mid', x: 200, y: 540 },
  { name: 'left-mid-again', x: 200, y: 540 },
  { name: 'left-top', x: 200, y: 120 },
  { name: 'left-bottom', x: 200, y: 960 },
  { name: 'right-top', x: 1_700, y: 120 },
  { name: 'right-bottom', x: 1_700, y: 960 },
  { name: 'strip-top', x: 960, y: 40 },
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
function luma(image: RgbaImage, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return ((image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000) | 0;
}
function shift(before: Uint8Array, after: Uint8Array): { dx: number; dy: number; score: number } | null {
  const a = decodeJpeg(before);
  const b = decodeJpeg(after);
  const gray = new Uint8Array(PATCH.width * PATCH.height);
  for (let y = 0; y < PATCH.height; y += 1) {
    for (let x = 0; x < PATCH.width; x += 1) gray[y * PATCH.width + x] = luma(a, PATCH.x + x, PATCH.y + y);
  }
  const area: PixelRect = { x: MAP_STRIP.x, y: MAP_STRIP.y, width: MAP_STRIP.width, height: MAP_STRIP.height };
  const match = findTemplate(b, area, { width: PATCH.width, height: PATCH.height, gray }, { scales: [1], minScore: 0.7 });
  if (match === null) return null;
  return { dx: match.at.x - PATCH.x, dy: match.at.y - PATCH.y, score: Number(match.score.toFixed(3)) };
}
async function zoomMaxIn(): Promise<void> {
  let previous: Float64Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 });
    await wait(700);
    const image = decodeJpeg(await grab());
    const signature = new Float64Array(120 * 135);
    for (let y = 0; y < 135; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        let sum = 0;
        for (let by = 0; by < 8; by += 1) for (let bx = 0; bx < 8; bx += 1) sum += luma(image, MAP_STRIP.x + x * 8 + bx, y * 8 + by);
        signature[y * 120 + x] = sum / 64;
      }
    }
    if (previous !== null) {
      let delta = 0;
      for (let k = 0; k < signature.length; k += 1) delta += Math.abs(signature[k]! - previous[k]!);
      if (delta / signature.length < 0.4) return;
    }
    previous = signature;
  }
}

const rows: { point: string; at: number; dx: number | null; dy: number | null; score: number | null }[] = [];
try {
  await focusGame(client);
  for (let i = 0; i < 10; i += 1) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') break;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  await zoomMaxIn();
  await wait(1_500);
  let writeIndex = 0;
  for (const point of POINTS) {
    const before = await grab();
    writeFileSync(outDir + '/' + point.name + '-before-' + (writeIndex++) + '.jpg', before);
    await sendInput(client, { op: 'tap', x: point.x, y: point.y, count: 1 });
    for (const at of [300, 700, 1_500]) {
      await wait(at === 300 ? 300 : at === 700 ? 400 : 800);
      const after = await grab();
      const delta = shift(before, after);
      rows.push({ point: point.name, at, dx: delta?.dx ?? null, dy: delta?.dy ?? null, score: delta?.score ?? null });
    }
    await wait(800);
  }
  writeFileSync(outDir + '/report.json', JSON.stringify(rows, null, 1));
  for (const row of rows) console.log(row.point.padEnd(15), 't=' + String(row.at).padStart(5), 'dx', String(row.dx).padStart(5), 'dy', String(row.dy).padStart(4), 'score', row.score);
  console.log(JSON.stringify({ ok: true }));
} finally {
  client.close();
}
