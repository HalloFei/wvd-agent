#!/usr/bin/env tsx
/**
 * Locate the controls on one saved frame: bright ink clusters in a band, as boxes.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/ui-locate.ts .tmp/ui/03-full.jpg \
 *     --band 600,760,1400,830 --threshold 110 --min 12
 *
 * The band is client pixels (1920x1080); the report is client pixels too, sorted by x then y. It is
 * the "locate a button" half of the UI probe: the names come from the frame, the boxes come from
 * this, and a tap is a box centre.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { lumaAt } from '../src/perception/reader.ts';

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error('usage: ui-locate.ts <frame.jpg> --band x0,y0,x1,y1 [--threshold n] [--min n]');
const flag = (name: string, fallback?: string): string | undefined => {
  const at = args.indexOf('--' + name);
  return at >= 0 ? args[at + 1] : fallback;
};
const band = (flag('band', '0,0,1920,1080') as string).split(',').map(Number);
if (band.length !== 4 || band.some((v) => !Number.isFinite(v))) throw new Error('--band needs x0,y0,x1,y1');
const threshold = Number(flag('threshold', '110'));
const minPx = Number(flag('min', '12'));

const decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
const image = { data: decoded.data, width: decoded.width, height: decoded.height };
const [x0, y0, x1, y1] = band as [number, number, number, number];
const w = Math.min(x1, image.width) - x0;
const h = Math.min(y1, image.height) - y0;
if (w <= 0 || h <= 0) throw new Error('empty band');

const mask = new Uint8Array(w * h);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    mask[y * w + x] = lumaAt(image, x0 + x, y0 + y) >= threshold ? 1 : 0;
  }
}

const seen = new Uint8Array(w * h);
interface Box { x0: number; y0: number; x1: number; y1: number; ink: number }
const boxes: Box[] = [];
for (let start = 0; start < mask.length; start += 1) {
  if (mask[start] === 0 || seen[start] === 1) continue;
  const stack = [start];
  seen[start] = 1;
  let box: Box = { x0: w, y0: h, x1: 0, y1: 0, ink: 0 };
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % w;
    const y = (index - x) / w;
    box.ink += 1;
    if (x < box.x0) box.x0 = x;
    if (y < box.y0) box.y0 = y;
    if (x > box.x1) box.x1 = x;
    if (y > box.y1) box.y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (mask[next] === 1 && seen[next] === 0) { seen[next] = 1; stack.push(next); }
    }
  }
  if (box.ink >= minPx) boxes.push(box);
}

const report = boxes
  .map((box) => ({
    x: x0 + box.x0, y: y0 + box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1,
    cx: x0 + Math.round((box.x0 + box.x1) / 2), cy: y0 + Math.round((box.y0 + box.y1) / 2), ink: box.ink,
  }))
  .sort((a, b) => a.cx - b.cx || a.cy - b.cy);
console.log(JSON.stringify({ ok: true, band, threshold, minPx, count: report.length, boxes: report }, null, 0));
