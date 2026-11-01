#!/usr/bin/env tsx
/** Is the title strip darker than the scene beside it? A relative gate candidate. */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
const luma = (d: Uint8Array, i: number): number => (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
function mean(d: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number): number {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { s += luma(d, (y * w + x) * 4); n += 1; }
  return s / n;
}
for (const file of process.argv.slice(2)) {
  const j = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const { data, width } = j;
  const strip = mean(data, width, 700, 1300, 20, 42);
  const left = mean(data, width, 100, 400, 20, 42);
  const right = mean(data, width, 1520, 1820, 20, 42);
  const panel = mean(data, width, 700, 1300, 500, 560);
  console.log(file.replace(/.*[\\/]/, '').padEnd(20), 'strip', strip.toFixed(1), 'outside', ((left + right) / 2).toFixed(1), 'panel', panel.toFixed(1));
}
