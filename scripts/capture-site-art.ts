#!/usr/bin/env node
/**
 * Record a site's node art at zoom levels 1 and 2 — the legacy navigator's data, kept as ours.
 *
 * The art is captured **from the game**, not derived from the catalogue: every site's template has its
 * own native size, so the same drawn icon matches at a different scale per site (measured 2026-11-09:
 * vnh ~0.47, ffxi-gcn 0.90). A capture is one live frame, the site found with the wide bank, and the
 * matched rectangle cropped byte-for-byte into testdata/worldmap-nodes/<id>/level-<n>.json.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/capture-site-art.ts ffxi-gcn vnh
 *
 * The map must be open. Level 2 is reached by saturating the zoom-in key (extra presses clamp); level 1
 * is one press out from there. Nothing else is pressed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { createChannel, layoutChannel } from '../src/engine/vision/frame-channel.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import { LOCATIONS, type LocationEntry } from '../src/perception/locations.ts';
import { findTemplate, type MatchTemplate } from '../src/perception/match.ts';
import { encodeArt, SITE_ART_ROOT } from '../src/perception/site-art.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const ZOOM_IN = 0x10;
const ZOOM_OUT = 0x12;
const WIDE = [0.4, 0.45, 0.5, 0.55, 0.6, 0.67, 0.75, 0.83, 0.9, 1, 1.1, 1.21, 1.3];
const FLOOR = 0.78;

const layout = layoutChannel({ width: 1_920, height: 1_080, slots: 2 });
const name = 'wvd-art-' + process.pid + '-' + Date.now();
const mapping = openMapping(name, layout.bytes);
const channel = createChannel(mapping.memory, layout);
const child = startEngine({ title: 'WizardryVariantsDaphne', channel: { name, bytes: layout.bytes } });
const client = connectEngine(child, { timeoutMs: 8_000 });
const source = new Win32Capture(client, channel);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const grab = async (): Promise<Frame> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await source.capture();
    } catch (error) {
      if (attempt >= 4) throw error;
      await wait(400);
    }
  }
};

/** The catalogue's art is the whole node; the icon is its top (the atlas's own rule). */
function iconTemplate(entry: LocationEntry): MatchTemplate {
  const height = Math.round(entry.template.height * 0.687);
  return { width: entry.template.width, height, gray: entry.template.gray.subarray(0, height * entry.template.width) };
}

const lumaAt = (image: RgbaImage, x: number, y: number): number => {
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
};

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('usage: capture-site-art.ts <site-id ...>');
try {
  console.log('foreground', await focusGame(client));
  for (const level of [2, 1] as const) {
    // Level 2: saturate the zoom-in key; level 1: one press out from the saturation.
    for (let step = 0; step < 3; step += 1) {
      await sendInput(client, { op: 'key', scan: ZOOM_IN, holdMs: 60 });
      await wait(300);
    }
    if (level === 1) {
      await sendInput(client, { op: 'key', scan: ZOOM_OUT, holdMs: 60 });
      await wait(420);
    }
    const image: RgbaImage = await (await grab()).toRgba();
    for (const id of ids) {
      const entry = LOCATIONS.get(id);
      if (entry === undefined) {
        console.log(id, 'is not in the catalogue');
        continue;
      }
      const match = findTemplate(image, MAP_STRIP, iconTemplate(entry), { scales: WIDE, minScore: FLOOR });
      if (match === null) {
        console.log('level', level, id, 'not on this frame');
        continue;
      }
      const gray = new Uint8Array(match.width * match.height);
      for (let y = 0; y < match.height; y += 1) {
        for (let x = 0; x < match.width; x += 1) {
          gray[y * match.width + x] = Math.round(lumaAt(image, match.at.x + x, match.at.y + y));
        }
      }
      const dir = join(SITE_ART_ROOT, id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'level-' + level + '.json');
      writeFileSync(file, encodeArt({
        id, level,
        template: { width: match.width, height: match.height, gray },
        score: match.score,
        at: new Date().toISOString(),
      }));
      console.log('level', level, id, '->', match.at.x + ',' + match.at.y, 'scale', match.scale, 'score', match.score.toFixed(3), file);
    }
  }
} finally {
  await client.close?.();
}
