#!/usr/bin/env tsx
/** Which strip/pillar points are inert? Tap a candidate, then locate; a live one moves the map. */
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { findTemplate } from '../src/perception/match.ts';
import { LABEL_ANCHORS, MAP_STRIP, MAP_ZOOM_KEYS, offsetFromMatch } from '../src/perception/worldmap-atlas.ts';

const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const mapSee = new WorldMapPerceiver();
const townSee = new TownPerceiver();
const POINTS = [
  { name: 'pillar-nw', x: 200, y: 20 },
  { name: 'pillar-ne', x: 1_720, y: 20 },
  { name: 'pillar-sw', x: 200, y: 1_060 },
  { name: 'pillar-se', x: 1_720, y: 1_060 },
  { name: 'map-top', x: 960, y: 60 },
  { name: 'map-mid', x: 960, y: 300 },
];

async function grab(): Promise<Uint8Array> {
  for (let a = 0; a < 8; a += 1) { try { return (await captureJpeg(client)).bytes; } catch { await wait(150); } }
  throw new Error('no frame');
}
async function screenOf(bytes: Uint8Array): Promise<string> {
  const frame = { atMs: performance.now(), width: 1920, height: 1080, toRgba: async () => decodeJpeg(bytes) };
  if ((await mapSee.observe(frame as never)).screen === 'worldmap') return 'worldmap';
  return (await townSee.observe(frame as never)).screen;
}
function locate(bytes: Uint8Array): { x: number; y: number } | null {
  const image = decodeJpeg(bytes);
  const votes: { x: number; y: number }[] = [];
  for (const anchor of LABEL_ANCHORS) {
    const match = findTemplate(image, MAP_STRIP, anchor.template, { scales: [1], minScore: 0.8 });
    if (match === null) continue;
    votes.push(offsetFromMatch(anchor, { x: match.at.x - MAP_STRIP.x, y: match.at.y }));
  }
  if (votes.length === 0) return null;
  let best = votes;
  for (const vote of votes) {
    const group = votes.filter((o) => Math.abs(o.x - vote.x) <= 6 && Math.abs(o.y - vote.y) <= 6);
    if (group.length > best.length) best = group;
  }
  return { x: Math.round(best.reduce((s, o) => s + o.x, 0) / best.length), y: Math.round(best.reduce((s, o) => s + o.y, 0) / best.length) };
}
try {
  await focusGame(client);
  for (let i = 0; i < 10; i += 1) {
    const screen = await screenOf(await grab());
    if (screen === 'worldmap') break;
    if (screen === 'town') { await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 }); await wait(1_800); continue; }
    await wait(1_200);
  }
  let previous: Float64Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    await sendInput(client, { op: 'key', scan: MAP_ZOOM_KEYS.out, holdMs: 60 });
    await wait(600);
    const image = decodeJpeg(await grab());
    const sig = new Float64Array(120 * 135);
    for (let y = 0; y < 135; y += 1) for (let x = 0; x < 120; x += 1) {
      let sum = 0;
      for (let by = 0; by < 8; by += 1) for (let bx = 0; bx < 8; bx += 1) {
        const at = ((y * 8 + by) * image.width + MAP_STRIP.x + x * 8 + bx) * 4;
        sum += (image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000;
      }
      sig[y * 120 + x] = sum / 64;
    }
    if (previous !== null) { let d = 0; for (let k = 0; k < sig.length; k += 1) d += Math.abs(sig[k]! - previous[k]!); if (d / sig.length < 0.6) break; }
    previous = sig;
  }
  // park the view in the middle so a pan in either direction is visible
  await sendInput(client, { op: 'drag', x1: 1_100, y1: 460, x2: 900, y2: 460, durationMs: 300 });
  await wait(900);
  let current = locate(await grab());
  console.log('start', JSON.stringify(current));
  for (const point of POINTS) {
    await sendInput(client, { op: 'tap', x: point.x, y: point.y, count: 1 });
    await wait(400);
    const next = locate(await grab());
    const delta = current !== null && next !== null ? { dx: next.x - current.x, dy: next.y - current.y } : null;
    console.log(point.name.padEnd(10), JSON.stringify(next), 'delta', JSON.stringify(delta));
    if (next !== null) current = next;
  }
  console.log(JSON.stringify({ ok: true }));
} finally {
  client.close();
}
