/**
 * The location catalog: the legacy art the design matched, with the id a task file names.
 *
 * `kind` says where the image lives on screen. `control` entries are not travel destinations and are
 * excluded from `TRAVEL_IDS`; a task file may only `travel` to a world-map or dungeon-select node.
 * Labels are what people read in a console line or a report; the ids are stable.
 */
import { RAW_TEMPLATES } from './location-templates.ts';
import type { MatchTemplate } from './match.ts';

export type LocationKind = 'control' | 'worldmap' | 'dungeon-select';

export interface LocationEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: LocationKind;
  readonly template: MatchTemplate;
}

function entry(id: string, label: string, kind: LocationKind): LocationEntry {
  const raw = RAW_TEMPLATES[id]!;
  return {
    id,
    label,
    kind,
    template: {
      width: raw.width,
      height: raw.height,
      gray: Uint8Array.from(Buffer.from(raw.gray, 'base64')),
    },
  };
}

const entries: readonly LocationEntry[] = [
  entry('world-map-icon', 'world map control', 'control'),
  entry('panel-chevron', 'party panel collapse', 'control'),
  entry('inn', '旅店', 'control'),
  entry('city-royal', '都卢库纳里亚', 'worldmap'),
  entry('city-port', '港口镇大军团', 'worldmap'),
  entry('city-dhi', 'DHI', 'worldmap'),
  entry('city-fortress', '要塞', 'worldmap'),
  entry('vnh', '诺森霍洛村', 'worldmap'),
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
