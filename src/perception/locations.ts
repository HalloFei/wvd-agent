/**
 * The location catalog: the legacy art the design matched, with the id a task file names.
 *
 * `kind` says where the image lives on screen. `control` entries are not travel destinations and are
 * excluded from `TRAVEL_IDS`; a task file may only `travel` to a world-map or dungeon-select node.
 * Labels are what people read in a console line or a report; the ids are stable.
 */
import type { Point } from '../contracts.ts';
import { RAW_TEMPLATES } from './location-templates.ts';
import type { MatchTemplate } from './match.ts';

export type LocationKind = 'control' | 'worldmap' | 'dungeon-select';

export interface LocationEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: LocationKind;
  readonly template: MatchTemplate;
  /** Added to the template's centre to reach the control's hit point; absent means the centre. */
  readonly anchor?: Point;
  /**
   * The same art's label band (the bottom third), for a world-map node whose icon does not match
   * away from zoom 1.0. The label is screen-space art: it keeps the UI scale at every map zoom,
   * while the node icon is drawn at the map's zoom (halved at the PC's max zoom-out), so the
   * composite template cannot match there. Measured live 2026-10-31: the band scores 0.856 on the
   * map opened from Dungeon Select at max zoom-out.
   */
  readonly labelBand?: MatchTemplate;
}

/** Where the mobile art's label band starts, as a fraction of its height (measured on City_VNH). */
const LABEL_BAND_TOP = 0.687;

function entry(id: string, label: string, kind: LocationKind, anchor?: Point, banded = false): LocationEntry {
  const raw = RAW_TEMPLATES[id]!;
  const gray = Uint8Array.from(Buffer.from(raw.gray, 'base64'));
  const top = Math.round(raw.height * LABEL_BAND_TOP);
  return {
    id,
    label,
    kind,
    template: { width: raw.width, height: raw.height, gray },
    ...(anchor === undefined ? {} : { anchor }),
    ...(banded ? { labelBand: { width: raw.width, height: raw.height - top, gray: gray.subarray(top * raw.width) } } : {}),
  };
}

const entries: readonly LocationEntry[] = [
  // 2026-10-24 the initial town's button took (1177,1012); 2026-10-31 the rest town after a harken
  // return ignored that point and opened at the guide's (1185,1023), i.e. 9 px left and 1 px up of
  // the template centre. The guide point is the wider hit area and keeps both towns working.
  entry('world-map-icon', 'world map control', 'control', { x: -9, y: -1 }),
  // The Dungeon Select row that opens the world map; the legacy `openworldmap` control.
  entry('open-world-map', '打开世界地图', 'control'),
  entry('panel-chevron', 'party panel collapse', 'control'),
  entry('inn', '旅店', 'control'),
  entry('city-royal', '都卢库纳里亚', 'worldmap'),
  entry('city-port', '港口镇大军团', 'worldmap'),
  entry('city-dhi', 'DHI', 'worldmap'),
  entry('city-fortress', '要塞', 'worldmap'),
  // The village sits far west of where the Dungeon Select map opens; the live search only sees it
  // at max zoom-out, where its icon is half size and only the label band can be matched.
  entry('vnh', '诺森霍洛村', 'worldmap', undefined, true),
  entry('ffxi-gcn', '北穿幽冥城', 'worldmap'),
  entry('ffxi-zone1', '第一区-城外-', 'dungeon-select'),
  entry('ffxi-zone2', '第二区-城内1F-', 'dungeon-select'),
  entry('ffxi-zone3', '第三区-城内2F-', 'dungeon-select'),
];

export const LOCATIONS: ReadonlyMap<string, LocationEntry> = new Map(entries.map((item) => [item.id, item]));

/** The ids a task file may name in a `travel` step: destinations, not controls. */
export const TRAVEL_IDS: ReadonlySet<string> = new Set(
  entries.filter((item) => item.kind !== 'control').map((item) => item.id),
);
