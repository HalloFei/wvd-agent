/**
 * The two screens the entry needs and the HUD cannot name: the town (where the world-map control
 * lives) and the world map itself.
 *
 * `TownPerceiver` matches the party-panel chevron and the world-map icon in the lower band. The
 * chevron is primary evidence — the icon is covered while the panel is up (measured 0.475) — and the
 * two legacy templates score 0.955 and 0.975 when the screen really is the town.
 *
 * The live client redrew the chevron tile: on the 2026-11-07 21:14 town frame
 * (`testdata/screens/2026-11-07-town-live/town-1920.jpg`) the legacy mobile-art template's best score
 * is **0.600**, below the 0.8 floor, and the world-map icon is still covered (0.481), so the camera
 * went unnamed while its party panel lit the battle windows. The tile is drawn at 1:1 by this client,
 * and `town-template.ts` carries the live art as a second sample: it scores **1.000** on that frame,
 * 0.943–0.956 on the six town frames recorded 2026-10-25, and at most 0.497 on every other 1920×1080
 * frame in `testdata/`. `WorldMapPerceiver` uses a
 * cheap structural fact instead: the PC build letterboxes the portrait map field between two black
 * pillars (measured 0.0 and 1.5 mean luma against ≥20.5 on every other committed screen).
 *
 * Both return `unknown` at confidence **0** when they have no answer. That is deliberate: the
 * composite takes the strongest positive confidence when nothing clears a floor, and `HudPerceiver`
 * already reports 0.2 for a busy frame nobody named. A positive value here would mask a black
 * frame's 0 and turn a stop into an escalation.
 *
 * Cost: the entry runs outside the 10 Hz tick, but these two are in the composite, so each gate reads
 * only the band or the two pillars; the legacy chevron and the world-map icon use the two measured
 * scales (0.66, 0.68) and the live chevron 1:1, rather than the full sweep.
 */
import type { Frame, Observation, Perceiver, PixelRect, RgbaImage } from '../contracts.ts';
import { LOCATIONS } from './locations.ts';
import { findTemplate, type MatchTemplate } from './match.ts';
import { TOWN_PANEL_CHEVRON_BASE64 } from './town-template.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The live client's party-panel chevron, 34×26 at (679,789) on the 2026-11-07 town frame. */
const TOWN_PANEL_CHEVRON: MatchTemplate = {
  width: 34,
  height: 26,
  gray: Uint8Array.from(Buffer.from(TOWN_PANEL_CHEVRON_BASE64, 'base64')),
};
/** The live tile's band: it sits left of the party cards' centre column, at 1:1 on this client. */
export const TOWN_PANEL_CHEVRON_BAND: PixelRect = { x: 600, y: 740, width: 300, height: 160 };

/** The three controls that mean "town": the chevron (two arts) with the panel up, the icon with it down. */
const TOWN_EVIDENCE: readonly {
  readonly template: MatchTemplate;
  readonly band: PixelRect;
  readonly scales: readonly number[];
}[] = [
  // The live client's own art, tried first: cheapest, and it also carries the 2026-10-25 frames (0.943+).
  { template: TOWN_PANEL_CHEVRON, band: TOWN_PANEL_CHEVRON_BAND, scales: [1] },
  // The legacy mobile art at the PC UI's 0.66–0.68; still the evidence on the older layout.
  {
    template: LOCATIONS.get('panel-chevron')!.template,
    band: { x: 480, y: 720, width: 400, height: 360 },
    scales: [0.66, 0.68],
  },
  {
    template: LOCATIONS.get('world-map-icon')!.template,
    band: { x: 1_100, y: 900, width: 220, height: 180 },
    scales: [0.66, 0.68],
  },
];
const CONTROL_FLOOR = 0.8;
const TOWN_CONFIDENCE_FLOOR = 0.5;

/** The map field's black pillars, and the lit field between them (measured 2026-10-24). */
const PILLAR_LEFT = { x: 0, y: 0, width: 400, height: 1_080 } as const;
const PILLAR_RIGHT = { x: 1_520, y: 0, width: 400, height: 1_080 } as const;
const MAP_FIELD = { x: 500, y: 100, width: 1_000, height: 800 } as const;
const PILLAR_MEAN_MAX = 8;
const FIELD_MEAN_MIN = 90;
const WORLD_MAP_CONFIDENCE = 0.9;

export class TownPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const image = await decode(frame);
    if (image === null) return unnamed(frame.atMs);
    // With the panel up the chevron is the evidence; with it down the chevron is drawn differently
    // and the world-map icon is what appears. The icon is covered in the panel-up state (0.475).
    for (const { template, band, scales } of TOWN_EVIDENCE) {
      const score = findTemplate(image, band, template, { scales })?.score ?? 0;
      if (score < CONTROL_FLOOR) continue;
      const earned = (score - CONTROL_FLOOR) / (1 - CONTROL_FLOOR);
      return {
        screen: 'town',
        atMs: frame.atMs,
        confidence: Math.min(1, TOWN_CONFIDENCE_FLOOR + (1 - TOWN_CONFIDENCE_FLOOR) * earned),
      };
    }
    return unnamed(frame.atMs);
  }
}

export class WorldMapPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const image = await decode(frame);
    if (image === null) return unnamed(frame.atMs);
    const left = meanLuma(image, PILLAR_LEFT);
    const right = meanLuma(image, PILLAR_RIGHT);
    const field = meanLuma(image, MAP_FIELD);
    if (left > PILLAR_MEAN_MAX || right > PILLAR_MEAN_MAX || field < FIELD_MEAN_MIN) return unnamed(frame.atMs);
    return { screen: 'worldmap', atMs: frame.atMs, confidence: WORLD_MAP_CONFIDENCE };
  }
}

/** A frame this perceiver refuses: confidence 0, so a flat frame can still stop a session. */
function unnamed(atMs: number): Observation {
  return { screen: 'unknown', atMs, confidence: 0 };
}

async function decode(frame: Frame): Promise<RgbaImage | null> {
  if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) return null;
  try {
    const image = await frame.toRgba();
    return image.width === frame.width && image.height === frame.height ? image : null;
  } catch {
    return null;
  }
}

/** Mean luma over a rectangle, every fourth pixel, the map parser's uniformity sampling stride. */
function meanLuma(image: RgbaImage, rect: { x: number; y: number; width: number; height: number }): number {
  const stride = 4;
  let sum = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += stride) {
    const row = y * image.width;
    for (let x = rect.x; x < rect.x + rect.width; x += stride) {
      const offset = (row + x) * 4;
      sum += ((image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1000) | 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
