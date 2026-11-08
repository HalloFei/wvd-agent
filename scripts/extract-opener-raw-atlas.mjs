#!/usr/bin/env node
/**
 * The raw-era 陷阱 digit atlas: the same feature the parser computes, taken from a **lossless** panel
 * capture instead of the q75 JPEG fixtures the 2026-10-24 atlas was recorded from.
 *
 *   node scripts/extract-opener-raw-atlas.mjs --crop .tmp/panel-raw-2026-11-08.rgba \
 *     --rect 680,590,1240,1000 --values <measurements.json>
 *
 * Why: the vision module delivers raw BGRA now, and raw glyphs miss the JPEG-era mean for one of the
 * twelve fields (live 2026-11-08: template 0/0 on the panel, 12/12 after a q75 re-encode, 11+1 with
 * the OCR tier). The seam keeps several instances per digit, so both eras can live in the atlas.
 *
 * The geometry comes from the parser itself (`OPENER_SLOTS`, `OPENER_FIELD_GEOMETRY`); only the
 * feature math is mirrored, exactly as `extract-opener-digits.mjs` mirrors it.
 */
import { readFileSync } from 'node:fs';
import { OPENER_FIELD_GEOMETRY, OPENER_SLOTS } from '../src/perception/opener.ts';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at >= 0 ? args[at + 1] : fallback;
};
const cropPath = arg('crop');
const [cx0, cy0, cx1, cy1] = arg('rect', '0,0,0,0').split(',').map(Number);
const valuesPath = arg('values');
if (!cropPath || valuesPath === undefined) {
  console.error('usage: --crop <rgba> --rect x0,y0,x1,y1 --values <measurements.json>');
  process.exit(1);
}

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;
const crop = readFileSync(cropPath);
const cw = cx1 - cx0;
const ch = cy1 - cy0;
if (crop.length !== cw * ch * 4) throw new Error('crop is ' + crop.length + ' bytes, expected ' + cw * ch * 4);

// Blit the crop into the frame the parser expects: every band it reads is inside the crop's rect.
const data = new Uint8Array(REFERENCE_WIDTH * REFERENCE_HEIGHT * 4);
for (let y = 0; y < ch; y += 1) {
  for (let x = 0; x < cw; x += 1) {
    const from = (y * cw + x) * 4;
    const to = ((cy0 + y) * REFERENCE_WIDTH + cx0 + x) * 4;
    data[to] = crop[from];
    data[to + 1] = crop[from + 1];
    data[to + 2] = crop[from + 2];
    data[to + 3] = 255;
  }
}

const luma = (x, y) => {
  const i = (y * REFERENCE_WIDTH + x) * 4;
  return (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
};
const G = OPENER_FIELD_GEOMETRY;
const INK_LUMA_DELTA = 55;
const MIN_GLYPH_COLUMNS = 3;
const MAX_GLYPH_COLUMNS = 12;
const DIGIT_PITCH = 9.4;
const CELL_W = 10;
const CELL_H = 14;
const FEATURE_W = 8;
const FEATURE_H = 10;

const measurements = JSON.parse(readFileSync(valuesPath, 'utf8'));

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

function fieldBand(slot, field) {
  const { rect } = OPENER_SLOTS[slot];
  const offsets = field === 'detect' ? [G.trap.detect, G.trap.detect + G.bandHeight] : [G.trap.disarm, G.trap.disarm + G.bandHeight];
  return { x0: rect.x0 + G.numberLeft, x1: rect.x1 - G.numberRightInset, y0: rect.y0 + offsets[0], y1: rect.y0 + offsets[1] };
}

/** One glyph's 10 x 14 cell (intensity 0-1), as the parser builds it. */
function cellOf(band, from, to, background) {
  let top = -1;
  let bottom = -1;
  for (let y = band.y0; y < band.y1; y += 1) {
    let any = false;
    for (let x = from; x <= to; x += 1) if (luma(x, y) - background >= INK_LUMA_DELTA) { any = true; break; }
    if (any) { if (top < 0) top = y; bottom = y; }
  }
  if (top < 0) return null;
  const glyphWidth = to - from + 1;
  const glyphHeight = bottom - top + 1;
  const cell = new Float64Array(CELL_W * CELL_H);
  let peak = 1;
  for (let y = 0; y < glyphHeight; y += 1) for (let x = 0; x < glyphWidth; x += 1) peak = Math.max(peak, luma(from + x, top + y) - background);
  const offsetX = Math.floor((CELL_W - glyphWidth) / 2);
  const offsetY = Math.floor((CELL_H - glyphHeight) / 2);
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const cx = offsetX + x;
      const cy = offsetY + y;
      if (cx < 0 || cx >= CELL_W || cy < 0 || cy >= CELL_H) continue;
      cell[cy * CELL_W + cx] = Math.max(0, luma(from + x, top + y) - background) / peak;
    }
  }
  return cell;
}

function runs(band, background) {
  const width = band.x1 - band.x0;
  const ink = new Uint16Array(width);
  for (let y = band.y0; y < band.y1; y += 1) {
    for (let x = band.x0; x < band.x1; x += 1) if (luma(x, y) - background >= INK_LUMA_DELTA) ink[x - band.x0] += 1;
  }
  const atoms = [];
  let start = -1;
  for (let column = 0; column <= width; column += 1) {
    const lit = column < width && ink[column] > 0;
    if (lit && start < 0) start = column;
    else if (!lit && start >= 0) {
      const from = band.x0 + start;
      const to = band.x0 + column - 1;
      const glyphWidth = to - from + 1;
      if (glyphWidth >= MIN_GLYPH_COLUMNS) {
        if (glyphWidth <= MAX_GLYPH_COLUMNS) atoms.push([from, to]);
        else {
          const count = Math.max(2, Math.round(glyphWidth / DIGIT_PITCH));
          for (let k = 0; k < count; k += 1) {
            atoms.push([from + Math.round((k * glyphWidth) / count), from + Math.round(((k + 1) * glyphWidth) / count) - 1]);
          }
        }
      }
      start = -1;
    }
  }
  return atoms;
}

const samples = new Map();
for (const [slot, member] of measurements.members.entries()) {
  for (const field of ['detect', 'disarm']) {
    const band = fieldBand(slot, field);
    const background = median((() => { const v = []; for (let y = band.y0; y < band.y1; y += 1) for (let x = band.x0; x < band.x1; x += 1) v.push(luma(x, y)); return v; })());
    const atoms = runs(band, background);
    if (args.includes('--debug')) {
      console.log('slot ' + slot + ' ' + field + ' band x' + band.x0 + '..' + band.x1 + ' y' + band.y0 + '..' + band.y1
        + ' bg ' + background + ' atoms ' + JSON.stringify(atoms) + ' firstOffset ' + (atoms.length ? atoms[0][0] - band.x0 : 'n/a'));
    }
    const expected = String(member[field]);
    if (atoms.length !== expected.length) {
      console.error('slot ' + slot + ' ' + field + ': ' + atoms.length + ' glyphs, measurements say ' + expected.length);
      process.exit(1);
    }
    for (const [index, [from, to]] of atoms.entries()) {
      const cell = cellOf(band, from, to, background);
      if (cell === null) { console.error('slot ' + slot + ' ' + field + ': no ink'); process.exit(1); }
      const digit = expected[index];
      if (!samples.has(digit)) samples.set(digit, []);
      samples.get(digit).push(cell);
    }
  }
}

/** The parser's cell (10 x 14) resized bilinearly to the stored 8 x 10 feature, as 0-255 bytes. */
function toFeature(cell) {
  const out = new Float64Array(FEATURE_W * FEATURE_H);
  for (let ty = 0; ty < FEATURE_H; ty += 1) {
    const sy = ((ty + 0.5) * CELL_H) / FEATURE_H - 0.5;
    const y0f = Math.floor(sy);
    const fy = sy - y0f;
    const ya = Math.min(CELL_H - 1, Math.max(0, y0f));
    const yb = Math.min(CELL_H - 1, Math.max(0, y0f + 1));
    for (let tx = 0; tx < FEATURE_W; tx += 1) {
      const sx = ((tx + 0.5) * CELL_W) / FEATURE_W - 0.5;
      const x0f = Math.floor(sx);
      const fx = sx - x0f;
      const xa = Math.min(CELL_W - 1, Math.max(0, x0f));
      const xb = Math.min(CELL_W - 1, Math.max(0, x0f + 1));
      const top = cell[ya * CELL_W + xa] * (1 - fx) + cell[ya * CELL_W + xb] * fx;
      const bottom = cell[yb * CELL_W + xa] * (1 - fx) + cell[yb * CELL_W + xb] * fx;
      out[ty * FEATURE_W + tx] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

const bytesOf = (cell) => {
  const feature = toFeature(cell);
  const bytes = Buffer.alloc(feature.length);
  for (let i = 0; i < feature.length; i += 1) bytes[i] = Math.trunc(Math.min(255, Math.max(0, feature[i] * 255)));
  return bytes.toString('base64');
};
const digits = [...samples.keys()].sort();
console.log('digits covered:', digits.join(' '));
// Every instance, kept apart: the raw glyph's sub-pixel phase differs card by card, so a mean blurs
// exactly the detail that makes it match (the heart atlas is built this way for the same reason).
for (const digit of digits) {
  const cells = samples.get(digit);
  console.log("  '" + digit + "': [");
  for (const cell of cells) console.log("    '" + bytesOf(cell) + "',");
  console.log('  ],');
}