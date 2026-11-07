/**
 * The numerals-reader selector: which tier a field is read by, and in what order.
 *
 * The spec fixes the order (2026-11-07, "The seam"): `auto` tries `rule` → `template` → `ocr`,
 * returns the first answer, and carries **the tier that answered** — the tier mix is the health
 * metric, so a run that starts falling through the fast tiers is visible before it dies.
 *
 * - `fast` is the fast loop's reading: `rule` → `template`, and **never** an OCR process.
 * - `ocr` skips the fast tiers (the spec is explicit — it is not "OCR first, then the fast tiers"):
 *   the caller is saying this field needs the escalation. A plausible fast answer cannot pre-empt it.
 *
 * The tiers are injected rather than constructed here, so the selector can be proved without an OCR
 * runtime: a test with a fake OCR that throws fails if `fast` ever calls it. The selector does not
 * catch a throwing tier: every tier's contract is `null` on refusal, and a throw is a broken tier
 * that must be seen, not papered over.
 */
import { ocrReader } from './ocr.ts';
import type { NumeralsReader } from './contract.ts';
import { ruleReader } from './rule.ts';

/** The `worlds.wvd.readers.numerals` strategies (spec 2026-11-07, Config). */
export type NumeralsStrategy = 'auto' | 'fast' | 'ocr';

/**
 * The tiers a selector is built from. Every one is optional: the defaults are the real tiers, and an
 * injected tier is what lets a test prove the order (e.g. an OCR that throws when it is called).
 */
export interface AutoReaderOptions {
  /** Which order to read in. Default `auto`. */
  readonly strategy?: NumeralsStrategy;
  /** The shape-rules tier. Default `ruleReader`. */
  readonly rule?: NumeralsReader;
  /** The atlas tier; absent means there is no template tier (no atlas was handed in). */
  readonly template?: NumeralsReader;
  /** The escalation. Default `ocrReader` (which reads its runtime from the environment per call). */
  readonly ocr?: NumeralsReader;
}

/** The selector over the given tiers. Never throws: a refusal from every tier in the chain is `null`. */
export function createAutoReader(options: AutoReaderOptions = {}): NumeralsReader {
  const strategy = options.strategy ?? 'auto';
  const rule = options.rule ?? ruleReader;
  const ocr = options.ocr ?? ocrReader;
  const fast: NumeralsReader[] = options.template === undefined ? [rule] : [rule, options.template];
  const chain: NumeralsReader[] = strategy === 'ocr' ? [ocr] : strategy === 'fast' ? fast : [...fast, ocr];
  return {
    async read(image, region, hint) {
      for (const tier of chain) {
        const read = await tier.read(image, region, hint);
        if (read !== null) return read;
      }
      return null;
    },
  };
}
