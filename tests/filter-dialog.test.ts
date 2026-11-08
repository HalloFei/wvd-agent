import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { decodePng } from '../src/perception/ledger.ts';
import { FilterDialogPerceiver, background, findExit } from '../src/perception/filter-dialog.ts';
import { createScreenReaders } from '../src/perception/reader-set.ts';

/**
 * The live frame of 2026-11-08 (the farm's recurring unnamed page), filed losslessly by the ledger: the
 * item filter (筛选) over its blurred background. It is a page with an exit, so it is named `ui-menu`
 * with the plate that leaves it — the World's one job with such a page.
 */
const FILTER = new URL('../testdata/screens/2026-11-08-filter/filter.png', import.meta.url);
const PANEL = new URL('../testdata/screens/2026-11-08-battle/skill-panel.png', import.meta.url);
const BLANK = new URL('../testdata/screens/2026-11-08-blank-after-battle/blank-after-battle.png', import.meta.url);
const TOWN = new URL('../testdata/frames/town-0.jpg', import.meta.url);
const PAGE = new URL('../testdata/screens/2026-11-03-character-page/page-1920.jpg', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/command-phase.jpg', import.meta.url);

async function png(url: URL): Promise<{ frame: Frame; image: RgbaImage }> {
  const image = decodePng(await readFile(url));
  return { frame: { atMs: 1, width: image.width, height: image.height, toRgba: async () => image }, image };
}
async function jpg(url: URL): Promise<Frame> {
  const decoded = jpeg.decode(await readFile(url), { useTArray: true, formatAsRGBA: true });
  const image: RgbaImage = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  return { atMs: 1, width: image.width, height: image.height, toRgba: async () => image };
}

describe('the item filter', () => {
  it('is named from its blurred background, and reports the plate that leaves it', async () => {
    const { frame, image } = await png(FILTER);
    const sides = background(image);
    // Measured: the page's sides are 2.3 luma and 0.25 detail; every other page is 31+ and 4.4+.
    expect(sides.luma).toBeLessThan(12);
    expect(sides.detail).toBeLessThan(1.5);

    const observation = await new FilterDialogPerceiver().observe(frame);
    expect(observation.screen).toBe('ui-menu');
    if (observation.screen !== 'ui-menu') throw new Error('not named');
    expect(observation.page).toBe('filter');
    // The exit is located on the frame: the OK plate's middle row (measured 959, 999), not a constant.
    expect(observation.exit).toEqual(findExit(image));
    expect(observation.exit.x).toBeGreaterThan(900);
    expect(observation.exit.x).toBeLessThan(1_020);
    expect(observation.exit.y).toBeGreaterThan(960);
    expect(observation.exit.y).toBeLessThan(1_040);
    expect(observation.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('refuses every page that is not it', async () => {
    const filter = new FilterDialogPerceiver();
    // The battle's skill panel, the town, the character page, the battle's command phase — and the
    // **black** frame, which has no detail either and is `loading`, never this page.
    for (const frame of [
      (await png(PANEL)).frame,
      (await png(BLANK)).frame,
      await jpg(TOWN),
      await jpg(PAGE),
      await jpg(BATTLE),
    ]) {
      expect((await filter.observe(frame)).screen).toBe('unknown');
    }
  });

  it('is kept out of the chain until a second live drawing anchors it', async () => {
    // 2026-11-08 22:01: the blur anchor alone named the **world map** at 0.87 and the loop pressed three
    // points on it. The page stays `unknown` (an escalation) until its content anchors it — a wrong tap
    // on the map travels somewhere, which is worse than a question.
    const { composite } = createScreenReaders({});
    const answer = await composite.classify((await png(FILTER)).frame);
    expect(answer.answer.screen).toBe('unknown');
  });
});
