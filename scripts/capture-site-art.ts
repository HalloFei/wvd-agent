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

/** The map's own zoom buttons, client pixels — measured on the live map (2026-11-09). */
const ZOOM_MINUS_AT = { x: 956, y: 1_043 } as const;
const ZOOM_PLUS_AT = { x: 1_070, y: 1_043 } as const;
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

/** One press of the on-screen zoom buttons (the map's own + and - circles). */
async function tapZoom(direction: 'in' | 'out'): Promise<void> {
  const at = direction === 'in' ? ZOOM_PLUS_AT : ZOOM_MINUS_AT;
  await sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 1 });
  await wait(320);
}

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('usage: capture-site-art.ts <site-id ...>');
try {
  console.log('foreground', await focusGame(client));
  // **The level is measured, not counted** (operator, 2026-11-09: the +/- buttons are the truth — the
  // keyboard keys were what inverted the first capture's labels). Four zoom states are walked: saturate
  // the zoom-in button five times, then out twice. For each state every site is matched with the wide
  // bank, and its **scale** says how far in the map is. The state with the largest scale is level 2, the
  // next is level 1; the files are written from those states, whichever physical zoom produced them.
  const states: Array<{ image: RgbaImage; matches: Map<string, { at: { x: number; y: number }; width: number; height: number; scale: number; score: number }> }> = [];
  for (let step = 0; step < 4; step += 1) {
    if (step === 0) {
      for (let press = 0; press < 5; press += 1) {
        await tapZoom('in');
      }
    } else {
      await tapZoom('out');
    }
    const state: RgbaImage = await (await grab()).toRgba();
    const matches = new Map<string, { at: { x: number; y: number }; width: number; height: number; scale: number; score: number }>();
    for (const id of ids) {
      const entry = LOCATIONS.get(id);
      if (entry === undefined) continue;
      const match = findTemplate(state, MAP_STRIP, iconTemplate(entry), { scales: WIDE, minScore: FLOOR });
      if (match !== null) matches.set(id, match);
    }
    const scales = [...matches.values()].map((match) => match.scale).sort((left, right) => left - right);
    console.log('state', step, 'scales', JSON.stringify(scales));
    states.push({ image: state, matches });
  }
  // Rank by scale: the largest scale is the most zoomed-in state (level 2), the next is level 1.
  const ranked = [...states].sort((left, right) => {
    const rank = (state: typeof left): number => {
      const scales = [...state.matches.values()].map((match) => match.scale);
      return scales.length === 0 ? -1 : Math.max(...scales);
    };
    return rank(right) - rank(left);
  });
  for (const [index, state] of ranked.slice(0, 2).entries()) {
    const level = (index === 0 ? 2 : 1) as 1 | 2;
    const image = state.image;
    for (const id of ids) {
      const match = state.matches.get(id);
      if (match === undefined) {
        console.log('level', level, id, 'not on this frame');
        continue;
      }
      const entry = LOCATIONS.get(id);
      if (entry === undefined) {
        console.log(id, 'is not in the catalogue');
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
