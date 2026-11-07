/**
 * The numerals-reader selector: which tier a field is read by, and in what order.
 *
 * The spec fixes the order (2026-11-07, "The seam"): `auto` tries `rule` → `template` → `ocr`,
 * returns the first answer, and carries **the tier that answered** — the tier mix is the health
 * metric, so a run that starts falling through the fast tiers is visible before it dies.
 *
 * - `fast` is the fast loop's reading: `rule` → `template`, and **never** an OCR process.
 * - `template` is the opener's fields (ruling R4, 2026-11-07): `template` → `ocr`, with the rule
 *   tier **not in the chain**. The ruling is a measurement, not a preference: the opener's fixed-font
 *   numerals are read correctly by the atlas tier (0.967 / 0.937 on panel-00) but the rule tier names
 *   their `4` as a `3` (panel-00's disarm row would read `39` where it is `49`), so a rule-first
 *   chain cannot be trusted on that font. A field whose atlas is absent is read by OCR alone: an
 *   atlas is one field's data, so a caller with none is not an error, just a one-tier chain.
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

/** The `worlds.wvd.readers.numerals` strategies (spec 2026-11-07, Config; `template` is R4). */
export type NumeralsStrategy = 'auto' | 'fast' | 'template' | 'ocr';

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
  const template = options.template;
  const fast: NumeralsReader[] = template === undefined ? [rule] : [rule, template];
  // No atlas means the tier is absent, not an error: `template` then reads OCR alone (see the header).
  const templateFirst: NumeralsReader[] = template === undefined ? [ocr] : [template, ocr];
  const chain: NumeralsReader[] = strategy === 'ocr'
    ? [ocr]
    : strategy === 'fast'
      ? fast
      : strategy === 'template'
        ? templateFirst
        : [...fast, ocr];
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
