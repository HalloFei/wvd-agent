/**
 * A site's own art, captured per zoom level — the legacy navigator's idea, and the end of the scale sweep.
 *
 * Legacy matches each node against a **template captured at the zoom it will be used at** (one scale, one
 * threshold), which is why it never has the problem this project spent a night on: every catalogue
 * template has its own native size, so one ladder cannot serve them (measured 2026-11-09: vnh ~0.47,
 * ffxi-gcn 0.90 on the same frame).
 *
 * So a site's art is **data**: `testdata/worldmap-nodes/<id>/level-<n>.json` holds the icon's grey
 * rectangle exactly as the game drew it, and the finder matches it at scale 1.0. When no capture exists
 * for a level, the caller falls back to the wide scale bank — a new site works before it is captured, and
 * gets faster and more certain once it is.
 *
 * `scripts/capture-site-art.ts` writes these: it finds a site with the wide bank, crops the icon it
 * matched, and files it with its level.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MatchTemplate } from './match.ts';

/** Where the captured art lives, relative to the package root. */
export const SITE_ART_ROOT = 'testdata/worldmap-nodes';

export interface CapturedArt {
  readonly id: string;
  readonly level: 1 | 2;
  readonly template: MatchTemplate;
  /** The score the capture matched at, and when it was taken (a capture is evidence, so it says). */
  readonly score: number;
  readonly at: string;
}

/** One captured art file's shape, on disk. */
interface FileShape {
  readonly id: string;
  readonly level: 1 | 2;
  readonly width: number;
  readonly height: number;
  /** The grey rectangle, base64 of one byte per pixel. */
  readonly gray: string;
  readonly score: number;
  readonly at: string;
}

const cache = new Map<string, CapturedArt>();

const key = (id: string, level: number): string => id + '@' + level;

/**
 * The captured art for a site at a level, or null when none was captured.
 *
 * A missing directory, a missing file or a malformed one is **null, never a throw**: a capture is an
 * optimisation, and the wide bank is the fallback that makes it optional.
 */
export function capturedArt(id: string, level: number, root = SITE_ART_ROOT): CapturedArt | null {
  const cached = cache.get(key(id, level));
  if (cached !== undefined) return cached;
  try {
    const file = join(root, id, 'level-' + level + '.json');
    statSync(file);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FileShape;
    const art: CapturedArt = {
      id: parsed.id,
      level: parsed.level,
      template: {
        width: parsed.width,
        height: parsed.height,
        gray: new Uint8Array(Buffer.from(parsed.gray, 'base64')),
      },
      score: parsed.score,
      at: parsed.at,
    };
    if (art.template.gray.length !== art.template.width * art.template.height) return null;
    cache.set(key(id, level), art);
    return art;
  } catch {
    return null;
  }
}

/** Every site that has art captured for one level, for a whole-catalogue scan. */
export function capturedSites(level: number, root = SITE_ART_ROOT): string[] {
  try {
    return readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name, 'level-' + level + '.json')).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** The file's contents for a capture, so the writer and the reader share one shape. */
export function encodeArt(art: CapturedArt): string {
  const shape: FileShape = {
    id: art.id,
    level: art.level,
    width: art.template.width,
    height: art.template.height,
    gray: Buffer.from(art.template.gray).toString('base64'),
    score: art.score,
    at: art.at,
  };
  return JSON.stringify(shape, null, 1) + '\n';
}

/** Drop the cache: a capture taken in this process must be visible to the next read. */
export function clearArtCache(): void {
  cache.clear();
}
