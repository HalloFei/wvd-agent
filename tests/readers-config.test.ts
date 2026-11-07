/**
 * The readers seam's config row (Task 4, spec 2026-11-07 "Config"; rulings R8 and R9).
 *
 * `worlds.wvd.readers.numerals` is the seam's **default strategy**, and the composition root builds
 * the reader from it — the app has one config, so the readers package must never hard-code which
 * order a field is read in.
 *
 * **The config never shapes the opener's escalation** (R9, 2026-11-07): the opener's own 陷阱 fields
 * stay `template` (R4), and a field that strategy refuses escalates to the package's **OCR tier**
 * directly. R8's wiring — the config-built reader as what the opener escalates to — put the rule
 * tier in front of OCR, and on the amount-2 sharpened proxy the rules name a refused field 93 where
 * OCR reads 92 (board card `t-mw65nlh4-lfoik7` for the underlying misname). The factory stays
 * exported and tested: it is the seam's default strategy for future consumers, not the opener's.
 *
 * The factory is exported from `main.ts` and takes the config object as an argument, so this file
 * reads the strategy without a mounted World, a session, or module state.
 */
import { describe, expect, it, vi } from 'vitest';
import { WVD_CONFIG_GROUP, WVD_DEFAULTS } from '../src/config.ts';
import type { RgbaImage } from '../src/contracts.ts';
import { createNumeralsReaderFromConfig, createWvdWorld } from '../src/main.ts';
import { ocrReader, type NumeralsReader, type Tier } from '../src/perception/readers/index.ts';

/**
 * The composition root's own wiring, captured rather than run (R9): `createWvdWorld` builds the chest
 * perceiver, so replacing that one class is how this file sees which reader it is handed. Everything
 * else in the module stays real — `actions/qte.ts` reads the bar parsers from it.
 */
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

/** A flat 8 x 8 frame: the rule tier refuses it (no contrast), so only an escalation can answer. */
const FLAT: RgbaImage = { data: new Uint8Array(8 * 8 * 4), width: 8, height: 8 };
const REGION = { x: 0, y: 0, width: 8, height: 8 } as const;

/** A tier that answers 77 (and records that it was asked), for proving which chain a strategy is. */
function answering(tier: Tier, calls: Tier[]): NumeralsReader {
  return {
    read: async () => {
      calls.push(tier);
      return { value: 77, confidence: 0.9, tier };
    },
  };
}

describe('worlds.wvd.readers.numerals', () => {
  it('is one config row with its four strategies, defaulting to auto', () => {
    const row = WVD_CONFIG_GROUP.schema.properties['worlds.wvd.readers.numerals'];

    expect(row).toBeDefined();
    expect(row).toMatchObject({ type: 'string', enum: ['auto', 'fast', 'template', 'ocr'] });
    expect(row!.description?.length).toBeGreaterThan(0);
    // The default is the config's, not a module's: the section the World receives carries it.
    expect(WVD_DEFAULTS.readers).toEqual({ numerals: 'auto' });
  });

  it("builds the seam's reader from the config value — 'ocr' sends every field to the OCR tier", async () => {
    const calls: Tier[] = [];
    const reader = createNumeralsReaderFromConfig({ readers: { numerals: 'ocr' } }, { ocr: answering('ocr', calls) });

    const read = await reader.read(FLAT, REGION);

    expect(read).toMatchObject({ value: 77, tier: 'ocr' });
    expect(calls).toEqual(['ocr']);
  });

  it("'fast' is the config's no-OCR chain: the escalation is never asked", async () => {
    const never: NumeralsReader = {
      read: async () => {
        throw new Error('the fast strategy must not call the OCR tier');
      },
    };
    const reader = createNumeralsReaderFromConfig({ readers: { numerals: 'fast' } }, { ocr: never });

    // The flat frame is refused by the rule tier and there is no atlas, so the answer is null.
    expect(await reader.read(FLAT, REGION)).toBeNull();
  });

  it("hands the opener's escalation the OCR tier, whichever strategy the config names (R9)", () => {
    // The composition root builds the chest perceiver with a reader for the template-refused 陷阱
    // fields. R9: that reader is the package's OCR tier itself — not the config-built chain, whose
    // default 'auto' puts the rule tier in front of OCR — and no config value changes it.
    for (const numerals of ['auto', 'fast', 'template', 'ocr'] as const) {
      openerOptions.length = 0;
      createWvdWorld({ cfg: { ...WVD_DEFAULTS, readers: { numerals } }, timezone: 'Asia/Shanghai' });

      expect(openerOptions).toHaveLength(1);
      expect(openerOptions[0]!.trapReader).toBe(ocrReader);
      expect(openerOptions[0]!.onOpenerTiers).toBeTypeOf('function');
    }
  });

  it("keeps the config factory: the config still builds the seam's default reader (R8)", () => {
    // R8 stands, the factory is the seam's default strategy for future consumers; R9 only stops the
    // composition root from passing it to the opener.
    expect(createNumeralsReaderFromConfig({ readers: { numerals: 'fast' } })).not.toBe(ocrReader);
  });

  it('defaults from the config section the World actually receives (auto: rule refuses, OCR answers)', async () => {
    const calls: Tier[] = [];
    const reader = createNumeralsReaderFromConfig(WVD_DEFAULTS, { ocr: answering('ocr', calls) });

    const read = await reader.read(FLAT, REGION);

    expect(read).toMatchObject({ value: 77, tier: 'ocr' });
    expect(calls).toEqual(['ocr']);
  });
});
