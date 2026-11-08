/**
 * The FFXI-collab farm site (operator's task: `tasks/ffxi-4f.json`).
 *
 * Floors: the farm floor is **第三区-城内2F-**, the one the task file names; the harken took the party
 * to **第四区-城内2F深处-** on 2026-11-08 and that read is recorded here too, because a floor the loop
 * lands on must be identifiable rather than unknown.
 *
 * Metrics: the map's panel ink is measured per site. The band is the corpus's (15 000…200 000) and the
 * soft margin 6 000 lets the 第二区/第四区 canvases read at reduced confidence instead of being vetoed.
 * Entry for 第二区-城内1F: its 13 047 px read at 0.85 x 0.6745 = 0.57 in the 2026-11-08 probes.
 */
import type { SiteDescriptor } from '../site.ts';

export const FFXI_GCN: SiteDescriptor = {
  id: 'ffxi-gcn',
  label: 'FFXI collab — 第三区-城内2F-',
  floors: [
    { id: 'ffxi-4f', titleKey: '000000007f3ffe007ffeff00220bb600', label: '第三区-城内2F-' },
    { id: 'ffxi-fourth-2f', titleKey: '0c0280000deff0000d7ffc0008c37000', label: '第四区-城内2F深处-' },
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
