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
 * The call's bound when `WVD_OCR_TIMEOUT_MS` names no usable value: the map readout's 8 s, a bound
 * that assumes nothing about the host (the first run loads the OCR models).
 */
export const DEFAULT_OCR_TIMEOUT_MS = 8_000;

/**
 * The bound the environment names (ruling R7, 2026-11-07), in milliseconds, or the 8 s default. Read
 * at call time beside the interpreter and the script, so a host whose OCR load is slower than the
 * committed default (the full suite's parallel forks made the 8 s bound time out) can widen it
 * without editing it. A value that is empty, non-numeric, non-finite or <= 0 is not a bound: it falls
 * back rather than becoming an immediate kill.
 */
export function ocrTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WVD_OCR_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_OCR_TIMEOUT_MS;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OCR_TIMEOUT_MS;
}

/**
 * The runner the environment names — `WVD_OCR_PYTHON`, `WVD_OCR_SCRIPT` and `WVD_OCR_TIMEOUT_MS` —
 * or null when either path is unset: an unavailable OCR tier is not an error (readers spec
 * 2026-11-07, Config). The bound is carried with the runner so one call cannot read two bounds.
 */
export function ocrRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): OcrRunner | null {
  const python = env.WVD_OCR_PYTHON;
  const script = env.WVD_OCR_SCRIPT;
  return python !== undefined && python !== '' && script !== undefined && script !== ''
    ? { python, script, timeoutMs: ocrTimeoutMsFromEnv(env) }
    : null;
}

/**
 * The lines of text the OCR read in `region`, in reading order, or null: no runner, the crop could not
 * be handed over (no temp dir, no space, no permission — the filesystem is part of this call), the
 * process failed or timed out, or its answer was not the script's `{ ok: true, texts }`.
 */
export async function readTextsViaOcr(
  image: RgbaImage,
  region: PixelRect,
  runner: OcrRunner | null,
): Promise<string[] | null> {
  if (runner === null) return null;
  // The crop is handed over as a temp file, so the filesystem is part of this call: `mkdtempSync` or
  // the PPM write can fail with ENOSPC / EACCES / EPERM / ENOENT. That failure is a refusal like a
  // failed process — not a throw. `readers/ocr.ts` declares the tier never throws, and the loop must
  // not see a filesystem error escape a read (measured: a missing temp root rejected the read).
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'wvd-ocr-'));
    const file = join(dir, 'readout.ppm');
    writeFileSync(file, ppmOf(image, region));
    return await run(runner, file, region);
  } catch {
    return null;
  } finally {
    if (dir !== undefined) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* a temp dir that will not die is not an answer */ }
    }
  }
}

/**
 * How long the call waits for a killed child to close, after the bound expired. The kill's own `close`
 * is the answer; this is the fence for a child whose stdio never settles (review F7).
 */
const REAP_GRACE_MS = 1_000;

/**
 * The script's answer, parsed: its `texts`, or null when it did not succeed, failed, or timed out.
 *
 * **The child is drained and reaped** (review F7). Its stderr is discarded, not merely piped: an
 * unread stderr pipe fills at the OS buffer and the child blocks before it can print its answer, so
 * the call would time out to a plausible-looking refusal for a reader that worked (measured: 256 KiB
 * of stderr hung the call for its whole bound). And a timed-out child is killed and its `close`
 * awaited — up to `REAP_GRACE_MS` past the kill — instead of being left to the OS while its stdio
 * still holds the temp file open.
 */
function run(options: OcrRunner, file: string, region: PixelRect): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = spawn(
      options.python,
      // The file is the region itself: the script crops from (0,0) of what it is handed.
      [options.script, file, '0', '0', String(region.width), String(region.height)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      resolve(value);
    };
    // The child's stderr is its log, not its answer: discard it as it arrives (F7).
    child.stderr?.resume();
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
      // The kill ends the pipes, so 'close' follows; the fence covers a child that will not die.
      reapTimer = setTimeout(() => finish(null), REAP_GRACE_MS);
    }, options.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      // A killed child's partial output is not an answer: the bound already refused the call.
      if (timedOut) return finish(null);
      try {
        const answer = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? 'null') as { ok?: boolean; texts?: unknown } | null;
        if (answer === null || answer.ok !== true || !Array.isArray(answer.texts)) return finish(null);
        finish(answer.texts.map((item) => String(item)));
      } catch {
        finish(null);
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
