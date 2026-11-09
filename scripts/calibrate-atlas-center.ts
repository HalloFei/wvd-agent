#!/usr/bin/env node
/**
 * Calibrate `testdata/worldmap/2026-11-10-atlas-center/center.png` against the stored atlas.
 *
 * The image is a 1000x1080 live crop of the world map's centre — sharper than the 2026-11-01 stitch
 * because it is one screen, not five upscaled tiles. The label banners are fixed-size screen art, so
 * two matched banners measure the crop's zoom directly (atlas distance / image distance) and place
 * it in the atlas frame: `image = factor * (atlas - origin)`.
 *
 *   node <tsx> scripts/calibrate-atlas-center.ts [--write]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { findTemplate } from '../src/perception/match.ts';
import { LABEL_ANCHORS, WORLD_MAP_SITES } from '../src/perception/worldmap-atlas.ts';

const IMAGE = new URL('../testdata/worldmap/2026-11-10-atlas-center/center.png', import.meta.url);
const WIDTH = 1000;
const HEIGHT = 1080;

function grayOf(file: URL, width: number, height: number): Uint8Array {
  const path = file.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (raw.length !== width * height) throw new Error(file.pathname + ': ' + raw.length + ' bytes, expected ' + width * height);
  return new Uint8Array(raw);
}

const gray = grayOf(IMAGE, WIDTH, HEIGHT);
const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
for (let index = 0; index < gray.length; index += 1) {
  rgba[index * 4] = gray[index]!;
  rgba[index * 4 + 1] = gray[index]!;
  rgba[index * 4 + 2] = gray[index]!;
  rgba[index * 4 + 3] = 255;
}
const image = { data: rgba, width: WIDTH, height: HEIGHT };
const area = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
const site = new Map(WORLD_MAP_SITES.map((entry) => [entry.id, entry]));

const found: Array<{ id: string; x: number; y: number; score: number }> = [];
for (const anchor of LABEL_ANCHORS) {
  const match = findTemplate(image, area, anchor.template, { scales: [1], minScore: 0.85 });
  if (match === null) continue;
  found.push({ id: anchor.id, x: match.at.x, y: match.at.y, score: match.score });
}
console.log('labels matched at scale 1:', found.map((hit) => hit.id + ' ' + hit.score.toFixed(3) + ' @ ' + hit.x + ',' + hit.y).join(' | '));

const factors: number[] = [];
const origins: Array<{ x: number; y: number }> = [];
for (let i = 0; i < found.length; i += 1) {
  for (let j = i + 1; j < found.length; j += 1) {
    const a = site.get(found[i]!.id)!;
    const b = site.get(found[j]!.id)!;
    const atlasDistance = Math.hypot(a.x - b.x, a.y - b.y);
    const imageDistance = Math.hypot(found[i]!.x - found[j]!.x, found[i]!.y - found[j]!.y);
    if (imageDistance < 40) continue;
    // image px per atlas px: the crop is the map drawn at this zoom.
    factors.push(imageDistance / atlasDistance);
  }
}
if (factors.length === 0) throw new Error('no label pair was far enough apart to measure the zoom');
factors.sort((left, right) => left - right);
const factor = factors[Math.floor(factors.length / 2)]!;
for (const hit of found) {
  const entry = site.get(hit.id)!;
  origins.push({ x: entry.x - hit.x / factor, y: entry.y - hit.y / factor });
}
const median = (values: number[]): number => values.slice().sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const origin = { x: median(origins.map((value) => value.x)), y: median(origins.map((value) => value.y)) };
const spread = Math.max(...origins.map((value) => Math.hypot(value.x - origin.x, value.y - origin.y)));

const calibration = {
  image: 'testdata/worldmap/2026-11-10-atlas-center/center.png',
  size: { width: WIDTH, height: HEIGHT },
  /** The zoom: image px per atlas px. `image = factor * (atlas - origin)`. */
  factor: Math.round(factor * 1000) / 1000,
  /** The atlas point under the image's top-left corner, in atlas pixels. */
  origin: { x: Math.round(origin.x), y: Math.round(origin.y) },
  labels: found.map((hit) => ({ id: hit.id, at: { x: hit.x, y: hit.y }, score: Math.round(hit.score * 1000) / 1000 })),
  factors,
  spreadPx: Math.round(spread * 10) / 10,
};
console.log(JSON.stringify(calibration, null, 2));
if (process.argv.includes('--write')) {
  const out = new URL('../testdata/worldmap/2026-11-10-atlas-center/calibration.json', import.meta.url);
  writeFileSync(out, JSON.stringify(calibration, null, 2) + '\n');
  console.log('written', out.pathname);
}
