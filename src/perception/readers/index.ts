/**
 * The readers package's one seam: the factory the opener (Task 3) and the config row (Task 4) build a
 * numerals reader from.
 *
 * It takes the **strategy** and the **template atlases** as inputs. It does not read
 * `src/config.ts` — no `readers` config row exists yet; Task 4 passes the row's value in — and it
 * does not import the opener: the atlases are private to their owner and are handed in as
 * `DigitTemplate`s (plan ruling R1).
 *
 * With no templates the template tier is simply absent: `auto` is `rule` → `ocr`, and `template`
 * is OCR alone. An atlas is one field's data, so a caller that has none is not an error, just a
 * shorter chain. The opener's fields ask for `template` (R4): the rule tier misnames their font.
 */
export * from './contract.ts';
export * from './ocr.ts';
export * from './rule.ts';
export * from './template.ts';
export * from './auto.ts';

import { createAutoReader, type NumeralsStrategy } from './auto.ts';
import type { NumeralsReader } from './contract.ts';
import { createTemplateReader, type DigitTemplate } from './template.ts';

export interface NumeralsReaderOptions {
  /** `auto` (default), `fast`, `template` or `ocr` — the spec's config value, passed in. */
  readonly strategy?: NumeralsStrategy;
  /** The field's atlas. Absent or empty means there is no template tier. */
  readonly templates?: ReadonlyArray<DigitTemplate>;
  /** The atlas tier's floors; see `createTemplateReader`. */
  readonly matchFloor?: number;
  readonly marginFloor?: number;
  /** The OCR tier to use; default `ocrReader`. Injected so a test needs no OCR runtime. */
  readonly ocr?: NumeralsReader;
}

/** Build a numerals reader over the given strategy, atlas and OCR tier. */
export function createNumeralsReader(options: NumeralsReaderOptions = {}): NumeralsReader {
  const templates = options.templates;
  const template = templates !== undefined && templates.length > 0
    ? createTemplateReader({ templates, matchFloor: options.matchFloor, marginFloor: options.marginFloor })
    : undefined;
  return createAutoReader({ strategy: options.strategy ?? 'auto', template, ocr: options.ocr });
}
