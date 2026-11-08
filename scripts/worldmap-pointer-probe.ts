#!/usr/bin/env node
/**
 * Probe: WASD drives the **cursor**, and the cursor at the edge pushes the perspective.
 *
 * Operator, 2026-11-09: *WASD works, they control the pointer or mouse, and thus control the
 * perspective*; *look for cursor position change after keyboard input*. The earlier keyprobe measured
 * map displacement with the cursor parked away from the edge and read no signal — the right answer to
 * the wrong question. This one measures the cursor itself: a frame's near-white arrow, found before and
 * after one key hold.
 *
 * Also measured: once the cursor is at the edge, the same hold must move the **map** — read as the
 * displacement of a site the finder can see.
 *
 * Output: a table on stdout and .tmp/pointer-probe/report.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { createChannel, layoutChannel } from '../src/engine/vision/frame-channel.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import { LOCATIONS } from '../src/perception/locations.ts';
import { findSites } from '../src/perception/site-finder.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const SCAN = { W: 0x11, A: 0x1e, S: 0x1f, D: 0x20 } as const;
const HOLD_MS = 300;
const PUSH_MS = 1_500;
const WAIT_MS = 400;
const outDir = '.tmp/pointer-probe';
mkdirSync(outDir, { recursive: true });

const layout = layoutChannel({ width: 1_920, height: 1_080, slots: 2 });
const channelName = 'wvd-pointer-' + process.pid + '-' + Date.now();
const mapping = openMapping(channelName, layout.bytes);
const channel = createChannel(mapping.memory, layout);
const child = startEngine({ title: 'WizardryVariantsDaphne', channel: { name: channelName, bytes: layout.bytes } });
const client = connectEngine(child, { timeoutMs: 8_000 });
const source = new Win32Capture(client, channel);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A frame, with the engine's warm-up retry: the first capture after a start can time out. */
async function grab(): Promise<Frame> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await grab();
    } catch (error) {
      if (attempt >= 4) throw error;
      await wait(400);
    }
  }
}

/** The cursor: the frame's near-white arrow, as the centroid of the brightest compact cluster. */
export function findCursor(image: RgbaImage): { x: number; y: number; pixels: number } | null {
  const cell = 8;
  const columns = Math.floor(image.width / cell);
  const rows = Math.floor(image.height / cell);
  const counts = new Uint16Array(columns * rows);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const at = (y * image.width + x) * 4;
      const luma = 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
      if (luma < 242) continue;
      counts[Math.floor(y / cell) * columns + Math.floor(x / cell)] += 1;
    }
  }
  // The cursor is a small solid arrow: a cell cluster of 6+ white cells, densest one wins.
  let best = { index: -1, sum: 0 };
  for (let row = 1; row < rows - 1; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += counts[(row + dy) * columns + column + dx]!;
      if (sum > best.sum) best = { index: row * columns + column, sum };
    }
  }
  if (best.index < 0 || best.sum < 24) return null;
  const row = Math.floor(best.index / columns);
  const column = best.index % columns;
  return { x: column * cell + cell / 2, y: row * cell + cell / 2, pixels: best.sum };
}

/** The best site's point: the map's own displacement, measured through the finder. */
async function landmark(frame: Frame): Promise<{ id: string; x: number; y: number } | null> {
  const image = await frame.toRgba();
  const found = findSites(image, [...LOCATIONS.values()], {
    strip: MAP_STRIP,
    iconScales: [0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2],
    wantTitle: false,
    minIconScore: 0.8,
  });
  const best = found[0];
  return best === undefined ? null : { id: best.id, x: best.point.x, y: best.point.y };
}

interface Trial { key: string; kind: 'cursor' | 'push'; cursorDx: number | null; cursorDy: number | null; mapDx: number | null; mapDy: number | null; landmark: string | null }

const trials: Trial[] = [];
try {
  console.log('foreground', await focusGame(client));
  // The map is expected **already open** (the caller checks with `scripts/live.mjs status`): tapping
  // the world-map icon while the map is up would click a spot on the map itself.
  await wait(600);
  for (let step = 0; step < 2; step += 1) {
    await sendInput(client, { op: 'key', scan: 0x12, holdMs: 60 });
    await wait(450);
  }
  const frame = await grab();
  console.log('map?', (await findSites(await frame.toRgba(), [...LOCATIONS.values()], { strip: MAP_STRIP, iconScales: [0.45, 0.6, 0.8, 1], wantTitle: false, minIconScore: 0.8 })).slice(0, 3).map((candidate) => candidate.id + ' ' + candidate.point.x + ',' + candidate.point.y).join(' | '));

  for (const [name, scan] of Object.entries(SCAN)) {
    const before = await grab();
    const cursorBefore = findCursor(await before.toRgba());
    const mapBefore = await landmark(before);
    await sendInput(client, { op: 'key', scan, holdMs: HOLD_MS });
    await wait(WAIT_MS);
    const after = await grab();
    const cursorAfter = findCursor(await after.toRgba());
    const mapAfter = await landmark(after);
    trials.push({
      key: name,
      kind: 'cursor',
      cursorDx: cursorBefore !== null && cursorAfter !== null ? cursorAfter.x - cursorBefore.x : null,
      cursorDy: cursorBefore !== null && cursorAfter !== null ? cursorAfter.y - cursorBefore.y : null,
      mapDx: mapBefore !== null && mapAfter !== null ? mapAfter.x - mapBefore.x : null,
      mapDy: mapBefore !== null && mapAfter !== null ? mapAfter.y - mapBefore.y : null,
      landmark: mapAfter?.id ?? null,
    });
    // Push: hold the same direction long enough for the cursor to reach the edge and scroll the map.
    const pushBefore = await grab();
    const pushCursorBefore = findCursor(await pushBefore.toRgba());
    const pushMapBefore = await landmark(pushBefore);
    await sendInput(client, { op: 'key', scan, holdMs: PUSH_MS });
    await wait(WAIT_MS);
    const pushAfter = await grab();
    const pushCursorAfter = findCursor(await pushAfter.toRgba());
    const pushMapAfter = await landmark(pushAfter);
    trials.push({
      key: name,
      kind: 'push',
      cursorDx: pushCursorBefore !== null && pushCursorAfter !== null ? pushCursorAfter.x - pushCursorBefore.x : null,
      cursorDy: pushCursorBefore !== null && pushCursorAfter !== null ? pushCursorAfter.y - pushCursorBefore.y : null,
      mapDx: pushMapBefore !== null && pushMapAfter !== null ? pushMapAfter.x - pushMapBefore.x : null,
      mapDy: pushMapBefore !== null && pushMapAfter !== null ? pushMapAfter.y - pushMapBefore.y : null,
      landmark: pushMapAfter?.id ?? null,
    });
  }
  for (const trial of trials) {
    console.log(trial.key, trial.kind.padEnd(6), 'cursor', trial.cursorDx, trial.cursorDy, 'map', trial.mapDx, trial.mapDy, trial.landmark ?? '-');
  }
  writeFileSync(outDir + '/report.json', JSON.stringify({ holdMs: HOLD_MS, pushMs: PUSH_MS, trials }, null, 1) + '\n');
} finally {
  await client.close?.();
}
