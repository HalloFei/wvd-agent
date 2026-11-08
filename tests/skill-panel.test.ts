import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { decodePng } from '../src/perception/ledger.ts';
import { createScreenReaders } from '../src/perception/reader-set.ts';
import { SkillPanelPerceiver, findPair, ruleWidth } from '../src/perception/skill-panel.ts';

/**
 * The live frame of 2026-11-08 21:12, filed losslessly by the ledger: the battle's skill detail panel
 * (拉巴迪奥斯的秘术, its 取消/確定 pair) — the page whose unnamed frame escalated for 20 s and then had
 * the panel cancelled by the escalation's own Esc.
 */
const PANEL = new URL('../testdata/screens/2026-11-08-battle/skill-panel.png', import.meta.url);
const FADING = new URL('../testdata/screens/2026-11-08-battle/skill-panel-fading.png', import.meta.url);
const DIM = new URL('../testdata/screens/2026-11-08-filter/filter.png', import.meta.url);
const BLANK = new URL('../testdata/screens/2026-11-08-blank-after-battle/blank-after-battle.png', import.meta.url);
const TOWN = new URL('../testdata/frames/town-0.jpg', import.meta.url);
const OPENER = new URL('../testdata/chest/2026-10-24-opener/panel-00.jpg', import.meta.url);
const PAGE = new URL('../testdata/screens/2026-11-03-character-page/page-1920.jpg', import.meta.url);

async function png(url: URL): Promise<{ frame: Frame; image: RgbaImage }> {
  const image = decodePng(await readFile(url));
  return { frame: { atMs: 1, width: image.width, height: image.height, toRgba: async () => image }, image };
}
async function jpg(url: URL): Promise<Frame> {
  const decoded = jpeg.decode(await readFile(url), { useTArray: true, formatAsRGBA: true });
  const image: RgbaImage = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
  return { atMs: 1, width: image.width, height: image.height, toRgba: async () => image };
}

describe('the skill detail panel', () => {
  it('names the page from its own button pair and rule', async () => {
    const { frame, image } = await png(PANEL);
    // Measured on the live frame: two plate runs of the same width, a clear gap, and a rule above them.
    const pair = findPair(image);
    expect(pair).not.toBeNull();
    expect(Math.abs(pair!.first - pair!.second)).toBeLessThanOrEqual(8);
    expect(pair!.gap).toBeGreaterThanOrEqual(8);
    expect(ruleWidth(image)).toBeGreaterThanOrEqual(150);

    const observation = await new SkillPanelPerceiver().observe(frame);
    expect(observation.screen).toBe('skill-panel');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('refuses every page that is not it', async () => {
    const panel = new SkillPanelPerceiver();
    // The battle's command phase, a dim menu over a dark room, a black frame, the town, the opener
    // panel and the character page: none of them draws a two-button dialog in that band.
    for (const frame of [
      (await png(FADING)).frame,
      (await png(DIM)).frame,
      (await png(BLANK)).frame,
      await jpg(TOWN),
      await jpg(OPENER),
      await jpg(PAGE),
    ]) {
      expect((await panel.observe(frame)).screen).toBe('unknown');
    }
  });

  it('is held out of the chain: its pair also matches a world map s label plates', async () => {
    // 2026-11-08 22:08: a world-map frame was named `skill-panel` and the loop stalled on it while
    // travelling. The page is real and its fixture is filed; the reader goes back into the chain when
    // the pair is anchored to a *dialog* (inset, ruled) rather than to the shape alone.
    const { composite } = createScreenReaders({});
    const answer = await composite.classify((await png(PANEL)).frame);
    expect(answer.answer.screen).not.toBe('skill-panel');
  });
});
