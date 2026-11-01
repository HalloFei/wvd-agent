#!/usr/bin/env tsx
/**
 * Why did the control trial move? Measure the map when nothing is pressed.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-settle-probe.ts
 *
 * The key probe reported a ~90 px shift between two frames 650 ms apart with no key sent, so the
 * baseline is not still. This isolates the cause: idle frames, frames after the park tap, frames
 * after a drag (does it glide?), and frames after one D press.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';
import type { PixelRect, RgbaImage } from '../src/contracts.ts';

const outDir = '.tmp/atlas/settle';
mkdirSync(outDir, { recursive: true });
const PARK = { x: 200, y: 540 };
const PATCH = { x: 620, y: 350, width: 240, height: 200 };
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

const groups: { name: string; frames: { at: number; bytes: Uint8Array }[] }[] = [];
let writes = 0;
async function record(name: string, at: number): Promise<void> {
  const bytes = await grab();
  writeFileSync(outDir + '/' + name + '-' + String(writes++).padStart(2, '0') + '.jpg', bytes);
  const group = groups.find((g) => g.name === name);
  if (group) group.frames.push({ at, bytes }); else groups.push({ name, frames: [{ at, bytes }] });
}

try {
  await focusGame(client);
  for (let i = 0; i < 10; i += 1) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') break;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  await wait(1_500);
  // A: nothing at all
  await record('idle', 0);
  for (let i = 1; i <= 5; i += 1) { await wait(250); await record('idle', i * 250); }
  // B: after the park tap only
  await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 });
  const tapStart = performance.now();
  await record('park', 0);
  for (let i = 1; i <= 5; i += 1) { await wait(250); await record('park', i * 250); }
  void tapStart;
  // C: after a drag to the right
  await sendInput(client, { op: 'drag', x1: 760, y1: 540, x2: 1_060, y2: 540, durationMs: 450 });
  await record('drag-right', 300);
  for (const step of [700, 1200, 1700, 2200, 3000]) { await wait(step - (groups.find((g) => g.name === 'drag-right')!.frames.length * 0 + 0) > 0 ? 0 : 0); }
  await wait(400); await record('drag-right', 700);
  await wait(500); await record('drag-right', 1200);
  await wait(500); await record('drag-right', 1700);
  await wait(500); await record('drag-right', 2200);
  await wait(800); await record('drag-right', 3000);
  // D: after one D press, from a settled map
  await wait(2_000);
  await record('key-d', 0);
  await sendInput(client, { op: 'key', scan: 0x20, holdMs: 150 });
  await wait(500); await record('key-d', 500);
  await wait(1_000); await record('key-d', 1500);
  await wait(1_500); await record('key-d', 3000);
  // E: after one W press
  await record('key-w', 0);
  await sendInput(client, { op: 'key', scan: 0x11, holdMs: 150 });
  await wait(500); await record('key-w', 500);
  await wait(1_500); await record('key-w', 2000);

  const report = groups.map((group) => {
    const base = group.frames[0]!;
    return {
      group: group.name,
      frames: group.frames.map((frame) => {
        const delta = frame === base ? { dx: 0, dy: 0, score: 1 } : shift(base.bytes, frame.bytes);
        return { at: frame.at, dx: delta?.dx ?? null, dy: delta?.dy ?? null, score: delta?.score ?? null };
      }),
    };
  });
  writeFileSync(outDir + '/report.json', JSON.stringify(report, null, 1));
  for (const row of report) {
    console.log('---', row.group);
    for (const frame of row.frames) console.log('  t=' + String(frame.at).padStart(5), 'dx', String(frame.dx).padStart(5), 'dy', String(frame.dy).padStart(4), 'score', frame.score);
  }
  console.log(JSON.stringify({ ok: true }));
} finally {
  client.close();
}
