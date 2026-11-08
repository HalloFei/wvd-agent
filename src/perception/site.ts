/**
 * The per-site descriptor: **perception as data**.
 *
 * The readers know the *shape* of evidence — an anchor is a structural fact, a metric has a band and a
 * soft margin (evidence.ts). They must not know a particular site's numbers: which floors exist, which
 * title keys are the farm's, how much white ink a canvas draws, where a screen's rects sit when a UI
 * revision moves them. Those are measured facts about one location, and they belong in a descriptor so a
 * new farm location costs data, not code (operator, 2026-11-08: does this adapt to other farm locations,
 * and how much adaptation does it need).
 *
 * What stays in code is the vocabulary: the anchor names, the metric names, the parsers. A site may
 * override a metric's band; it may not invent a metric the reader does not measure — `metricFor` falls
 * back to the reader's own measured default, so a site that forgets a number degrades to today's
 * behaviour instead of inventing one.
 */
import type { ScreenId } from '../contracts.ts';
import type { MetricShape } from './evidence.ts';

/** One floor of the site: the identity the map read must match, and a label for the log. */
export interface SiteFloor {
  /** Stable id, for the task file and the board. */
  readonly id: string;
  /** The 32-hex title fingerprint the map's own title bar produces on this floor. */
  readonly titleKey: string;
  /** What the game calls it, as the operator reads it (第三区-城内2F-). */
  readonly label: string;
}

/** What a screen is worth at this site: the floor the composite acts above, and band overrides. */
export interface SiteScreen {
  /** The confidence a read of this screen must reach to be acted on. */
  readonly floor: number;
  /** Named metrics this site re-measures; anything absent falls back to the reader's default. */
  readonly metrics?: Readonly<Record<string, MetricShape>>;
}

export interface SiteDescriptor {
  readonly id: string;
  readonly label: string;
  /** The site's floors, the first one being the farm's own. */
  readonly floors: readonly SiteFloor[];
  /** Per-screen evidence policy; a screen absent here uses the reader's defaults. */
  readonly screens: Readonly<Partial<Record<ScreenId, SiteScreen>>>;
}

/**
 * A metric's band for one screen at one site, falling back to the reader's measured default. The
 * fallback is why a descriptor can be partial: an unmeasured override is "no opinion", never a guess.
 */
export function metricFor(
  site: SiteDescriptor | undefined,
  screen: ScreenId,
  name: string,
  fallback: MetricShape,
): MetricShape {
  return site?.screens[screen]?.metrics?.[name] ?? fallback;
}

/** The confidence floor a screen must clear at this site (the reader's own when the site is silent). */
export function floorFor(site: SiteDescriptor | undefined, screen: ScreenId, fallback: number): number {
  return site?.screens[screen]?.floor ?? fallback;
}

/** A site's floor by id, or undefined when the site does not know it. */
export function floorOf(site: SiteDescriptor, id: string): SiteFloor | undefined {
  return site.floors.find((floor) => floor.id === id);
}

/** Is a 32-hex title key well-formed? A malformed key matches no floor (map.ts's tolerance gate). */
export function isTitleKey(key: string): boolean {
  return /^[0-9a-f]{32}$/i.test(key);
}

/** Why a descriptor is not usable, or null. Used by the tests that hold a committed site honest. */
export function siteProblem(site: SiteDescriptor): string | null {
  if (site.id.trim() === '') return 'no id';
  if (site.floors.length === 0) return 'no floors';
  for (const floor of site.floors) {
    if (!isTitleKey(floor.titleKey)) return 'floor ' + floor.id + ' has a malformed title key';
    if (floor.label.trim() === '') return 'floor ' + floor.id + ' has no label';
  }
  for (const [screen, policy] of Object.entries(site.screens)) {
    if (policy === undefined) continue;
    if (!(policy.floor > 0) || policy.floor > 1) return screen + ' has a floor outside 0…1';
    for (const [name, shape] of Object.entries(policy.metrics ?? {})) {
      if (!(shape.soft > 0)) return screen + '/' + name + ' has a non-positive soft margin';
      if (shape.kind === 'range' && !(shape.good[1] > shape.good[0])) return screen + '/' + name + ' has an inverted band';
    }
  }
  return null;
}
