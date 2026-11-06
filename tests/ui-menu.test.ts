import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { exitOf, pageById } from '../src/ui/graph.ts';
import { findUiMenu, UI_TITLE_FLOOR } from '../src/ui/menu.ts';
import { UI_CATALOG } from '../src/ui/pages.ts';

const DIR = new URL('../testdata/screens/2026-11-06-ui/', import.meta.url);

async function image(name: string): Promise<RgbaImage> {
  const raw = jpeg.decode(await readFile(new URL(name, DIR)), { useTArray: true, formatAsRGBA: true });
  return { data: raw.data, width: raw.width, height: raw.height };
}

/** The pages the reader knows, and the still each was measured on. */
const PAGES: readonly { readonly page: string; readonly file: string }[] = [
  { page: 'options', file: 'options-1280.jpg' },
  { page: 'records', file: 'records-1280.jpg' },
  { page: 'missions', file: 'missions-1280.jpg' },
  // The panel is as tall as its list, so a four-task frame puts the title higher: the same page, a
  // different height (measured 2026-11-07: 0.942 here against 1.000 on the three-task still).
  { page: 'missions', file: 'missions-four-tasks-1280.jpeg' },
  { page: 'inventory', file: 'inventory-1280.jpg' },
  { page: 'shop', file: 'shop-items-1280.jpg' },
  { page: 'temple', file: 'temple-1280.jpg' },
  { page: 'trader', file: 'trader-1280.jpg' },
  { page: 'blessed-day', file: 'blessed-day-1280.jpg' },
  // A page with no title: recognised by its one control (the item detail panel that stopped the
  // 99-cycle run's second attempt).
  { page: 'item-detail', file: '../2026-11-07-item-detail/item-detail-1280.jpeg' },
];

describe('the knowledge base reader', () => {
  for (const { page, file } of PAGES) {
    it('names ' + page + ' from its own still, and carries the catalog exit', async () => {
      const expected = exitOf(pageById(UI_CATALOG, page)!)!;
      const match = findUiMenu(await image(file));
      expect(match?.page).toBe(page);
      expect(match!.score).toBeGreaterThanOrEqual(UI_TITLE_FLOOR);
      expect(match!.exit).toEqual(expected.at);
      expect(match!.title).toBe(pageById(UI_CATALOG, page)!.title);
    });
  }

  it('is not fooled by the pages it is not looking at', async () => {
    // 选项 and 记录 are both a centred dark panel with a title at the top; measured 2026-11-06 they are
    // the closest pair in the library (0.540 cross against 1.000 self).
    expect(findUiMenu(await image('options-1280.jpg'))?.page).toBe('options');
    expect(findUiMenu(await image('records-1280.jpg'))?.page).toBe('records');
  });

  it('refuses a frame that is not a catalogued page', async () => {
    expect(findUiMenu(await image('dungeon-3d-1280.jpg'))).toBeNull();
    expect(findUiMenu(await image('town-vnh-1280.jpg'))).toBeNull();
  });
});
