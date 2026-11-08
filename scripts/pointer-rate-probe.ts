#!/usr/bin/env node
/**
 * Probe: the pointer's and the map's rates **per zoom level**.
 *
 * Operator, 2026-11-09: the cursor is driven by WASD, and a cursor held at the map's edge pushes the
 * perspective; *the moving rate needs to be adjusted with zoom level as well*. So this measures, at each
 * of the three levels (0 max-out, 1, 2 max-in):
 *
 *  - the **pointer's** travel per hold, one hold per direction (W/A/S/D, 300 ms and 600 ms);
 *  - the **map's** scroll per hold once the cursor is at the edge (a 600 ms push), read as the
 *    displacement of a site the finder can see.
 *
 * Starts from the map already open. Ends at level 2 with the cursor where the last push left it.
 * Output: a table on stdout and .tmp/pointer-probe/rates.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Frame } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { createChannel, layoutChannel } from '../src/engine/vision/frame-channel.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import { LOCATIONS } from '../src/perception/locations.ts';
import { readPointer } from '../src/perception/pointer.ts';
import { findSites } from '../src/perception/site-finder.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const KEY = { W: 0x11, A: 0x1e, S: 0x1f, D: 0x20 } as const;
const ZOOM_OUT = 0x12;   // E
const ZOOM_IN = 0x10;    // Q
const HOLDS = [300, 600] as const;
const PUSH_MS = 600;
const SETTLE_MS = 450;
mkdirSync('.tmp/pointer-probe', { recursive: true });

const layout = layoutChannel({ width: 1_920, height: 1_080, slots: 2 });
const channelName = 'wvd-rates-' + process.pid + '-' + Date.now();
const mapping = openMapping(channelName, layout.bytes);
const channel = createChannel(mapping.memory, layout);
const child = startEngine({ title: 'WizardryVariantsDaphne', channel: { name: channelName, bytes: layout.bytes } });
const client = connectEngine(child, { timeoutMs: 8_000 });
const source = new Win32Capture(client, channel);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function grab(): Promise<Frame> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await source.capture();
    } catch (error) {
      if (attempt >= 4) throw error;
      await wait(400);
    }
  }
}

async function pointer(): Promise<{ x: number; y: number } | null> {
  return readPointer(await (await grab()).toRgba())?.at ?? null;
}

/** The best site's point: the map's own displacement, measured through the finder. */
async function landmark(): Promise<{ id: string; x: number; y: number } | null> {
  const found = findSites(await (await grab()).toRgba(), [...LOCATIONS.values()], {
    strip: MAP_STRIP,
    iconScales: [0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2],
    wantTitle: false,
    minIconScore: 0.8,
  });
  const best = found[0];
  return best === undefined ? null : { id: best.id, x: best.point.x, y: best.point.y };
}

interface Row {
  level: number;
  kind: 'pointer' | 'map';
  key: string;
  holdMs: number;
  dx: number | null;
  dy: number | null;
  landmark: string | null;
}

const rows: Row[] = [];
try {
  console.log('foreground', await focusGame(client));
  await wait(600);
  // Level 0: two zoom-outs from the map's opening level.
  for (let step = 0; step < 2; step += 1) {
    await sendInput(client, { op: 'key', scan: ZOOM_OUT, holdMs: 60 });
    await wait(SETTLE_MS);
  }
  for (const level of [0, 1, 2] as const) {
    if (level > 0) {
      await sendInput(client, { op: 'key', scan: ZOOM_IN, holdMs: 60 });
      await wait(SETTLE_MS);
    }
    // Into the middle first: a hold at the edge would pan instead of moving the cursor.
    await sendInput(client, { op: 'key', scan: KEY.W, holdMs: 500 });
    await wait(SETTLE_MS);
    for (const [name, scan] of Object.entries(KEY)) {
      for (const holdMs of HOLDS) {
        const before = await pointer();
        await sendInput(client, { op: 'key', scan, holdMs });
        await wait(SETTLE_MS);
        const after = await pointer();
        rows.push({
          level,
          kind: 'pointer',
          key: name,
          holdMs,
          dx: before !== null && after !== null ? after.x - before.x : null,
          dy: before !== null && after !== null ? after.y - before.y : null,
          landmark: null,
        });
      }
    }
    // The same direction held long enough to reach the edge, then a push: the map's rate at this level.
    const mapBefore = await landmark();
    const pointerBefore = await pointer();
    await sendInput(client, { op: 'key', scan: KEY.D, holdMs: 1_200 });
    await wait(SETTLE_MS);
    const edgePointer = await pointer();
    await sendInput(client, { op: 'key', scan: KEY.D, holdMs: PUSH_MS });
    await wait(SETTLE_MS);
    const mapAfter = await landmark();
    rows.push({
      level,
      kind: 'map',
      key: 'D',
      holdMs: PUSH_MS,
      dx: mapBefore !== null && mapAfter !== null ? mapAfter.x - mapBefore.x : null,
      dy: mapBefore !== null && mapAfter !== null ? mapAfter.y - mapBefore.y : null,
      landmark: mapAfter?.id ?? null,
    });
    console.log('level', level, 'pointer before push', JSON.stringify(pointerBefore), 'at edge', JSON.stringify(edgePointer));
  }
  for (const row of rows) {
    console.log('L' + row.level, row.kind.padEnd(7), row.key, String(row.holdMs).padStart(4), 'ms', 'dx', String(row.dx).padStart(5), 'dy', String(row.dy).padStart(5), row.landmark ?? '');
  }
  writeFileSync('.tmp/pointer-probe/rates.json', JSON.stringify({ rows }, null, 1) + '\n');
} finally {
  await client.close?.();
}
