import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { ChestOpeningPerceiver } from '../src/perception/chest-opening.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';

/**
 * The opening moment has no bar, no panel and **no party HUD** — the lid fills the frame and the
 * hands reach in. Two cheap measurements name it: the HUD's bright text is gone (< 40 px in its
 * band; the opening frames measure 0–12, every other screen 153+ except loot), and the chest fills
 * the middle (warm pixels ≥ 6 % of the central half-frame: opening 0.09–0.31, the 3-D view 0.01,
 * loot 0.03).
 *
 * The fixtures are the eight `open-*.jpg` frames of the 2026-10-24 chest, native 1920×1080. The
 * negatives are the screens it must never take: the 3-D view, the bar, the opener panel, the loot
 * overlay, and the 打开 prompt (which shares the missing HUD and is named by the prompt recogniser
 * that runs before this one).
 */
const CHEST = new URL('../testdata/chest/2026-10-24-live-qte/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-25-ffxi4f/', import.meta.url);
/** The 3-D view right after a QTE cancel: the FFXI dungeon draws the HUD lower than the walk view. */
const CANCEL_NAV = new URL('../testdata/nav-2026-10-31-cancel/', import.meta.url);
const OPENER = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const LOOT = new URL('../testdata/chest/2026-10-31-loot/', import.meta.url);

async function image(name: string, dir: URL): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

const frameOf = (image: RgbaImage): Frame => ({
  atMs: 0,
  width: image.width,
  height: image.height,
  toRgba: async () => image,
});

describe('ChestOpeningPerceiver', () => {
  const perceiver = new ChestOpeningPerceiver();

  it('names all eight opening frames of the recorded chest', async () => {
    for (const name of ['open-00.jpg', 'open-01.jpg', 'open-02.jpg', 'open-03.jpg', 'open-04.jpg', 'open-05.jpg', 'open-06.jpg', 'open-07.jpg']) {
      const observation = await perceiver.observe(frameOf(await image(name, CHEST)));
      expect(observation.screen, name).toBe('chest-opening');
      expect(observation.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('never takes a 3-D view, the bar, the panel, the loot or the prompt', async () => {
    const cases: Array<[string, URL]> = [
      ['third-floor-harken.jpg', NAV],
      // The live frame this perceiver mis-named on 2026-10-31: the FFXI dungeon's HUD sits in the
      // lower band (1 634 bright px) while the warm wall fills the centre (0.223), so one band alone
      // read as an opening and the route's wait stopped the loop over an ordinary dungeon frame.
      ['after-cancel.jpg', CANCEL_NAV],
      ['qte-bar-00.jpg', CHEST],
      ['panel-00.jpg', OPENER],
      ['loot-00.jpg', LOOT],
    ];
    for (const [name, dir] of cases) {
      const observation = await perceiver.observe(frameOf(await image(name, dir)));
      expect(observation.screen, name).not.toBe('chest-opening');
    }
  });

  it('does not steal the 打开 prompt when composed behind the prompt recogniser', async () => {
    // The prompt also draws no HUD, and this recogniser alone would call it the opening (see the
    // table in its header). The composition order is the contract: the prompt recogniser runs
    // first, so the loop sees `chest-prompt` and presses 打开 instead of waiting forever.
    const composite = new CompositePerceiver([
      { perceiver: new ChestPromptPerceiver(), floor: 0.5 },
      { perceiver: new ChestOpeningPerceiver(), floor: 0.5 },
    ]);
    const observation = await composite.observe(frameOf(await image('prompt-ffxi.jpg', OPENER)));
    expect(observation.screen).toBe('chest-prompt');
  });

  it('refuses a frame that is not the client size', async () => {
    const shrunk = { data: Uint8Array.of(0, 0, 0, 255), width: 64, height: 64 };
    const observation = await perceiver.observe(frameOf(shrunk));
    expect(observation.screen).toBe('unknown');
    expect(observation.confidence).toBeLessThanOrEqual(0.2);
  });
});
