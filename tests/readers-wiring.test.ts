/**
 * The composition root's reader wiring (readers plan 2026-11-07, rulings R9 and R12).
 *
 * `ChestPerceiver` — the composite's first perceiver — is built in `main.ts` with **the package's OCR
 * tier** as the reader a template-refused 陷阱 field escalates to (R9), and with the tier log Task 4
 * added. The R8 experiment (a config-built chain whose `auto` default starts with the rule tier, in
 * front of OCR) is gone: review F2 / ruling R12 removed `worlds.wvd.readers.numerals` and its factory
 * from this branch, because nothing read the key. The seam stays switchable through
 * `createNumeralsReader`'s `strategy` argument; this file pins what the composition root hands over.
 *
 * It replaces `tests/readers-config.test.ts`, which asserted the same wiring plus the config row and
 * the factory — both removed.
 */
import { describe, expect, it, vi } from 'vitest';
import { WVD_DEFAULTS } from '../src/config.ts';
import { createWvdWorld } from '../src/main.ts';
import { ocrReader } from '../src/perception/readers/index.ts';

/** The composition root's own wiring, captured rather than run: `createWvdWorld` builds the chest perceiver. */
const openerOptions = vi.hoisted(
  () => [] as Array<{ readonly trapReader?: unknown; readonly onOpenerTiers?: unknown }>,
);

vi.mock('../src/perception/chest.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/perception/chest.ts')>();
  return {
    ...actual,
    ChestPerceiver: class {
      constructor(options: { trapReader?: unknown; onOpenerTiers?: unknown } = {}) {
        openerOptions.push(options);
      }
      observe() {
        return Promise.resolve({ screen: 'unknown' as const, atMs: 0, confidence: 0 });
      }
    },
  };
});

describe('the composition root builds the opener with the OCR tier as its escalation (R9)', () => {
  it("hands ChestPerceiver the OCR tier and the tier log, from the config's own defaults", () => {
    openerOptions.length = 0;
    createWvdWorld({ cfg: WVD_DEFAULTS, timezone: 'Asia/Shanghai' });

    expect(openerOptions).toHaveLength(1);
    expect(openerOptions[0]!.trapReader).toBe(ocrReader);
    expect(openerOptions[0]!.onOpenerTiers).toBeTypeOf('function');
  });
});
