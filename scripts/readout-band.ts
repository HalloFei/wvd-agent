#!/usr/bin/env tsx
/** Readout band diagnostic: median, shift, and the column-ink runs. */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
const luma = (d: Uint8Array, i: number): number => (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;
const X = 1010, Y = 898, W = 130, H = 16;
for (const file of process.argv.slice(2)) {
  const j = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const { data, width } = j;
  const samples: number[] = [];
  for (let y = Y; y < Y + H; y += 1) for (let x = 0; x < W; x += 1) samples.push(luma(data, (y * width + X + x) * 4));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const shift = Math.max(0, Math.round(median - 70));
  const ink: number[] = [];
  for (let x = 0; x < W; x += 1) {
    let n = 0;
    for (let y = Y; y < Y + H; y += 1) if (luma(data, (y * width + X + x) * 4) - shift > 85) n += 1;
    ink.push(n);
  }
  const lit = ink.map((n) => (n >= 1 && n < 13 ? 1 : 0));
  const runs: string[] = [];
  let start = -1;
  for (let x = 0; x <= W; x += 1) {
    const on = x < W && lit[x] === 1;
    if (on && start < 0) start = x;
    if (!on && start >= 0) { if (x - start >= 2) runs.push(start + '..' + (x - 1)); start = -1; }
  }
  console.log(file.replace(/.*[\\/]/, ''), 'median', median, 'shift', shift, 'ink max', Math.max(...ink), 'lit', lit.reduce((a, b) => a + b, 0), 'runs', runs.join(' '));
}
