#!/usr/bin/env tsx
/**
 * Capture a maximum-zoom tile at each cell of the map, positioned by the labels at max zoom-out.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/worldmap-maxzoom-capture.ts --out .tmp/atlas/mz
 *
 * For every cell: clamp with 缩小 (or the − button) until the frame stops changing, read the view's
 * atlas offset from the label banners (0.95-0.98, five anchors agreeing within 6 px), pan that offset
 * to the cell, press 放大 three times, capture. The tile therefore carries an absolute position; the
 * game moving on its own shows up as an offset read that disagrees and is retried, never as a silent
 * error in the map.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { LABEL_ANCHORS, MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const args = process.argv.slice(2);
const option = (n: string, d: string): string => { const i = args.indexOf('--' + n); return i >= 0 && args[i+1] !== undefined ? args[i+1]! : d; };
const outDir = option('out', '.tmp/atlas/maxzoom');
mkdirSync(outDir, { recursive: true });
const ZOOM_OUT = { x: 723, y: 1_013 };
const ZOOM_IN = { x: 824, y: 1_013 };
const PARK = { x: 200, y: 540 };
const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();
const tiles: Record<string, unknown>[] = [];

async function grab(): Promise<Uint8Array> {
  for (let a = 0; a < 8; a++) { try { return (await captureJpeg(client)).bytes; } catch { await wait(150); } }
  throw new Error('no frame');
}
async function screenOf(bytes: Uint8Array): Promise<string> {
  const frame = { atMs: performance.now(), width: 1920, height: 1080, toRgba: async () => decodeJpeg(bytes) };
  if ((await mapSee.observe(frame as never)).screen === 'worldmap') return 'worldmap';
  return (await townSee.observe(frame as never)).screen;
}
async function ensureMap(): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const s = await screenOf(await grab());
    if (s === 'worldmap') return true;
    if (s === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  return false;
}
async function parked(): Promise<Uint8Array> { await sendInput(client, { op: 'tap', x: PARK.x, y: PARK.y, count: 1 }); await wait(220); return grab(); }
function locate(bytes: Uint8Array): { x: number; y: number } | null {
  const img = decodeJpeg(bytes);
  const hits: { x: number; y: number }[] = [];
  for (const a of LABEL_ANCHORS) {
    const m = findTemplate(img, MAP_STRIP, a.template, { scales: [1], minScore: 0.8 });
    if (m) hits.push({ x: a.at.x - (m.at.x - MAP_STRIP.x), y: a.at.y - m.at.y });
  }
  if (!hits.length) return null;
  let best: any = null;
  for (const h of hits) { const group = hits.filter(o => Math.abs(o.x-h.x) <= 6 && Math.abs(o.y-h.y) <= 6); if (!best || group.length > best.g.length) best = { g: group, x: Math.round(group.reduce((s,o)=>s+o.x,0)/group.length), y: Math.round(group.reduce((s,o)=>s+o.y,0)/group.length) }; }
  return { x: best.x, y: best.y };
}
/** press the − button until two presses in a row change nothing */
async function toMaxOut(): Promise<void> {
  let previous: Float64Array | null = null;
  for (let i = 0; i < 10; i += 1) {
    await sendInput(client, { op: 'tap', x: ZOOM_OUT.x, y: ZOOM_OUT.y, count: 1 });
    await wait(650);
    const bytes = await grab();
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const sig = new Float64Array(120*135);
    for (let y=0;y<135;y++) for (let x=0;x<120;x++) { let s=0; for(let by=0;by<8;by++)for(let bx=0;bx<8;bx++){const at=((y*8+by)*img.width+MAP_STRIP.x+x*8+bx)*4;s+=(img.data[at]*299+img.data[at+1]*587+img.data[at+2]*114)/1000;} sig[y*120+x]=s/64; }
    if (previous !== null) { let d=0; for (let k=0;k<sig.length;k++) d+=Math.abs(sig[k]-previous[k]); if (d/sig.length < 0.4) return; }
    previous = sig;
  }
}
async function panTo(target: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  let current = locate(await parked());
  for (let i = 0; i < 6; i += 1) {
    if (current === null) return null;
    const dx = target.x - current.x, dy = target.y - current.y;
    if (Math.abs(dx) <= 12 && Math.abs(dy) <= 12) return current;
    const dragX = Math.max(-400, Math.min(400, Math.round(-dx / 2.2)));
    const dragY = Math.max(-400, Math.min(400, Math.round(-dy / 2.2)));
    await sendInput(client, { op: 'drag', x1: 760, y1: 540, x2: 760 + dragX, y2: 540 + dragY, durationMs: 500 });
    await wait(1_300);
    current = locate(await parked());
  }
  return current;
}
try {
  await focusGame(client);
  if (!(await ensureMap())) { console.log('the world map is not reachable'); process.exit(1); }
  const cells = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 416 }, { x: 400, y: 416 }];
  for (const cell of cells) {
    await toMaxOut();
    const reached = await panTo(cell);
    if (reached === null) { console.log('cell', cell, 'lost the label anchor'); continue; }
    for (let i = 0; i < 3; i += 1) { await sendInput(client, { op: 'tap', x: ZOOM_IN.x, y: ZOOM_IN.y, count: 1 }); await wait(700); }
    const bytes = await parked();
    const name = 'cell-' + reached.x + '_' + reached.y + '.jpg';
    writeFileSync(outDir + '/' + name, bytes);
    tiles.push({ cell: reached, file: name, centre: { x: reached.x + 480, y: reached.y + 540 } });
    console.log('captured cell', reached.x, reached.y, 'centre', reached.x + 480, reached.y + 540);
    writeFileSync(outDir + '/tiles.json', JSON.stringify(tiles, null, 1));
  }
  console.log(JSON.stringify({ ok: true, tiles }));
} finally {
  client.close();
}
