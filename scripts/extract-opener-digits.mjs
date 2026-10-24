#!/usr/bin/env node
/**
 * Provenance for the digit atlases embedded in `src/perception/chest.ts` (the opener panel).
 *
 * This script is documentation, not part of `pnpm test` / CI. Unlike `extract-map-templates.mjs` it
 * needs no `ffmpeg`: the opener fixture is committed as JPEGs (`testdata/chest/2026-10-24-opener/`)
 * and `jpeg-js` is already a dependency, so the script decodes exactly what the parser decodes.
 *
 * Usage:
 *   node scripts/extract-opener-digits.mjs [--frame <jpg>] [--verify]
 *
 * What it reads, and why:
 *
 * - **The twelve 陷阱 numbers** come from `measurements.json` (the operator's reading of the same
 *   screen), never from the pixels: card order is that file's `members` order, and each value is its
 *   `detect` / `disarm` as a digit string. The twelve values are `38 49 28 50 34 38 92 105 62 43 77
 *   79`, which contain every digit 0–9, so the atlas is complete from one frame.
 * - **The five 心 numerals** come from `measurements.json`'s `willpower` column (read off
 *   `panel-00.jpg`): cards 1–3 and 6 show `100`, card 5 shows `90`, and **card 4 (DragonSlayer)
 *   draws no heart at all**, so its value is `null`. They give the digits 0, 1 and 9 of the heart's
 *   own, larger font — and nothing else. **The heart atlas is partial.** The other
 *   seven digits of that font were never captured, so instead of borrowing shapes from the smaller
 *   陷阱 font the parser refuses any heart numeral that is not one of the observed instances; more
 *   captures extend this atlas (the header of `src/perception/chest.ts` says where).
 *
 * The two fields are drawn at different sizes, so they get two atlases: the 陷阱 numerals are 12
 * rows tall, the heart numerals 13.
 *
 * - The **陷阱 atlas** is the **mean** of every instance in this frame (not one sample): the twelve
 *   values already cover all ten digits, so averaging keeps each digit's shape while softening the
 *   JPEG's sub-pixel wobble, and the parser matches with a moderate floor.
 * - The **heart atlas** is **every observed instance, kept separately** — 9 zeros, 4 ones and 1 nine
 *   on this frame. The heart font is only 0/1/9-observed, so the guard has to be identity, not
 *   nearest-neighbour: the parser accepts a heart glyph only when it matches one of these instances
 *   near-exactly (the floor is measured against the true instances and against all ten 陷阱 glyphs as
 *   the nearest available unseen shapes) and refuses the panel otherwise. An unseen heart digit can
 *   therefore never be snapped to 0, 1 or 9.
 *
 * The bytes are the 8×10 cell scaled to 0–255; the parser re-centres and normalises them at load.
 *
 * The feature, copied from `src/perception/chest.ts` and mirrored feature-for-feature (there is no
 * way to import a `.ts` module from this script, so the two are kept in step by `--verify`):
 *   1. locate the glyph columns in the field's measured band (ink = luma ≥ band median + 55 for the
 *      陷阱 numerals; the heart numerals are yellow, so `g − b ≥ 45` and luma ≥ 140, which is what
 *      separates them from the grey heart glyph beside them);
 *   2. group columns into glyph runs, dropping slivers and splitting a run wider than 12 px at the
 *      measured 9.4 px digit pitch;
 *   3. crop each glyph to its ink rows, scale its ink by its own peak, place it in a 10×14 cell and
 *      bilinear-resize to 8×10;
 *   4. mean-centre and divide by the norm before NCC (done by the parser at load time).
 */
import { readFile } from 'node:fs/promises';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

const CARD_COLUMNS = [[704, 868], [879, 1046], [1057, 1220]];
const CARD_ROW_TOPS = [729, 853];
const FIELD_BANDS = {
  // y offsets from the card's top border, exclusive end.
  trapDetect: [64, 80],
  trapDisarm: [85, 101],
  heart: [1, 17],
};
const TRAP_NUMBER_LEFT = 74; // from the card's left border: the 陷阱发现/解除 label ends before this
const NUMBER_RIGHT_INSET = 3; // the card's own border is at x1; keep 3 px clear of it
const HEART_LEFT = 70; // the heart glyph and its numeral both live in the card's right 70 px

const INK_LUMA_DELTA = 55;
const HEART_GREEN_MINUS_BLUE = 45;
const HEART_LUMA_MIN = 140;
const MIN_GLYPH_COLUMNS = 4;
const MAX_GLYPH_COLUMNS = 12;
const DIGIT_PITCH = 9.4;

const GLYPH_CELL_WIDTH = 10;
const GLYPH_CELL_HEIGHT = 14;
const GLYPH_FEATURE_WIDTH = 8;
const GLYPH_FEATURE_HEIGHT = 10;


const FIXTURES = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const SOURCE = new URL('../src/perception/chest.ts', import.meta.url);

const args = process.argv.slice(2);
const frameIndex = args.indexOf('--frame');
const frameName = frameIndex >= 0 ? args[frameIndex + 1] : 'panel-00.jpg';
const verify = args.includes('--verify');

// ---- decoder -------------------------------------------------------------------------------

async function decodeJpeg(name) {
  const { default: jpeg } = await import('jpeg-js');
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  if (decoded.width !== REFERENCE_WIDTH || decoded.height !== REFERENCE_HEIGHT) {
    throw new Error(`${name}: ${decoded.width}×${decoded.height}, expected 1920×1080`);
  }
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

const rgb = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
};
const luma = (image, x, y) => {
  const [r, g, b] = rgb(image, x, y);
  return (77 * r + 150 * g + 29 * b) >> 8;
};
const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
};

// ---- the field bands -----------------------------------------------------------------------

function cardGeometry(card) {
  const [x0, x1] = CARD_COLUMNS[card % 3];
  const top = CARD_ROW_TOPS[Math.floor(card / 3)];
  return { x0, x1, top };
}

function bandOf(card, field) {
  const { x0, x1, top } = cardGeometry(card);
  const [dy0, dy1] = FIELD_BANDS[field];
  return { x0, x1, y0: top + dy0, y1: top + dy1 };
}

const isTrapInk = (image, x, y, background) => luma(image, x, y) - background >= INK_LUMA_DELTA;

const isHeartInk = (image, x, y) => {
  const [, g, b] = rgb(image, x, y);
  return g - b >= HEART_GREEN_MINUS_BLUE && luma(image, x, y) >= HEART_LUMA_MIN;
};

function columnRuns(image, x0, x1, y0, y1, predicate) {
  const width = x1 - x0;
  const ink = new Uint16Array(width);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) if (predicate(image, x, y)) ink[x - x0] += 1;
  }
  const runs = [];
  let start = -1;
  for (let column = 0; column <= width; column += 1) {
    const lit = column < width && ink[column] > 0;
    if (lit && start < 0) start = column;
    else if (!lit && start >= 0) {
      runs.push([x0 + start, x0 + column - 1]);
      start = -1;
    }
  }
  return runs;
}

function glyphRuns(image, x0, x1, y0, y1, predicate) {
  const atoms = [];
  for (const [from, to] of columnRuns(image, x0, x1, y0, y1, predicate)) {
    const width = to - from + 1;
    if (width < MIN_GLYPH_COLUMNS) continue;
    if (width <= MAX_GLYPH_COLUMNS) {
      atoms.push([from, to]);
      continue;
    }
    // Two digits whose JPEG halo closed the gap: split at the measured pitch.
    const count = Math.max(2, Math.round(width / DIGIT_PITCH));
    for (let k = 0; k < count; k += 1) {
      atoms.push([from + Math.round(k * width / count), from + Math.round((k + 1) * width / count) - 1]);
    }
  }
  return atoms;
}

/** One glyph's 8×10 feature cell, intensity 0–1, before mean-centring (the parser's step 4). */
function glyphCell(image, from, to, y0, y1, background, predicate) {
  let top = -1;
  let bottom = -1;
  for (let y = y0; y < y1; y += 1) {
    let any = false;
    for (let x = from; x <= to; x += 1) if (predicate(image, x, y)) { any = true; break; }
    if (any) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;

  const glyphWidth = to - from + 1;
  const glyphHeight = bottom - top + 1;
  const cell = new Float64Array(GLYPH_CELL_WIDTH * GLYPH_CELL_HEIGHT);
  let peak = 1;
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) peak = Math.max(peak, luma(image, from + x, top + y) - background);
  }
  const offsetX = Math.floor((GLYPH_CELL_WIDTH - glyphWidth) / 2);
  const offsetY = Math.floor((GLYPH_CELL_HEIGHT - glyphHeight) / 2);
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const cellX = offsetX + x;
      const cellY = offsetY + y;
      if (cellX < 0 || cellX >= GLYPH_CELL_WIDTH || cellY < 0 || cellY >= GLYPH_CELL_HEIGHT) continue;
      const value = Math.max(0, luma(image, from + x, top + y) - background) / peak;
      cell[cellY * GLYPH_CELL_WIDTH + cellX] = value;
    }
  }

  const feature = new Float64Array(GLYPH_FEATURE_WIDTH * GLYPH_FEATURE_HEIGHT);
  for (let ty = 0; ty < GLYPH_FEATURE_HEIGHT; ty += 1) {
    const sy = ((ty + 0.5) * GLYPH_CELL_HEIGHT) / GLYPH_FEATURE_HEIGHT - 0.5;
    const y0f = Math.floor(sy);
    const fy = sy - y0f;
    const ya = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0f));
    const yb = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0f + 1));
    for (let tx = 0; tx < GLYPH_FEATURE_WIDTH; tx += 1) {
      const sx = ((tx + 0.5) * GLYPH_CELL_WIDTH) / GLYPH_FEATURE_WIDTH - 0.5;
      const x0f = Math.floor(sx);
      const fx = sx - x0f;
      const xa = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0f));
      const xb = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0f + 1));
      const topValue = cell[ya * GLYPH_CELL_WIDTH + xa] * (1 - fx) + cell[ya * GLYPH_CELL_WIDTH + xb] * fx;
      const bottomValue = cell[yb * GLYPH_CELL_WIDTH + xa] * (1 - fx) + cell[yb * GLYPH_CELL_WIDTH + xb] * fx;
      feature[ty * GLYPH_FEATURE_WIDTH + tx] = topValue * (1 - fy) + bottomValue * fy;
    }
  }
  return feature;
}

/** Read one card's 陷阱 number in the field's band, and report the glyph features it found. */
function readTrapDigits(image, card, field) {
  const { x0, x1, y0, y1 } = bandOf(card, field);
  const left = x0 + TRAP_NUMBER_LEFT;
  const right = x1 - NUMBER_RIGHT_INSET;
  const values = [];
  for (let y = y0; y < y1; y += 1) for (let x = left; x < right; x += 1) values.push(luma(image, x, y));
  const background = median(values);
  const predicate = (img, x, y) => isTrapInk(img, x, y, background);
  const features = [];
  for (const [from, to] of glyphRuns(image, left, right, y0, y1, predicate)) {
    const cell = glyphCell(image, from, to, y0, y1, background, predicate);
    if (!cell) continue;
    features.push(cell);
  }
  return features;
}

/** Read one card's 心 numeral: the yellow glyphs only, located first so the grey heart stays out. */
function readHeartDigits(image, card) {
  const { x0, x1, y0, y1 } = bandOf(card, 'heart');
  const left = x1 - HEART_LEFT;
  const right = x1 - NUMBER_RIGHT_INSET;
  const yellow = columnRuns(image, left, right, y0, y1, isHeartInk);
  if (yellow.length === 0) return []; // this card draws no heart at all
  const numberLeft = yellow[0][0];
  const numberRight = yellow[yellow.length - 1][1] + 1;
  const values = [];
  for (let y = y0; y < y1; y += 1) for (let x = numberLeft; x < numberRight; x += 1) values.push(luma(image, x, y));
  const background = median(values);
  const features = [];
  for (const [from, to] of glyphRuns(image, numberLeft, numberRight, y0, y1, isHeartInk)) {
    const cell = glyphCell(image, from, to, y0, y1, background, isHeartInk);
    if (!cell) continue;
    features.push(cell);
  }
  return features;
}

// ---- the atlas -----------------------------------------------------------------------------

function meanCells(cells) {
  const mean = new Float64Array(cells[0].length);
  for (const cell of cells) for (let i = 0; i < mean.length; i += 1) mean[i] += cell[i];
  for (let i = 0; i < mean.length; i += 1) mean[i] /= cells.length;
  return mean;
}

function toBytes(mean) {
  return Uint8Array.from(mean, (value) => Math.trunc(Math.min(255, Math.max(0, value * 255))));
}

const image = await decodeJpeg(frameName);
const measurements = JSON.parse(await readFile(new URL('measurements.json', FIXTURES), 'utf8'));

/** Every instance of every digit, per atlas. */
const trapSamples = new Map();
const heartSamples = new Map();

for (let card = 0; card < measurements.members.length; card += 1) {
  const member = measurements.members[card];
  const fields = [['trapDetect', String(member.detect)], ['trapDisarm', String(member.disarm)]];
  for (const [field, expected] of fields) {
    const cells = readTrapDigits(image, card, field);
    if (cells.length !== expected.length) {
      throw new Error(`card ${card + 1} ${field}: read ${cells.length} glyphs, measurements say "${expected}"`);
    }
    for (let i = 0; i < cells.length; i += 1) {
      const digit = expected[i];
      if (!trapSamples.has(digit)) trapSamples.set(digit, []);
      trapSamples.get(digit).push(cells[i]);
    }
  }
}

const heartValues = measurements.members.map((member) =>
  member.willpower === null ? null : String(member.willpower));
for (let card = 0; card < heartValues.length; card += 1) {
  const expected = heartValues[card];
  const cells = readHeartDigits(image, card);
  if (expected === null) {
    if (cells.length !== 0) throw new Error(`card ${card + 1}: expected no heart, read ${cells.length} glyphs`);
    continue;
  }
  if (cells.length !== expected.length) {
    throw new Error(`card ${card + 1} heart: read ${cells.length} glyphs, expected "${expected}"`);
  }
  for (let i = 0; i < cells.length; i += 1) {
    const digit = expected[i];
    if (!heartSamples.has(digit)) heartSamples.set(digit, []);
    heartSamples.get(digit).push(cells[i]);
  }
}

if (trapSamples.size !== 10) {
  throw new Error(`the twelve 陷阱 values should contain all ten digits; found ${[...trapSamples.keys()].sort().join('')}`);
}

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
const constants = new Map();
for (const digit of [...trapSamples.keys()].sort()) {
  constants.set(`trap_${digit}`, base64(toBytes(meanCells(trapSamples.get(digit)))));
}
for (const digit of [...heartSamples.keys()].sort()) {
  heartSamples.get(digit).forEach((cell, index) => {
    constants.set(`heart_${digit}_${index + 1}`, base64(toBytes(cell)));
  });
}
for (const [name, value] of constants) process.stdout.write(`${name} ${value}\n`);
process.stderr.write(
  `\ntrap digits: ${[...trapSamples.keys()].sort().join('')} (${[...trapSamples.keys()].length} templates, means)\n`
  + `heart digits: ${[...heartSamples.keys()].sort().join('')} (${[...heartSamples.keys()].length} digits, `
  + `${constants.size - 10} instances)\n`
  + `samples per trap digit: ${[...trapSamples].map(([digit, list]) => `${digit}×${list.length}`).join(' ')}\n`
  + `samples per heart digit: ${[...heartSamples].map(([digit, list]) => `${digit}×${list.length}`).join(' ')}\n`,
);

if (verify) {
  const source = await readFile(SOURCE, 'utf8');
  const missing = [...constants].filter(([, value]) => !source.includes(value));
  if (missing.length > 0) {
    process.stderr.write(`\nMISMATCH: ${missing.map(([name]) => name).join(', ')} is not in src/perception/chest.ts\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nverified: every atlas constant matches src/perception/chest.ts\n');
  }
}
