/**
 * The numerals reader's OCR tier: the escalation for a numeral the fast tiers refused.
 *
 * Measured 2026-11-07 on the opener fixture `panel-00.jpg`: a crop of (704, 785, 164, 30) reads the
 * texts ["陷阱发现", "38"], a context-free 87 x 16 slice of the same numeral reads nothing. So the read
 * covers `region ∪ hint.label` (readers spec, `ReadHint.label`), and the digits of the answer are the
 * value. The process, its bound and its `null` on absence are the map readout's proven escalation
 * (ocr-process.ts, 2026-11-07: 16/4, 13/25, 19/2, 20/14 all correct).
 *
 * The tier never throws: an unconfigured runtime, a clip, a temp path that cannot be written, a
 * failed or timed-out process, an answer with no single numeral or a number outside the hint's
 * bounds are all `null`.
 */
import type { RgbaImage } from '../../contracts.ts';
import { ocrRunnerFromEnv, readTextsViaOcr } from '../ocr-process.ts';
import { readCoverage, withinHint, type Numerals, type NumeralsReader, type ReadHint, type Region } from './contract.ts';

/**
 * What a parsed OCR answer is worth. RapidOCR reports text, not a probability, so this is the tier's
 * own claim — not a measurement — and nothing about a misread is visible in it. A caller that needs
 * certainty keeps its own floors and its own bounds.
 */
export const OCR_CONFIDENCE = 0.9;

/** The tier as the seam sees it: `read` is the whole contract. */
export const ocrReader: NumeralsReader = { read: readNumeralsViaOcr };

/**
 * The number the OCR names in `region` (plus `hint.label`), or null: the OCR runtime is not configured,
 * the crop is not wholly inside the frame, the crop could not be written to a temp path, the process
 * failed or timed out, the answer carried no single numeral, its length contradicts `hint.digits`, or
 * the value is outside `hint.min` .. `hint.max`.
 */
export async function readNumeralsViaOcr(
  image: RgbaImage,
  region: Region,
  hint?: ReadHint,
): Promise<Numerals | null> {
  const runner = ocrRunnerFromEnv();
  if (runner === null) return null;
  const coverage = readCoverage(image, region, hint);
  if (coverage === null) return null;
  const texts = await readTextsViaOcr(image, coverage, runner);
  if (texts === null) return null;
  const value = numeralOf(texts.join(' '), hint?.digits);
  if (value === null || !withinHint(value, hint)) return null;
  return { value, confidence: OCR_CONFIDENCE, tier: 'ocr' };
}

/**
 * The single integer an OCR answer names, in reading order, or null. Two runs is an ambiguous answer,
 * not a concatenation — the same refusal `numbersOf` makes for the readout. `digits`, when the field's
 * length is known, must match the run: a wrong length is evidence of a misread, not a shorter number.
 */
export function numeralOf(text: string, digits?: 1 | 2 | 3): number | null {
  const runs = text.match(/\d+/g);
  if (runs === null || runs.length !== 1) return null;
  const run = runs[0]!;
  if (digits !== undefined && run.length !== digits) return null;
  const value = Number(run);
  return Number.isInteger(value) ? value : null;
}
