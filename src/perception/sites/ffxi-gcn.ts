/**
 * The FFXI-collab farm site (operator's task: `tasks/ffxi-4f.json`).
 *
 * Floors, by the **visible title** the map draws and the key its title bar produces: the farm floor the
 * task names is **第四区-城内2F深处-** (`000000007f3ffe…`); **第三区-城内2F-** (`0c0280000d(e)ff…`) is the
 * entry floor the Dungeon Select row for `ffxi-zone3` lands on, and the party climbs from it by the
 * map's 楼梯-门 cell. This file's earlier labels were **swapped** against the corpus's visible titles
 * (found 2026-11-09 while reading run 8's map of the entry floor, and by `tests/map.test.ts`'s
 * third/  fourth-floor fixtures); the keys were right, and only `knownFloors` — the leave's book —
 * consumes them today, so nothing behaved differently. The second id is `ffxi-third-2f` for the same
 * reason: it names the floor its key belongs to, not the one the old label claimed.
 *
 * Metrics: the map's panel ink is measured per site. The band is the corpus's (15 000…200 000) and the
 * soft margin 6 000 lets the 第二区/第三区 canvases read at reduced confidence instead of being vetoed.
 * Entry for 第二区-城内1F: its 13 047 px read at 0.85 x 0.6745 = 0.57 in the 2026-11-08 probes.
 */
import type { SiteDescriptor } from '../site.ts';

export const FFXI_GCN: SiteDescriptor = {
  id: 'ffxi-gcn',
  label: 'FFXI collab — 第四区-城内2F深处-',
  floors: [
    { id: 'ffxi-4f', titleKey: '000000007f3ffe007ffeff00220bb600', label: '第四区-城内2F深处-' },
    { id: 'ffxi-third-2f', titleKey: '0c0280000deff0000d7ffc0008c37000', label: '第三区-城内2F-' },
  ],
  screens: {
    dungeonmap: {
      floor: 0.5,
      metrics: {
        panelInk: { kind: 'range', good: [15_000, 200_000], soft: 6_000 },
      },
    },
    'chest-open': { floor: 0.5 },
    'chest-qte': { floor: 0.5 },
    'harken-menu': { floor: 0.5 },
    town: { floor: 0.5 },
    worldmap: { floor: 0.5 },
    'dungeon-select': { floor: 0.5 },
  },
};
