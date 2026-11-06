#!/usr/bin/env tsx
/**
 * Extracts one dungeon-map readout digit's 8×12 template, as `src/perception/map.ts` computes it.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/extract-map-digit.ts <frame.jpg>
 *
 * The atlas is missing a glyph whenever a floor's readout first reaches a digit the corpus never held
 * (2026-11-07: `X: 16` refused every frame with `readout-digit-unmatched` — the atlas had 0,1,2,3,4,5,7,9
 * and no 6). This script prints every digit run's feature as base64, so the missing one can be pasted
 * into `DIGIT_TEMPLATE_B64` with its digit named. It mirrors the parser's segmentation and glyph
 * feature exactly (the constants below are `map.ts`'s own) rather than importing private functions.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

const READOUT_X = 1010;
const READOUT_Y = 898;
const READOUT_W = 130;
const READOUT_H = 16;
const READOUT_INK_LUMA = 85;
const READOUT_LABEL_X = [1017, 1094] as const;
const READOUT_LABEL_TOLERANCE = 2;
const READOUT_LABEL_MIN_W = 9;
const READOUT_LABEL_MAX_W = 13;
const READOUT_DIGIT_MIN_W = 3;
const READOUT_DIGIT_MAX_W = 13;
const READOUT_CHROME_ROWS = 13;

const frame = process.argv[2];
if (!frame) throw new Error('usage: extract-map-digit.ts <frame.jpg> [digit]');
const still = jpeg.decode(readFileSync(frame), { useTArray: true, formatAsRGBA: true });
if (still.width !== 1920 || still.height !== 1080) throw new Error('the atlas is read at 1920x1080, got ' + still.width + 'x' + still.height);
const data: Uint8Array = still.data;
const width = still.width;
const lumaAt = (x: number, y: number): number => { const i = (y * width + x) * 4; return (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000; };

const samples: number[] = [];
for (let y = READOUT_Y; y < READOUT_Y + READOUT_H; y += 1) for (let x = 0; x < READOUT_W; x += 1) samples.push(lumaAt(READOUT_X + x, y));
samples.sort((a, b) => a - b);
const shift = Math.max(0, Math.round(samples[Math.floor(samples.length / 2)]! - 70));
const columnInk = new Uint8Array(READOUT_W);
for (let y = READOUT_Y; y < READOUT_Y + READOUT_H; y += 1) {
  for (let x = 0; x < READOUT_W; x += 1) {
    if (lumaAt(READOUT_X + x, y) - shift > READOUT_INK_LUMA) columnInk[x] += 1;
  }
}
const lit = new Uint8Array(READOUT_W);
for (let x = 0; x < READOUT_W; x += 1) lit[x] = columnInk[x]! >= 1 && columnInk[x]! < READOUT_CHROME_ROWS ? 1 : 0;
const runs: Array<[number, number]> = [];
let start = -1;
for (let x = 0; x < lit.length; x += 1) {
  if (lit[x] === 1) { if (start < 0) start = x; }
  else if (start >= 0) { if (x - start >= 2) runs.push([start, x - 1]); start = -1; }
}
if (start >= 0 && lit.length - start >= 2) runs.push([start, lit.length - 1]);
while (runs.length > 0 && runs[0]![0] === 0) {
  const [from, to] = runs[0]!;
  const labelStart = Math.max(from, READOUT_LABEL_X[0] - READOUT_X);
  if (to - labelStart + 1 >= READOUT_LABEL_MIN_W && to - labelStart + 1 <= READOUT_LABEL_MAX_W + 5) { runs[0] = [labelStart, to]; break; }
  runs.shift();
}

const feature = (from: number, to: number): string | null => {
  const x0 = READOUT_X + from;
  const x1 = READOUT_X + to;
  const sourceW = x1 - x0 + 1;
  const source = new Float64Array(READOUT_H * sourceW);
  for (let y = 0; y < READOUT_H; y += 1) {
    for (let x = 0; x < sourceW; x += 1) {
      const scaled = ((lumaAt(x0 + x, READOUT_Y + y) - shift - 70) / 170) * 255;
      source[y * sourceW + x] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
    }
  }
  const tw = 8, th = 12;
  const values = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty += 1) {
    const sy = ((ty + 0.5) * READOUT_H) / th - 0.5;
    const y0 = Math.floor(sy); const fy = sy - y0;
    const y1 = Math.min(READOUT_H - 1, Math.max(0, y0 + 1));
    const yc = Math.min(READOUT_H - 1, Math.max(0, y0));
    for (let tx = 0; tx < tw; tx += 1) {
      const sx = ((tx + 0.5) * sourceW) / tw - 0.5;
      const x0f = Math.floor(sx); const fx = sx - x0f;
      const xa = Math.min(sourceW - 1, Math.max(0, x0f));
      const xb = Math.min(sourceW - 1, Math.max(0, x0f + 1));
      const top = source[yc * sourceW + xa]! * (1 - fx) + source[yc * sourceW + xb]! * fx;
      const bottom = source[y1 * sourceW + xa]! * (1 - fx) + source[y1 * sourceW + xb]! * fx;
      values[ty * tw + tx] = Math.trunc(top * (1 - fy) + bottom * fy);
    }
  }
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i]!;
  const mean = sum / values.length;
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) { values[i]! -= mean; normSq += values[i]! * values[i]!; }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return null;
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) bytes[i] = Math.max(0, Math.min(255, Math.round(values[i]! / norm * 100 + 128)));
  return Buffer.from(bytes).toString('base64');
};

runs.forEach(([from, to], index) => {
  const w = to - from + 1;
  const digitish = w >= READOUT_DIGIT_MIN_W && w <= READOUT_DIGIT_MAX_W;
  console.log(JSON.stringify({ index, from, to, width: w, feature: digitish ? feature(from, to) : null }));
});
