import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { decodePng } from '../src/perception/ledger.ts';
import { LoadingPerceiver, isBlank } from '../src/perception/loading.ts';
import { createScreenReaders } from '../src/perception/reader-set.ts';

/**
 * The two live frames of 2026-11-08 20:44, filed losslessly by the ledger: the black one is the frame
 * the heal waited on for its whole deadline, the dim one is a menu over a dark room that answered
 * `unknown` because nothing names it — and must NOT be called a load.
 */
const BLANK = new URL('../testdata/screens/2026-11-08-blank-after-battle/blank-after-battle.png', import.meta.url);
const DIM = new URL('../testdata/screens/2026-11-08-blank-after-battle/dim-menu.png', import.meta.url);
const TOWN = new URL('../testdata/frames/town-0.jpg', import.meta.url);

async function pngFrame(url: URL): Promise<{ frame: Frame; image: RgbaImage }> {
  const image = decodePng(await readFile(url));
  return {
    frame: { atMs: 1, width: image.width, height: image.height, toRgba: async () => image },
    image,
  };
}

async function jpegFrame(url: URL): Promise<{ frame: Frame; image: RgbaImage }> {
  const decoded = jpeg.decode(await readFile(url), { useTArray: true, formatAsRGBA: true });
  const image: RgbaImage = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  return { frame: { atMs: 1, width: image.width, height: image.height, toRgba: async () => image }, image };
}

describe('the blank frame', () => {
  it('is the game s load, and a dark screen with a menu on it is not', async () => {
    const loading = new LoadingPerceiver();

    const blank = await pngFrame(BLANK);
    expect(isBlank(blank.image)).toBe(true);
    const named = await loading.observe(blank.frame);
    expect(named.screen).toBe('loading');
    expect(named.confidence).toBe(1);

    // 26 % of this frame's pixels are lit (the menu); the anchor is 2 %. A load is empty, not dark.
    const dim = await pngFrame(DIM);
    expect(isBlank(dim.image)).toBe(false);
    expect((await loading.observe(dim.frame)).screen).toBe('unknown');

    const town = await jpegFrame(TOWN);
    expect((await loading.observe(town.frame)).screen).toBe('unknown');
  });

  it('is the chain s first answer on the blank frame, at confidence 1', async () => {
    // The reader chain is the only thing that ever decides: `loading` was a screen the whole loop
    // already handled (orient waits, mode ignores, heal refuses to abandon, the steps treat it as
    // "not yet") and nothing ever produced it.
    const { composite } = createScreenReaders({});
    const answer = await composite.classify((await pngFrame(BLANK)).frame);
    expect(answer.answer.screen).toBe('loading');
    expect(answer.answer.confidence).toBe(1);
  });
});
