import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { findHarkenMenu, HarkenMenuPerceiver } from '../src/perception/harken.ts';

/**
 * The harken's floor menu (operator rule 2026-11-03). The list is **not fixed** — a harken offers a
 * floor only once that floor's harken is reconstructed, so a new harken may draw nothing but 归还 —
 * which is why the reader finds the rows and matches their labels against a measured library instead
 * of trusting a layout.
 *
 * The fixture is the live menu at 第三区-城内2F (2026-11-03), 1600×900; the reader's geometry is in
 * fractions, so the same numbers serve the World's 1920×1080 client.
 */
const HARKEN = new URL('../testdata/screens/2026-11-03-harken-menu/', import.meta.url);
const MAP = new URL('../testdata/screens/2026-11-03-ffxi-map/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);

const cache = new Map<string, Promise<RgbaImage>>();
function image(name: string, dir: URL): Promise<RgbaImage> {
  const url = new URL(name, dir);
  const key = url.href;
  let decoded = cache.get(key);
  if (decoded === undefined) {
    decoded = readFile(url).then((bytes) => {
      const jpegImage = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return { data: jpegImage.data, width: jpegImage.width, height: jpegImage.height };
    });
    cache.set(key, decoded);
  }
  return decoded;
}

function frameOf(source: RgbaImage): Frame {
  return { atMs: 0, width: source.width, height: source.height, toRgba: async () => source };
}

describe('the harken floor menu', () => {
  it('finds the rows the operator named, top to bottom', async () => {
    const menu = findHarkenMenu(await image('harken-2f.jpg', HARKEN));
    expect(menu).not.toBeNull();
    expect(menu!.rows.map((row) => row.label)).toEqual([
      '第一区-城外-',
      '第二区-城内1F-',
      '第四区-城内2F深处-',
      '归还',
    ]);
    // The rows are the dialogue's own layout: 0.0667 of the height apart, labels on the centre line.
    const ys = menu!.rows.map((row) => row.at.y);
    expect(ys[1]! - ys[0]!).toBeCloseTo(ys[2]! - ys[1]!, 0);
    expect(ys.every((y) => Math.abs(y / 900 - 0) > 0)).toBe(true);
  });

  it('names the frame harken-menu, and no other screen is the menu', async () => {
    const perceiver = new HarkenMenuPerceiver();
    const menu = await perceiver.observe(frameOf(await image('harken-2f.jpg', HARKEN)));
    expect(menu.screen).toBe('harken-menu');
    if (menu.screen === 'harken-menu') expect(menu.rows).toHaveLength(4);

    for (const [name, dir] of [['map-1920.jpg', MAP], ['alice-command-phase.jpg', BATTLE]] as const) {
      expect((await perceiver.observe(frameOf(await image(name, dir)))).screen).toBe('unknown');
    }
  });

  it('never names a row the library has not measured', async () => {
    // A menu of unknown labels is not this screen: the reader answers null rather than the closest
    // name, which is what leaves the climb with the stair walk instead of a guessed teleport.
    const menu = findHarkenMenu(await image('map-1920.jpg', MAP));
    expect(menu).toBeNull();
  });
});
