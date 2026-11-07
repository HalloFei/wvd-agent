/**
 * The OCR process: one region of a frame written as a binary PPM and read by scripts/ocr-readout.py
 * (RapidOCR in the operator's venv). Shared by the escalations that need a number nothing local could
 * read: the map's coordinate readout (readout-ocr.ts) and the numerals-reader seam's OCR tier
 * (readers/ocr.ts).
 *
 * Operator 2026-11-07: a coordinate can be any number, so the reader cannot be a pile of committed
 * glyphs — *there must be a package or a model that does it*. The region is written as a PPM (no
 * encoder needed), the script crops from (0,0) of what it is handed, upscales it 4x (a 12 px numeral
 * is below what any OCR model wants) and returns the lines it read.
 *
 * The reader is a **process**, not a layer: it is spawned per read, awaited with a timeout, and its
 * absence is `null` — the caller stays refused, exactly as before.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PixelRect, RgbaImage } from '../contracts.ts';

/** How to run the reader: the interpreter, the script, and how long it may take. */
export interface OcrRunner {
  /** The Python interpreter that has the OCR package (`rapidocr-onnxruntime`). */
  readonly python: string;
  /** `scripts/ocr-readout.py`. */
  readonly script: string;
  /** The whole call's bound; a slow first run loads the models. Default 8 s. */
  readonly timeoutMs?: number;
}

/**
 * The runner the environment names — `WVD_OCR_PYTHON` and `WVD_OCR_SCRIPT` — or null when either is
 * unset: an unavailable OCR tier is not an error (readers spec 2026-11-07, Config).
 */
export function ocrRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): OcrRunner | null {
  const python = env.WVD_OCR_PYTHON;
  const script = env.WVD_OCR_SCRIPT;
  return python !== undefined && python !== '' && script !== undefined && script !== ''
    ? { python, script }
    : null;
}

/**
 * The lines of text the OCR read in `region`, in reading order, or null: no runner, the process failed
 * or timed out, or its answer was not the script's `{ ok: true, texts }`.
 */
export async function readTextsViaOcr(
  image: RgbaImage,
  region: PixelRect,
  runner: OcrRunner | null,
): Promise<string[] | null> {
  if (runner === null) return null;
  const dir = mkdtempSync(join(tmpdir(), 'wvd-ocr-'));
  const file = join(dir, 'readout.ppm');
  try {
    writeFileSync(file, ppmOf(image, region));
    return await run(runner, file, region);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that will not die is not an answer */ }
  }
}

/** The script's answer, parsed: its `texts`, or null when it did not succeed. */
function run(options: OcrRunner, file: string, region: PixelRect): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      options.python,
      // The file is the region itself: the script crops from (0,0) of what it is handed.
      [options.script, file, '0', '0', String(region.width), String(region.height)],
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
        resolve(answer.texts.map((item) => String(item)));
      } catch {
        resolve(null);
      }
    });
  });
}

/** The region as a binary PPM (P6): PIL reads it, and the screen's alpha is not part of the luma. */
export function ppmOf(image: RgbaImage, region: PixelRect): Buffer {
  const width = Math.max(1, Math.min(image.width - region.x, region.width));
  const height = Math.max(1, Math.min(image.height - region.y, region.height));
  const header = Buffer.from('P6\n' + width + ' ' + height + '\n255\n', 'ascii');
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((region.y + y) * image.width + (region.x + x)) * 4;
      const to = (y * width + x) * 3;
      body[to] = image.data[from]!;
      body[to + 1] = image.data[from + 1]!;
      body[to + 2] = image.data[from + 2]!;
    }
  }
  return Buffer.concat([header, body]);
}
