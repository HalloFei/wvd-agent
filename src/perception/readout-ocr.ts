/**
 * The readout's numbers, read by an OCR package, for a frame the World's own digit reader refused.
 *
 * Operator 2026-11-07: a coordinate can be any number, so the reader cannot be a pile of committed
 * glyphs — *there must be a package or a model that does it*. This is that escalation, local and
 * pinned to the readout's own band: the band is written as a PPM (no encoder needed), RapidOCR reads
 * the line, and the two integers it returns are the numbers. It runs only when the map's own readout
 * parse has already failed and the caller configured it — never in the loop's fast path.
 *
 * The reader is a **process**, not a layer: it is spawned, awaited with a timeout, and its absence is
 * `null` (the map stays refused, exactly as before).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Point, RgbaImage } from '../contracts.ts';

/** How to run the reader: the interpreter, the script, and how long it may take. */
export interface OcrReadout {
  /** The Python interpreter that has the OCR package (`rapidocr-onnxruntime`). */
  readonly python: string;
  /** `scripts/ocr-readout.py`. */
  readonly script: string;
  /** The whole call's bound; a slow first run loads the models. Default 8 s. */
  readonly timeoutMs?: number;
}

/** One readout band, in the frame's own pixels. */
export interface ReadoutBand {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The two numbers of `X: <n>  Y: <n>`, or null: no OCR configured, the process failed or timed out,
 * or the line did not carry exactly two integers. The order is the reading order — the OCR's own box
 * grouping puts the labels around the values, so the values are the integers.
 */
export async function readNumbersViaOcr(
  image: RgbaImage,
  band: ReadoutBand,
  options: OcrReadout | undefined,
): Promise<Point | null> {
  if (options === undefined) return null;
  const dir = mkdtempSync(join(tmpdir(), 'wvd-ocr-'));
  const file = join(dir, 'readout.ppm');
  try {
    writeFileSync(file, ppmOf(image, band));
    const text = await run(options, file, band);
    if (text === null) return null;
    return numbersOf(text);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that will not die is not an answer */ }
  }
}

/** The script's answer, parsed: its `texts` joined, or null when it did not succeed. */
function run(options: OcrReadout, file: string, band: ReadoutBand): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      options.python,
      // The file is the band itself: the script crops from (0,0) of what it is handed.
      [options.script, file, '0', '0', String(band.width), String(band.height)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(null); }, options.timeoutMs ?? 8_000);
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const answer = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? 'null') as { ok?: boolean; texts?: unknown } | null;
        if (answer === null || answer.ok !== true || !Array.isArray(answer.texts)) return resolve(null);
        resolve(answer.texts.map((item) => String(item)).join(' '));
      } catch {
        resolve(null);
      }
    });
  });
}

/** The integers the answer carries, in reading order: exactly two, or null. */
export function numbersOf(text: string): Point | null {
  const values = text.match(/\d+/g);
  if (values === null || values.length !== 2) return null;
  const x = Number(values[0]);
  const y = Number(values[1]);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

/** The band as a binary PPM (P6): PIL reads it, and the screen's alpha is not part of the luma. */
export function ppmOf(image: RgbaImage, band: ReadoutBand): Buffer {
  const width = Math.max(1, Math.min(image.width - band.x, band.width));
  const height = Math.max(1, Math.min(image.height - band.y, band.height));
  const header = Buffer.from('P6\n' + width + ' ' + height + '\n255\n', 'ascii');
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((band.y + y) * image.width + (band.x + x)) * 4;
      const to = (y * width + x) * 3;
      body[to] = image.data[from]!;
      body[to + 1] = image.data[from + 1]!;
      body[to + 2] = image.data[from + 2]!;
    }
  }
  return Buffer.concat([header, body]);
}
