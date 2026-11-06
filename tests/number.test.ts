import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { readInteger, type GlyphMask } from '../src/perception/number.ts';

/**
 * The numerals reader is general: it classifies a glyph's shape, not a committed template per digit.
 * Its test input is a **frame** — the live map's readout, X: 16  Y: 4 — so no shape is stored here and
 * a new digit needs rules, not another base64 row.
 */
const FRAME = new URL('../testdata/screens/2026-11-07-map-refused/map-1920.jpg', import.meta.url);
const READOUT_X = 1010;
const READOUT_Y = 898;
const READOUT_W = 130;
const READOUT_H = 16;
const INK = 85;
const LABEL_X = [1017, 1094] as const;

interface Band {
  readonly runs: ReadonlyArray<readonly [number, number]>;
  readonly glyph: (from: number, to: number) => GlyphMask;
}

async function readBand(): Promise<Band> {
  const decoded = jpeg.decode(await readFile(FRAME), { useTArray: true, formatAsRGBA: true });
  const width = decoded.width;
  const data: Uint8Array = decoded.data;
  const luma = (x: number, y: number): number => {
    const offset = (y * width + x) * 4;
    return (data[offset]! * 299 + data[offset + 1]! * 587 + data[offset + 2]! * 114) / 1000;
  };
  const samples: number[] = [];
  for (let y = 0; y < READOUT_H; y += 1) for (let x = 0; x < READOUT_W; x += 1) samples.push(luma(READOUT_X + x, READOUT_Y + y));
  samples.sort((a, b) => a - b);
  const shift = Math.max(0, Math.round(samples[Math.floor(samples.length / 2)]! - 70));
  const ink = new Uint16Array(READOUT_W);
  for (let y = 0; y < READOUT_H; y += 1) {
    for (let x = 0; x < READOUT_W; x += 1) if (luma(READOUT_X + x, READOUT_Y + y) - shift > INK) ink[x] = (ink[x] ?? 0) + 1;
  }
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < READOUT_W; x += 1) {
    if ((ink[x] ?? 0) > 0) { if (start < 0) start = x; }
    else if (start >= 0) { if (x - start >= 2) runs.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, READOUT_W - 1]);
  const glyph = (from: number, to: number): GlyphMask => {
    const bits: boolean[] = [];
    for (let y = 0; y < READOUT_H; y += 1) {
      for (let x = from; x <= to; x += 1) bits.push(luma(READOUT_X + x, READOUT_Y + y) - shift > INK);
    }
    return { width: to - from + 1, height: READOUT_H, ink: bits };
  };
  return { runs, glyph };
}

/** The digit runs between two labels, with the colon (a run of four columns or fewer) dropped. */
function digits(band: Band, from: number, to: number): GlyphMask[] {
  const label = band.runs.findIndex(([start]) => Math.abs(READOUT_X + start - from) <= 2);
  const nextLabel = to === -1 ? band.runs.length : band.runs.findIndex(([start]) => Math.abs(READOUT_X + start - to) <= 2);
  if (label < 0) return [];
  const picked: GlyphMask[] = [];
  let index = label + 1;
  if (index < nextLabel && band.runs[index]![1] - band.runs[index]![0] + 1 <= 4) index += 1;
  for (; index < nextLabel; index += 1) {
    const [a, b] = band.runs[index]!;
    if (b - a + 1 <= 4) continue;
    picked.push(band.glyph(a, b));
  }
  return picked;
}

describe('the numerals reader', () => {
  it('reads the live readout X: 16  Y: 4 from the frame, with no per-digit template', async () => {
    const band = await readBand();
    expect(readInteger(digits(band, LABEL_X[0], LABEL_X[1]))).toEqual({ value: 16, digits: '16' });
    expect(readInteger(digits(band, LABEL_X[1], -1))).toEqual({ value: 4, digits: '4' });
  });

  it('refuses an empty run rather than inventing a number', () => {
    expect(readInteger([])).toBeNull();
  });
});
