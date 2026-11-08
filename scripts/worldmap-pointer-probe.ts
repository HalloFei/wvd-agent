#!/usr/bin/env node
/**
 * Probe: the cursor is driven by WASD, and the perspective pushes when the cursor is at the edge.
 *
 * Operator, 2026-11-09: *WASD works, they control the pointer or mouse, and thus control the
 * perspective*; *move cursor to the edge and move normal towards edge line to move the perspective*.
 * The earlier probe (\`worldmap-keyprobe.ts\`) measured the **map** while the cursor sat away from the
 * edge and read no signal — right answer, wrong variable.
 *
 * What this measures, with no atlas internals: the map's own movement is the movement of a site the
 * finder can see. Each trial holds one direction key and re-finds the best site; the point's delta is
 * the map's displacement. Trials pair a **control** (cursor away from the edge: the map must not move)
 * with a **push** (same hold, after the cursor has been driven into the edge: the map must move).
 *
 * Output: a table on stdout and .tmp/pointer-probe/report.json. It leaves the map open.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput } from '../src/engine/win32.ts';
import { decodeJpeg } from '../src/engine/gdiplus.mjs';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';
import { LOCATIONS } from '../src/perception/locations.ts';
import { findSites } from '../src/perception/site-finder.ts';
import type { RgbaImage } from '../src/contracts.ts';

const SCAN = { W: 0x11, A: 0x1e, S: 0x1f, D: 0x20 } as const;
const HOLD_MS = 300;
const WAIT_MS = 400;
const outDir = '.tmp/pointer-probe';
mkdirSync(outDir, { recursive: true });

const layout = (() => {
  // The channel the engine publishes into, exactly as scripts/live.ts creates it.
  const { layoutChannel } = require('../src/engine/vision/frame-channel.ts') as typeof import('../src/engine/vision/frame-channel.ts');
  return layoutChannel({ width: 1_920, height: 1_080, slots: 2 });
})();
const { openMapping } = require('../src/engine/vision/channel-mapping.ts') as typeof import('../src/engine/vision/channel-mapping.ts');
const { createChannel } = require('../src/engine/vision/frame-channel.ts') as typeof import('../src/engine/vision/frame-channel.ts');
const channelName = 'wvd-pointer-' + process.pid + '-' + Date.now();
const mapping = openMapping(channelName, layout.bytes);
const channel = createChannel(mapping.memory, layout);
const child = startEngine({ title: 'WizardryVariantsDaphne', channel: { name: channelName, bytes: layout.bytes } });
const client = connectEngine(child, { timeoutMs: 8_000 });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The best site's point on this frame: the map's own displacement is measured through it. */
async function landmark(): Promise<{ id: string; x: number; y: number } | null> {
  const shot = await captureJpeg(client);
  const decoded = decodeJpeg(shot.bytes) as { data: Uint8Array; width: number; height: number };
  const image: RgbaImage = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  const found = findSites(image, [...LOCATIONS.values()], {
    strip: MAP_STRIP,
    iconScales: [0.45, 0.6, 0.8, 1, 1.2],
    wantTitle: false,
    minIconScore: 0.8,
  });
  const best = found[0];
  return best === undefined ? null : { id: best.id, x: best.point.x, y: best.point.y };
}

interface Trial { key: string; kind: 'control' | 'push'; dx: number; dy: number; landmark: string | null }

const trials: Trial[] = [];
try {
  console.log('foreground', await focusGame(client));
  // The map: the world-map icon, then two zoom-outs to the coarsest level (icons, no titles required).
  await sendInput(client, { op: 'tap', x: 1_177, y: 1_012, count: 1 });
  await wait(1_200);
  for (let step = 0; step < 2; step += 1) {
    await sendInput(client, { op: 'key', scan: 0x12, holdMs: 60 });   // E: zoom out
    await wait(500);
  }
  for (const [name, scan] of Object.entries(SCAN)) {
    // Control: the cursor starts near the middle, so a short hold must move the cursor only.
    const before = await landmark();
    await sendInput(client, { op: 'key', scan, holdMs: HOLD_MS });
    await wait(WAIT_MS);
    const afterControl = await landmark();
    trials.push({
      key: name,
      kind: 'control',
      dx: before !== null && afterControl !== null ? afterControl.x - before.x : 0,
      dy: before !== null && afterControl !== null ? afterControl.y - before.y : 0,
      landmark: afterControl?.id ?? null,
    });
    // Push: the same direction, held long enough that the cursor reaches the edge and the map scrolls.
    const beforePush = await landmark();
    await sendInput(client, { op: 'key', scan, holdMs: 1_500 });
    await wait(WAIT_MS);
    const afterPush = await landmark();
    trials.push({
      key: name,
      kind: 'push',
      dx: beforePush !== null && afterPush !== null ? afterPush.x - beforePush.x : 0,
      dy: beforePush !== null && afterPush !== null ? afterPush.y - beforePush.y : 0,
      landmark: afterPush?.id ?? null,
    });
  }
  for (const trial of trials) {
    console.log(trial.key, trial.kind.padEnd(8), 'dx', String(trial.dx).padStart(5), 'dy', String(trial.dy).padStart(5), trial.landmark ?? '-');
  }
  writeFileSync(outDir + '/report.json', JSON.stringify({ holdMs: HOLD_MS, trials }, null, 1) + '\n');
} finally {
  await client.close?.();
}
