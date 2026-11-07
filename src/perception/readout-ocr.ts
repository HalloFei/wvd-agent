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
import type { Point, RgbaImage } from '../contracts.ts';
import { readTextsViaOcr, type OcrRunner } from './ocr-process.ts';

export { ppmOf } from './ocr-process.ts';

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
  const runner: OcrRunner | null = options === undefined ? null : options;
  const texts = await readTextsViaOcr(image, band, runner);
  if (texts === null) return null;
  return numbersOf(texts.join(' '));
}

/** The integers the answer carries, in reading order: exactly two, or null. */
export function numbersOf(text: string): Point | null {
  const values = text.match(/\d+/g);
  if (values === null || values.length !== 2) return null;
  const x = Number(values[0]);
  const y = Number(values[1]);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}
