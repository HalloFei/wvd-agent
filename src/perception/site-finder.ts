/**
 * Finding one site on the world map, and nothing else.
 *
 * The rule the operator set (2026-11-09): a site is found by **its own icon and its own title**, at any
 * position and any size. Other sites may *hint* where in the world we are looking — the atlas does
 * that — but they must never gate the find: the old travel required another site's banner to be
 * legible before it would even look for the target, and when no banner was in view the whole plan
 * collapsed to a corner clamp.
 *
 * The pair is the evidence, and it is cheap:
 *
 * - the **icon** is map-space art, so it is the one thing that scales with the zoom level — the caller
 *   hands in that level's scale bank (\`iconScales\`), measured per level, not derived;
 * - the **title** is screen-space art (it keeps the UI scale at every zoom) and it sits a fixed
 *   screen-space rise below the icon, which makes the pair a consistency test: an icon found without
 *   its own title is not that site.
 *
 * At the coarsest level some titles are not drawn at all, so the caller may ask for the icon alone
 * there (\`wantTitle: false\`) and for the pair at the level above it. A site opens at level 1, where
 * every title is drawn.
 */
import type { PixelRect, Point, RgbaImage } from '../contracts.ts';
import type { LocationEntry } from './locations.ts';
import { findTemplate } from './match.ts';
import { LOCATIONS } from './locations.ts';

/** One site the frame shows, with the evidence that says so. */
export interface SiteCandidate {
  readonly id: string;
  readonly label: string;
  /** The icon's click point, in the frame's own pixels. */
  readonly point: Point;
  readonly iconScore: number;
  readonly iconScale: number;
  /** The title's score, or null when this level was asked for the icon alone. */
  readonly titleScore: number | null;
  /** The pair's own confidence: the icon, discounted for a title that was asked for and not found. */
  readonly confidence: number;
}

export interface FindSiteOptions {
  /** Where the game draws the map (the strip between the pillars). */
  readonly strip: PixelRect;
  /** The icon's drawn scale on the levels in play — measured per level, never derived. */
  readonly iconScales: readonly number[];
  /** The title's scale bank; the title is UI-space, so this is near 1 at every level. */
  readonly titleScales?: readonly number[];
  readonly minIconScore?: number;
  readonly minTitleScore?: number;
  /** Whether to require the title as well. False only at the coarsest level (titles are not drawn). */
  readonly wantTitle?: boolean;
  /** The title's centre sits this far below the icon's centre, in screen pixels. */
  readonly risePx?: number;
}

/** The icon's floor: measured live, a true node scores 0.9+ and parchment scores below 0.5. */
export const ICON_FLOOR = 0.72;
/** The title's floor: the label band is screen-space art, measured 0.86–0.95 on live frames. */
export const TITLE_FLOOR = 0.8;
/** The icon's centre to the title's centre, screen pixels (measured on live frames). */
export const TITLE_RISE_PX = 40;

/**
 * The site this frame shows, or null. No other site is consulted: the atlas offset is the caller's
 * business, and a frame with no target on it simply answers null.
 */
export function findSite(image: RgbaImage, entry: LocationEntry, options: FindSiteOptions): SiteCandidate | null {
  const icon = findTemplate(image, options.strip, entry.template, {
    scales: options.iconScales,
    minScore: options.minIconScore ?? ICON_FLOOR,
  });
  if (icon === null) return null;
  const point = {
    x: icon.at.x + Math.round(icon.width / 2) + (entry.anchor?.x ?? 0),
    y: icon.at.y + Math.round(icon.height / 2) + (entry.anchor?.y ?? 0),
  };
  const wantTitle = options.wantTitle ?? true;
  const band = entry.labelBand;
  if (!wantTitle || band === undefined) {
    return {
      id: entry.id,
      label: entry.label,
      point,
      iconScore: icon.score,
      iconScale: icon.scale,
      titleScore: null,
      confidence: icon.score,
    };
  }
  // The title is drawn below the icon, centred on it: search a window that is wide enough for the
  // banner and tall enough for the rise, so the check cannot be satisfied by a neighbouring title.
  const rise = options.risePx ?? TITLE_RISE_PX;
  const width = Math.max(band.width * 2, 240);
  const area: PixelRect = {
    x: point.x - Math.round(width / 2),
    y: point.y + Math.round(rise - band.height),
    width,
    height: Math.round(band.height * 3),
  };
  const title = findTemplate(image, area, band, {
    scales: options.titleScales ?? [1],
    minScore: options.minTitleScore ?? TITLE_FLOOR,
  });
  if (title === null) {
    // An icon without its own title is not the pair: the caller may accept the icon alone at the
    // coarsest level, but not here.
    return null;
  }
  return {
    id: entry.id,
    label: entry.label,
    point,
    iconScore: icon.score,
    iconScale: icon.scale,
    titleScore: title.score,
    // A pair is worth what its weaker half is worth, and a little more than the weaker half alone,
    // because the two are independent evidence for the same site.
    confidence: Math.min(1, (Math.min(icon.score, title.score) + 0.1 * Math.max(icon.score, title.score))),
  };
}

/** Every site the frame shows, best first. A caller with one target asks the single-entry form. */
export function findSites(
  image: RgbaImage,
  entries: readonly LocationEntry[],
  options: FindSiteOptions,
): SiteCandidate[] {
  const found: SiteCandidate[] = [];
  for (const entry of entries) {
    const candidate = findSite(image, entry, options);
    if (candidate !== null) found.push(candidate);
  }
  return found.sort((left, right) => right.confidence - left.confidence);
}

/** The same, over catalogued ids (a convenience for a caller that has ids and not entries). */
export function findSitesById(image: RgbaImage, ids: readonly string[], options: FindSiteOptions): SiteCandidate[] {
  const entries: LocationEntry[] = [];
  for (const id of ids) {
    const entry = LOCATIONS.get(id);
    if (entry !== undefined) entries.push(entry);
  }
  return findSites(image, entries, options);
}
