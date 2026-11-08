#!/usr/bin/env node
/**
 * Record a site's node art at zoom levels 2 and 1, with the zoom **measured** end to end.
 *
 * Nothing here is assumed:
 *  - the map's + and - buttons are **found on the frame** (two dark discs side by side in the bottom band),
 *  - which one zooms in is **measured** by tapping it and watching the icon's matched scale change,
 *  - the levels are **ranked by that scale**: the most zoomed-in state is level 2, the next is level 1.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/capture-site-art.ts ffxi-gcn vnh
 *
 * The map must be open. Writes testdata/worldmap-nodes/<id>/level-<2|1>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Point, RgbaImage } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { createChannel, layoutChannel } from '../src/engine/vision/frame-channel.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import { LOCATIONS, type LocationEntry } from '../src/perception/locations.ts';
import { findTemplate, type MatchTemplate } from '../src/perception/match.ts';
import { encodeArt, SITE_ART_ROOT } from '../src/perception/site-art.ts';
import { MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const WIDE = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.67, 0.75, 0.83, 0.9, 1, 1.1, 1.21, 1.3];
const FLOOR = 0.75;

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

const lumaAt = (image: RgbaImage, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 255;
  const at = (y * image.width + x) * 4;
  return 0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!;
};

/** The icon's art: the catalogue's node is icon over banner, and the icon is the top (atlas's rule). */
function iconTemplate(entry: LocationEntry): MatchTemplate {
  const height = Math.round(entry.template.height * 0.687);
  return { width: entry.template.width, height, gray: entry.template.gray.subarray(0, height * entry.template.width) };
}

/** The two zoom buttons: dark discs of 30-70 px in the map's bottom band, side by side. */
function findZoomButtons(image: RgbaImage): { left: Point; right: Point } | null {
  const cell = 10;
  const candidates: Array<{ x: number; y: number; dark: number }> = [];
  for (let y = 900; y < image.height - 10; y += cell) {
    for (let x = 500; x < 1_400; x += cell) {
      let dark = 0;
      for (let dy = -18; dy <= 18; dy += 3) {
        for (let dx = -18; dx <= 18; dx += 3) if (lumaAt(image, x + dx, y + dy) < 45) dark += 1;
      }
      if (dark > 90) candidates.push({ x, y, dark });
    }
  }
  // Two clusters of candidates, both round and near the same height.
  const groups: Array<{ x: number; y: number; n: number }> = [];
  for (const candidate of candidates) {
    const near = groups.find((group) => Math.abs(group.x - candidate.x) < 30 && Math.abs(group.y - candidate.y) < 30);
    if (near === undefined) groups.push({ x: candidate.x, y: candidate.y, n: 1 });
    else { near.x = (near.x * near.n + candidate.x) / (near.n + 1); near.y = (near.y * near.n + candidate.y) / (near.n + 1); near.n += 1; }
  }
  const strong = groups.filter((group) => group.n >= 3).sort((left, right) => left.x - right.x);
  for (let index = 0; index + 1 < strong.length; index += 1) {
    const a = strong[index]!;
    const b = strong[index + 1]!;
    if (Math.abs(a.y - b.y) <= 20 && b.x - a.x >= 60 && b.x - a.x <= 160) {
      return { left: { x: Math.round(a.x), y: Math.round(a.y) }, right: { x: Math.round(b.x), y: Math.round(b.y) } };
    }
  }
  return null;
}

/** The best match of one site on this frame: its point, its art, and the scale it matched at. */
function locate(image: RgbaImage, entry: LocationEntry) {
  return findTemplate(image, MAP_STRIP, iconTemplate(entry), { scales: WIDE, minScore: FLOOR });
}

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error('usage: capture-site-art.ts <site-id ...>');
try {
  console.log('foreground', await focusGame(client));
  const first: RgbaImage = await (await grab()).toRgba();
  const buttons = findZoomButtons(first);
  if (buttons === null) throw new Error('the map zoom buttons were not found on this frame');
  console.log('zoom buttons', JSON.stringify(buttons));

  // Which button zooms in? Tap one and watch the matched scale of any site we can see.
  const probeId = ids.find((id) => LOCATIONS.has(id))!;
  const probe = LOCATIONS.get(probeId)!;
  const before = locate(first, probe)?.scale ?? 0;
  await sendInput(client, { op: 'tap', x: buttons.left.x, y: buttons.left.y, count: 1 });
  await wait(500);
  const after = locate(await (await grab()).toRgba(), probe)?.scale ?? 0;
  const zoomIn = after > before ? buttons.left : buttons.right;
  const zoomOut = after > before ? buttons.right : buttons.left;
  console.log('left tap changed the scale ' + before + ' -> ' + after + '; zoom in is at', JSON.stringify(zoomIn));

  const tap = async (button: Point): Promise<void> => {
    await sendInput(client, { op: 'tap', x: button.x, y: button.y, count: 1 });
    await wait(420);
  };

  // Saturate zoom-in, then walk out two steps: three states, ranked by the measured scale.
  for (let press = 0; press < 5; press += 1) await tap(zoomIn);
  const states: Array<{ image: RgbaImage; best: Map<string, ReturnType<typeof locate>> }> = [];
  for (let step = 0; step < 3; step += 1) {
    if (step > 0) await tap(zoomOut);
    const image: RgbaImage = await (await grab()).toRgba();
    const best = new Map<string, ReturnType<typeof locate>>();
    for (const id of ids) {
      const entry = LOCATIONS.get(id);
      if (entry === undefined) continue;
      const match = locate(image, entry);
      if (match !== null) best.set(id, match);
    }
    const scales = [...best.values()].map((match) => match!.scale).sort((left, right) => left - right);
    console.log('state', step, 'scales', JSON.stringify(scales));
    states.push({ image, best });
  }
  const scaleOf = (state: typeof states[number]): number => {
    const list = [...state.best.values()].map((match) => match!.scale);
    return list.length === 0 ? -1 : Math.max(...list);
  };
  const ranked = [...states].sort((left, right) => scaleOf(right) - scaleOf(left));
  for (const [index, state] of ranked.slice(0, 2).entries()) {
    const level = (index === 0 ? 2 : 1) as 1 | 2;
    for (const id of ids) {
      const match = state.best.get(id);
      if (match === null || match === undefined) {
        console.log('level', level, id, 'not on this frame');
        continue;
      }
      const gray = new Uint8Array(match.width * match.height);
      for (let y = 0; y < match.height; y += 1) {
        for (let x = 0; x < match.width; x += 1) {
          gray[y * match.width + x] = Math.round(lumaAt(state.image, match.at.x + x, match.at.y + y));
        }
      }
      const dir = join(SITE_ART_ROOT, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'level-' + level + '.json'), encodeArt({
        id, level,
        template: { width: match.width, height: match.height, gray },
        score: match.score,
        at: new Date().toISOString(),
      }));
      console.log('level', level, id, '->', match.at.x + ',' + match.at.y, 'scale', match.scale, 'score', match.score.toFixed(3));
    }
  }
} finally {
  await client.close?.();
}
