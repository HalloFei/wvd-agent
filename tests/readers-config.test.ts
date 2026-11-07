/**
 * The readers seam's config row (Task 4, spec 2026-11-07 "Config"; ruling R8).
 *
 * `worlds.wvd.readers.numerals` is the seam's **default strategy**, and the composition root builds
 * the reader from it — the app has one config, so the readers package must never hard-code which
 * order a field is read in. R8 is the measured exception the row cannot reach: the opener's own
 * 陷阱 fields stay `template` — the strategy R4 fixed on the atlas — and the configuration is
 * wired to the reader a template-refused field **escalates to**, never to the opener's own chain
 * (the rule tier names this font's 4 as a 3; board card `t-mw65nlh4-lfoik7`).
 *
 * The factory is exported from `main.ts` and takes the config object as an argument, so this file
 * reads the strategy without a mounted World, a session, or module state.
 */
import { describe, expect, it } from 'vitest';
import { WVD_CONFIG_GROUP, WVD_DEFAULTS } from '../src/config.ts';
import type { RgbaImage } from '../src/contracts.ts';
import { createNumeralsReaderFromConfig } from '../src/main.ts';
import type { NumeralsReader, Tier } from '../src/perception/readers/index.ts';

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

  it('defaults from the config section the World actually receives (auto: rule refuses, OCR answers)', async () => {
    const calls: Tier[] = [];
    const reader = createNumeralsReaderFromConfig(WVD_DEFAULTS, { ocr: answering('ocr', calls) });

    const read = await reader.read(FLAT, REGION);

    expect(read).toMatchObject({ value: 77, tier: 'ocr' });
    expect(calls).toEqual(['ocr']);
  });
});
