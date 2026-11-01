#!/usr/bin/env tsx
/**
 * Is a click in the pillar a fixed page step? The edge probe found mid-height pillar clicks pan the
 * map (left pillar -> view left, right pillar -> view right) and top/bottom pillar clicks do nothing.
 * That would be a deterministic pan actuator — if the step is constant. This measures it: clamp to
 * the left edge with left clicks, then three right clicks, then three left clicks, with a wide search
 * window so a 480 px step is measurable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import type { PixelRect, RgbaImage } from '../src/contracts.ts';

const outDir = '.tmp/atlas/pageprobe';
mkdirSync(outDir, { recursive: true });
const PATCH = { x: 620, y: 350, width: 200, height: 160 };
const AREA: PixelRect = { x: 0, y: 0, width: 1920, height: 1080 };
const ZOOM_IN = { x: 824, y: 1_013 };
const LEFT = { x: 200, y: 540 };
const RIGHT = { x: 1_700, y: 540 };
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
  const match = findTemplate(b, AREA, { width: PATCH.width, height: PATCH.height, gray }, { scales: [1], minScore: 0.7 });
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
        for (let by = 0; by < 8; by += 1) for (let bx = 0; bx < 8; bx += 1) sum += luma(image, 480 + x * 8 + bx, y * 8 + by);
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

const log: string[] = [];
const say = (line: string): void => { console.log(line); log.push(line); };
try {
  await focusGame(client);
  for (let i = 0; i < 10; i += 1) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') break;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  await zoomMaxIn();
  await wait(1_200);
  // clamp to the left edge with left clicks
  let before = await grab();
  writeFileSync(outDir + '/left-clamp-0.jpg', before);
  let settled = 0;
  for (let i = 0; i < 10; i += 1) {
    await sendInput(client, { op: 'tap', x: LEFT.x, y: LEFT.y, count: 1 });
    await wait(1_400);
    const after = await grab();
    const delta = shift(before, after);
    say('clamp-left click ' + (i + 1) + ' dx ' + (delta === null ? 'null' : delta.dx) + ' score ' + (delta?.score ?? '-'));
    before = after;
    if (delta !== null && Math.abs(delta.dx) < 4 && Math.abs(delta.dy) < 4) { settled += 1; if (settled >= 2) break; } else settled = 0;
  }
  writeFileSync(outDir + '/left-clamp-1.jpg', before);
  // three right clicks, each measured against the clamped frame
  const base = before;
  for (let i = 0; i < 3; i += 1) {
    await sendInput(client, { op: 'tap', x: RIGHT.x, y: RIGHT.y, count: 1 });
    await wait(400);
    const mid = await grab();
    await wait(1_000);
    const after = await grab();
    const at400 = shift(base, mid);
    const full = shift(base, after);
    say('right click ' + (i + 1) + '  at 400ms dx ' + (at400 === null ? 'null' : at400.dx) + '  settled dx ' + (full === null ? 'null' : full.dx) + ' score ' + (full?.score ?? '-'));
    writeFileSync(outDir + '/right-' + (i + 1) + '.jpg', after);
  }
  // and three left clicks back
  let previous = base;
  for (let i = 0; i < 3; i += 1) {
    await sendInput(client, { op: 'tap', x: LEFT.x, y: LEFT.y, count: 1 });
    await wait(1_400);
    const after = await grab();
    const delta = shift(previous, after);
    say('left click ' + (i + 1) + ' step dx ' + (delta === null ? 'null' : delta.dx));
    previous = after;
  }
  console.log(JSON.stringify({ ok: true }));
} finally {
  writeFileSync(outDir + '/log.txt', log.join('\n'));
  client.close();
}
