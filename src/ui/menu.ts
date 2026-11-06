/**
 * The knowledge base's reader: which page this frame is, and the tap that leaves it.
 *
 * This is the half the catalog was missing. `src/ui/pages.ts` records the pages; this module matches
 * a frame against each page's title band (`src/ui/library.ts`, sampled from the committed stills) and
 * answers the page together with its measured exit - so the World can close a page it was never
 * written to expect, with the one command the graph already knows.
 *
 * Recognition is a title match, not OCR: the game draws the page's name at a fixed place, so the band
 * is the page's own evidence, and the measure is the same `sampleRegion` / `correlation` pair the inn's
 * rows use (one reading of a fixed UI, several pages). Measured 2026-11-06 on the eight stills: every
 * page answers its own still at 1.000, and the closest cross-match - 记录 against 选项, two centred
 * panels whose title bands overlap - is 0.540, so the floor has 0.26 of room on one side and 0.20 on
 * the other. A frame that is not one of these pages answers null, and the World falls back to its own
 * escalation exactly as before.
 *
 * The reader is deliberately not the recogniser of pages that already have one: the inn, the character
 * page, the dungeon map and the harken keep their own perceivers, because their evidence is stronger
 * than a title band and their policy is more than a close.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';
import { correlation, sampleRegion } from '../perception/reader.ts';
import { exitOf, pageById } from './graph.ts';
import { UI_TITLES } from './library.ts';
import { UI_CATALOG } from './pages.ts';

/**
 * The score a page's title must reach to be named. Measured 2026-11-06: self 1.000 for every page,
 * best cross-match 0.540 (记录 against 选项). 0.8 sits between them with a wide margin both ways.
 */
export const UI_TITLE_FLOOR = 0.8;

/** What the reader answers: the page, its title, the tap that leaves it, and how strongly it matched. */
export interface UiMenuMatch {
  readonly page: string;
  readonly title: string;
  readonly exit: Point;
  readonly score: number;
}

/**
 * The page this frame is, or null. The best title wins; a page whose catalog row has no exit is not
 * reported as closeable, because the World's one job here is to leave.
 */
export function findUiMenu(image: RgbaImage): UiMenuMatch | null {
  let best: { page: string; score: number } | null = null;
  for (const title of UI_TITLES) {
    const sample = sampleRegion(image, title.region, title.width, title.height);
    const score = correlation(sample, title);
    if (best === null || score > best.score) best = { page: title.page, score };
  }
  if (best === null || best.score < UI_TITLE_FLOOR) return null;
  const page = pageById(UI_CATALOG, best.page);
  if (page === null) return null;
  const exit = exitOf(page);
  if (exit === null) return null;
  return { page: page.id, title: page.title, exit: exit.at, score: best.score };
}

/** Names a knowledge-base page on the frame, and carries the catalog's exit for it. */
export class UiMenuPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    const match = findUiMenu(image);
    if (match === null) return unknown;
    return {
      screen: 'ui-menu',
      atMs: frame.atMs,
      confidence: match.score,
      page: match.page,
      title: match.title,
      exit: match.exit,
    };
  }
}
