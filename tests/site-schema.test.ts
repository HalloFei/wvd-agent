import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { readMap, readMapDetailed } from '../src/perception/map.ts';
import { FFXI_GCN } from '../src/perception/sites/ffxi-gcn.ts';
import { floorOf, floorFor, isTitleKey, metricFor, siteProblem } from '../src/perception/site.ts';

/**
 * The site descriptor (2026-11-08): the per-site *numbers* leave the readers, the *vocabulary* stays.
 * A farm location is then a descriptor — floors, title keys, a confidence floor, and band overrides for
 * metrics whose values the site re-measured — and every reader that meets the screen reads it.
 */
describe('the committed FFXI site', () => {
  it('is a well-formed descriptor', () => {
    expect(siteProblem(FFXI_GCN)).toBeNull();
  });

  it('knows the farm floor by its title key, and the entry floor the zone row lands on', () => {
    expect(floorOf(FFXI_GCN, 'ffxi-4f')).toEqual({
      id: 'ffxi-4f',
      titleKey: '000000007f3ffe007ffeff00220bb600',
      label: '第四区-城内2F深处-',
    });
    // The entry floor: the Dungeon Select row for ffxi-zone3 lands here, and the map's 楼梯-门 cell is
    // how the party climbs to the farm. Its key and its visible title are measured (tests/map.test.ts).
    expect(floorOf(FFXI_GCN, 'ffxi-third-2f')).toEqual({
      id: 'ffxi-third-2f',
      titleKey: '0c0280000deff0000d7ffc0008c37000',
      label: '第三区-城内2F-',
    });
    expect(FFXI_GCN.floors.every((floor) => isTitleKey(floor.titleKey))).toBe(true);
    expect(floorOf(FFXI_GCN, 'fourth-2f')).toBeUndefined();
  });

  it('sets the map screen s floor and its ink band', () => {
    expect(floorFor(FFXI_GCN, 'dungeonmap', 0.9)).toBe(0.5);
    expect(metricFor(FFXI_GCN, 'dungeonmap', 'panelInk', { kind: 'max', good: 0, soft: 1 }))
      .toEqual({ kind: 'range', good: [15_000, 200_000], soft: 6_000 });
    // A screen or a metric the site does not name falls back to the reader's own measured default —
    // "no opinion" is never a guess.
    expect(metricFor(FFXI_GCN, 'dungeonmap', 'chevronResidual', { kind: 'max', good: 2, soft: 1 }))
      .toEqual({ kind: 'max', good: 2, soft: 1 });
    expect(floorFor(FFXI_GCN, 'combat', 0.7)).toBe(0.7);
  });
});

describe('the map reader reads the same with the site it reads for', () => {
  const FIXTURE = new URL('../testdata/nav-2026-11-01-maps/fourth-2f.jpg', import.meta.url);

  it('keeps its measured confidence when the site s band agrees', async () => {
    const decoded = jpeg.decode(await readFile(FIXTURE), { useTArray: true, formatAsRGBA: true });
    const image = { data: decoded.data, width: decoded.width, height: decoded.height };
    const frame = { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };

    const parsed = await readMapDetailed(frame);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.confidence).toBe(0.85);
    expect(await readMap(frame)).not.toBeNull();
  });
});
