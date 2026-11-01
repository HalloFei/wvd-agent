#!/usr/bin/env tsx
/** Burst: what does one click at (1700,540) do to the map? Saves frames, no interpretation. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';

const outDir = '.tmp/atlas/burst';
mkdirSync(outDir, { recursive: true });
const ZOOM_IN = { x: 824, y: 1_013 };
const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();

async function grab(): Promise<Uint8Array> {
  for (let a = 0; a < 8; a += 1) { try { return (await captureJpeg(client)).bytes; } catch { await wait(150); } }
  throw new Error('no frame');
}
function luma(image: { width: number; data: Uint8Array | Uint8ClampedArray }, x: number, y: number): number {
  const at = (y * image.width + x) * 4;
  return ((image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000) | 0;
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
  // zoom in until the frame stops changing
  let previous: Float64Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 });
    await wait(700);
    const image = decodeJpeg(await grab());
    const signature = new Float64Array(120 * 135);
    for (let y = 0; y < 135; y += 1) for (let x = 0; x < 120; x += 1) {
      let sum = 0;
      for (let by = 0; by < 8; by += 1) for (let bx = 0; bx < 8; bx += 1) sum += luma(image, 480 + x * 8 + bx, y * 8 + by);
      signature[y * 120 + x] = sum / 64;
    }
    if (previous !== null) {
      let delta = 0;
      for (let k = 0; k < signature.length; k += 1) delta += Math.abs(signature[k]! - previous[k]!);
      if (delta / signature.length < 0.4) break;
    }
    previous = signature;
  }
  await wait(1_500);
  let n = 0;
  const shot = async (label: string): Promise<void> => { writeFileSync(outDir + '/' + label + '-' + String(n++).padStart(2, '0') + '.jpg', await grab()); };
  await shot('before-right');
  await sendInput(client, { op: 'tap', x: 1_700, y: 540, count: 1 });
  for (const at of [250, 500, 800, 1_200, 2_000]) { await wait(at === 250 ? 250 : at === 500 ? 250 : at === 800 ? 300 : at === 1_200 ? 400 : 800); await shot('right-' + at); }
  await wait(1_500);
  await shot('before-left');
  await sendInput(client, { op: 'tap', x: 200, y: 540, count: 1 });
  for (const at of [250, 500, 800, 1_200, 2_000]) { await wait(at === 250 ? 250 : at === 500 ? 250 : at === 800 ? 300 : at === 1_200 ? 400 : 800); await shot('left-' + at); }
  console.log(JSON.stringify({ ok: true, frames: n }));
} finally {
  client.close();
}
