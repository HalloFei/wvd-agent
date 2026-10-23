#!/usr/bin/env node
/**
 * Provenance for the glyph templates embedded in `src/perception/map.ts` (ruling R27b).
 *
 * This script is documentation, not part of `pnpm test` / CI: it needs `ffmpeg` on PATH and the
 * research corpus (the `%TEMP%\wvdmap\frames` PNGs extracted from the git-ignored nav captures) for
 * the digits 3 and 7, which no committed fixture contains. It decodes a PNG through ffmpeg's
 * rawvideo pipe (Node has no PNG decoder and adding one is forbidden), applies the exact feature
 * the parser applies, and prints the base64 constants. With `--verify` it checks that every
 * constant it produces is the one in the source.
 *
 * Usage:
 *   node scripts/extract-map-templates.mjs [--frames <dir>] [--verify]
 *
 * The digit feature, copied from research-map-parser.md §3 and mirrored in `src/perception/map.ts`:
 *   1. segment the readout band (x 1010–1145, y 898–913, luma > 85) into column runs;
 *   2. crop the 16-row band to the run, clamp `(L−70)/170` to [0,1], scale to 0–255;
 *   3. bilinear-resize to 8×12 and truncate to bytes;
 *   4. subtract the mean and divide by the norm before NCC (done by the parser at load time).
 *
 * The corpus contains only four readouts — 20/14, 19/21, 22/17, 23/13 — hence templates for
 * 0, 1, 2, 3, 4, 7 and 9 and none for 5, 6, 8. One sample per glyph; the title slots and the stairs
 * cell are likewise single samples. That is why they are named constants with a comment rather
 * than "facts" in the parser.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

const READOUT = { x: 1010, y: 898, w: 136, h: 16, luma: 85 };
const FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

// ---- decoder -------------------------------------------------------------------------------

function decodePng(path) {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const expected = REFERENCE_WIDTH * REFERENCE_HEIGHT * 3;
  if (raw.length !== expected) {
    throw new Error(`${path}: ffmpeg returned ${raw.length} bytes, expected ${expected}`);
  }
  return { data: raw, width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT };
}

function luma(data, width, x, y) {
  const offset = (y * width + x) * 3;
  return ((data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000) | 0;
}

// ---- digit feature -------------------------------------------------------------------------

function columnRuns(columnInk) {
  const runs = [];
  let start = -1;
  for (let x = 0; x < columnInk.length; x += 1) {
    if (columnInk[x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= 2) runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0 && columnInk.length - start >= 2) runs.push([start, columnInk.length - 1]);
  return runs;
}

function readoutRuns(image) {
  const { data, width } = image;
  const columnInk = new Uint8Array(READOUT.w);
  for (let y = READOUT.y; y < READOUT.y + READOUT.h; y += 1) {
    for (let x = 0; x < READOUT.w; x += 1) {
      if (luma(data, width, READOUT.x + x, y) > READOUT.luma) columnInk[x] = 1;
    }
  }
  return columnRuns(columnInk);
}

function resizeBilinear(source, sourceW, sourceH, targetW, targetH) {
  const values = new Float64Array(targetW * targetH);
  for (let ty = 0; ty < targetH; ty += 1) {
    const sy = ((ty + 0.5) * sourceH) / targetH - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const ya = Math.min(sourceH - 1, Math.max(0, y0));
    const yb = Math.min(sourceH - 1, Math.max(0, y0 + 1));
    for (let tx = 0; tx < targetW; tx += 1) {
      const sx = ((tx + 0.5) * sourceW) / targetW - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const xa = Math.min(sourceW - 1, Math.max(0, x0));
      const xb = Math.min(sourceW - 1, Math.max(0, x0 + 1));
      const top = source[ya * sourceW + xa] * (1 - fx) + source[ya * sourceW + xb] * fx;
      const bottom = source[yb * sourceW + xa] * (1 - fx) + source[yb * sourceW + xb] * fx;
      values[ty * targetW + tx] = top * (1 - fy) + bottom * fy;
    }
  }
  return values;
}

function glyphBytes(image, x0, x1) {
  const { data, width } = image;
  const sourceW = x1 - x0 + 1;
  const source = new Float64Array(READOUT.h * sourceW);
  for (let y = 0; y < READOUT.h; y += 1) {
    for (let x = 0; x < sourceW; x += 1) {
      const scaled = ((luma(data, width, x0 + x, READOUT.y + y) - 70) / 170) * 255;
      source[y * sourceW + x] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
    }
  }
  const values = resizeBilinear(source, sourceW, READOUT.h, 8, 12);
  return Uint8Array.from(values, (value) => Math.trunc(value));
}

// ---- fixtures ------------------------------------------------------------------------------

const KNOWN_READOUTS = [
  { name: 'map.png', x: '20', y: '14', fixture: true },
  { name: 'popup.png', x: '19', y: '21', fixture: true },
  { name: '007_017.png', x: '23', y: '13', fixture: false },
  { name: '000_001.png', x: '22', y: '17', fixture: false },
];

const args = process.argv.slice(2);
const framesIndex = args.indexOf('--frames');
const framesDir = framesIndex >= 0 ? args[framesIndex + 1] : process.env.WVD_MAP_FRAMES ?? null;
const verify = args.includes('--verify');

function sourcePath(entry) {
  if (entry.fixture) return fileURLToPath(new URL(entry.name, FIXTURES));
  if (!framesDir) return null;
  return `${framesDir.replace(/[\\/]$/, '')}/${entry.name}`;
}

const digits = new Map();
for (const entry of KNOWN_READOUTS) {
  const path = sourcePath(entry);
  if (!path) {
    process.stderr.write(`skipping ${entry.name}: pass --frames <dir> for the research corpus\n`);
    continue;
  }
  let image;
  try {
    image = decodePng(path);
  } catch (error) {
    process.stderr.write(`skipping ${entry.name}: ${error.message}\n`);
    continue;
  }
  const runs = readoutRuns(image);
  if (runs.length !== 8) {
    throw new Error(`${entry.name}: ${runs.length} readout runs, expected 8`);
  }
  const values = `${entry.x}${entry.y}`;
  [2, 3, 6, 7].forEach((run, index) => {
    const digit = values[index];
    const [from, to] = runs[run];
    if (!digits.has(digit)) digits.set(digit, glyphBytes(image, READOUT.x + from, READOUT.x + to));
  });
}

const mapImage = decodePng(fileURLToPath(new URL('map.png', FIXTURES)));
const at = (x0, y0, w, h) => {
  const bytes = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      bytes[y * w + x] = luma(mapImage.data, mapImage.width, x0 + x, y0 + y);
    }
  }
  return bytes;
};

const templates = new Map();
for (const digit of [...digits.keys()].sort()) {
  templates.set(`digit_${digit}`, digits.get(digit));
}
// Chest: 22×23 at the observed chest's cell centre.
templates.set('chest', at(1308, 594, 22, 23));
// Stairs: 36×36 cell at the one observed staircase (single sample).
templates.set('stairs', at(1374, 156, 36, 36));
// Title slots: B 878–902, 1 903–915, F 918–941, rows 44–75 (one sample; R27).
templates.set('title_B', at(878, 44, 25, 32));
templates.set('title_1', at(903, 44, 13, 32));
templates.set('title_F', at(918, 44, 24, 32));

const base64 = (bytes) => Buffer.from(bytes).toString('base64');
for (const [name, bytes] of templates) {
  process.stdout.write(`${name} ${base64(bytes)}\n`);
}

if (verify) {
  const source = await readFile(new URL('../src/perception/map.ts', import.meta.url), 'utf8');
  const missing = [...templates].filter(([, bytes]) => !source.includes(base64(bytes)));
  if (missing.length > 0) {
    process.stderr.write(`\nMISMATCH: ${missing.map(([name]) => name).join(', ')}\n`);
    process.exitCode = 1;
  } else if (digits.size !== 7) {
    process.stderr.write(
      `\nINCOMPLETE: ${digits.size}/7 digit templates (need --frames for 3 and 7)\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('\nverified: all templates match src/perception/map.ts\n');
  }
}
