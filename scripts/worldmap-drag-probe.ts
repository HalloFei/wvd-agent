#!/usr/bin/env tsx
/**
 * A clean drag measurement: no park tap anywhere (that point pans the map), settle detected by
 * waiting until two frames are identical, then the shift is measured. Three horizontal drags and
 * two vertical ones at max zoom-in.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';
import type { PixelRect } from '../src/contracts.ts';

const outDir = '.tmp/atlas/dragprobe';
mkdirSync(outDir, { recursive: true });
const PATCH = { x: 620, y: 350, width: 200, height: 160 };
const AREA: PixelRect = { x: 0, y: 0, width: 1920, height: 1080 };
const ZOOM_IN = { x: 824, y: 1_013 };
const DRAGS = [
  { name: 'east-400', dx: 400, dy: 0 },
  { name: 'west-400', dx: -400, dy: 0 },
  { name: 'east-300', dx: 300, dy: 0 },
  { name: 'south-300', dx: 0, dy: 300 },
  { name: 'north-300', dx: 0, dy: -300 },
];
const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();

async function grab(): Promise<Uint8Array> {
  for (let a = 0; a < 8; a += 1) { try { return (await captureJpeg(client)).bytes; } catch { await wait(150); } }
  throw new Error('no frame');
}
function lumaOf(image: { width: number; data: Uint8Array | Uint8ClampedArray }, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return ((image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000) | 0;
}
function signatureOf(bytes: Uint8Array): Float64Array {
  const image = decodeJpeg(bytes);
  const signature = new Float64Array(120 * 135);
  for (let y = 0; y < 135; y += 1) for (let x = 0; x < 120; x += 1) {
    let sum = 0;
    for (let by = 0; by < 8; by += 1) for (let bx = 0; bx < 8; bx += 1) sum += lumaOf(image, 480 + x * 8 + bx, y * 8 + by);
    signature[y * 120 + x] = sum / 64;
  }
  return signature;
}
function distance(a: Float64Array, b: Float64Array): number {
  let delta = 0;
  for (let i = 0; i < a.length; i += 1) delta += Math.abs(a[i]! - b[i]!);
  return delta / a.length;
}
function shift(before: Uint8Array, after: Uint8Array): { dx: number; dy: number; score: number } | null {
  const a = decodeJpeg(before);
  const b = decodeJpeg(after);
  const gray = new Uint8Array(PATCH.width * PATCH.height);
  for (let y = 0; y < PATCH.height; y += 1) for (let x = 0; x < PATCH.width; x += 1) gray[y * PATCH.width + x] = lumaOf(a, PATCH.x + x, PATCH.y + y);
  const match = findTemplate(b, AREA, { width: PATCH.width, height: PATCH.height, gray }, { scales: [1], minScore: 0.7 });
  if (match === null) return null;
  return { dx: match.at.x - PATCH.x, dy: match.at.y - PATCH.y, score: Number(match.score.toFixed(3)) };
}
/** wait until two consecutive frames are identical (the map has stopped animating) */
async function settle(limit = 12): Promise<Uint8Array> {
  let previous = await grab();
  let previousSig = signatureOf(previous);
  for (let i = 0; i < limit; i += 1) {
    await wait(200);
    const next = await grab();
    const sig = signatureOf(next);
    if (distance(previousSig, sig) < 0.4) return next;
    previous = next; previousSig = sig;
  }
  return previous;
}
try {
  await focusGame(client);
  for (let i = 0; i < 10; i += 1) {
    const bytes = await grab();
    const frame = { atMs: performance.now(), width: 1920, height: 1080, toRgba: async () => decodeJpeg(bytes) };
    if ((await mapSee.observe(frame as never)).screen === 'worldmap') break;
    if ((await townSee.observe(frame as never)).screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  let previousSig: Float64Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 });
    await wait(700);
    const sig = signatureOf(await grab());
    if (previousSig !== null && distance(previousSig, sig) < 0.4) break;
    previousSig = sig;
  }
  await wait(1_000);
  for (const drag of DRAGS) {
    const before = await settle();
    writeFileSync(outDir + '/' + drag.name + '-before.jpg', before);
    await sendInput(client, { op: 'drag', x1: 760, y1: 540, x2: 760 + drag.dx, y2: 540 + drag.dy, durationMs: 450 });
    const after = await settle();
    const delta = shift(before, after);
    console.log(drag.name.padEnd(10), 'drag', String(drag.dx).padStart(4), String(drag.dy).padStart(4), '-> map moved dx', String(delta?.dx).padStart(5), 'dy', String(delta?.dy).padStart(4), 'score', delta?.score);
  }
  console.log(JSON.stringify({ ok: true }));
} finally {
  client.close();
}
