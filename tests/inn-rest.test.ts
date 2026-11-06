import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { InnRestPerceiver, REST_BLUR_MAX, REST_CAPTION_SHARE, blurScore, captionShare } from '../src/perception/inn-rest.ts';

const REST = new URL('../testdata/screens/2026-11-07-inn-rest/', import.meta.url);
const CHEST = new URL('../testdata/chest/2026-10-24-live-qte/', import.meta.url);
const MESSAGE = new URL('../testdata/screens/2026-11-06-message/', import.meta.url);
const ITEM = new URL('../testdata/screens/2026-11-07-item-detail/', import.meta.url);
const UI = new URL('../testdata/screens/2026-11-06-ui/', import.meta.url);
const LOOT = new URL('../testdata/screens/2026-11-06-loot-currency/', import.meta.url);

const cache = new Map<string, Promise<RgbaImage>>();
function image(name: string, dir: URL): Promise<RgbaImage> {
  const key = new URL(name, dir).href;
  let decoded = cache.get(key);
  if (decoded === undefined) {
    decoded = readFile(new URL(name, dir)).then((bytes) => {
      const still = jpeg.decode(bytes, { useTArray: true });
      return { data: still.data, width: still.width, height: still.height };
    });
    cache.set(key, decoded);
  }
  return decoded;
}

const frameOf = (image: RgbaImage): Frame => ({ atMs: 0, width: image.width, height: image.height, toRgba: async () => image });

describe('the inn rest scene', () => {
  const perceiver = new InnRestPerceiver();

  it('names the scene that stalled the cycle, and carries its continue mark as the tap', async () => {
    const still = await image('rest-scene-1280.jpeg', REST);
    const answer = await perceiver.observe(frameOf(still));
    expect(answer.screen).toBe('inn-rest');
    if (answer.screen !== 'inn-rest') throw new Error('not the rest scene');
    expect(answer.confidence).toBeGreaterThan(0.5);
    // The yellow continue mark under the caption, in the frame's own pixels.
    expect(answer.at.x).toBeGreaterThan(700);
    expect(answer.at.x).toBeLessThan(900);
    expect(answer.at.y).toBeGreaterThan(620);
    expect(answer.at.y).toBeLessThan(720);
  });

  it("separates it from the chest opening by blur: the rest scene is the game's only full defocus", async () => {
    const rest = await image('rest-scene-1280.jpeg', REST);
    expect(blurScore(rest)).toBeLessThanOrEqual(REST_BLUR_MAX);
    for (const name of ['open-00.jpg', 'open-03.jpg', 'open-07.jpg']) {
      const opening = await image(name, CHEST);
      expect(blurScore(opening), name).toBeGreaterThan(REST_BLUR_MAX);
      expect((await perceiver.observe(frameOf(opening))).screen, name).not.toBe('inn-rest');
    }
  });

  it('refuses the other blurred screens: no caption, or no mark', async () => {
    for (const [name, dir] of [
      ['message-1280.jpg', MESSAGE],
      ['item-detail-1280.jpeg', ITEM],
      ['records-1280.jpg', UI],
    ] as Array<[string, URL]>) {
      const still = await image(name, dir);
      expect(captionShare(still), name).toBeLessThan(REST_CAPTION_SHARE);
      expect((await perceiver.observe(frameOf(still))).screen, name).not.toBe('inn-rest');
    }
  });

  it('refuses the sharp screens that also carry the mark', async () => {
    for (const [name, dir] of [
      ['loot-currency-1920.jpeg', LOOT],
      ['loot-item-card-1920.jpg', LOOT],
      ['dungeon-3d-1280.jpg', UI],
    ] as Array<[string, URL]>) {
      const still = await image(name, dir);
      expect((await perceiver.observe(frameOf(still))).screen, name).not.toBe('inn-rest');
    }
  });
});
