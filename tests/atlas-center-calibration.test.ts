import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLD_MAP_SITES, ZOOM_LADDER } from '../src/perception/worldmap-atlas.ts';

const dir = new URL('../testdata/worldmap/2026-11-10-atlas-center/', import.meta.url);
const calibration = JSON.parse(readFileSync(new URL('calibration.json', dir), 'utf8')) as {
  image: string;
  size: { width: number; height: number };
  factor: number;
  origin: { x: number; y: number };
  labels: Array<{ id: string; at: { x: number; y: number }; score: number }>;
  spreadPx: number;
};
const ATLAS = { width: 1360, height: 1496 };

describe('the centre atlas crop', () => {
  it('is the recorded asset, byte for byte', () => {
    const bytes = readFileSync(new URL('center.png', dir));
    expect(bytes.readUInt32BE(16)).toBe(calibration.size.width);
    expect(bytes.readUInt32BE(20)).toBe(calibration.size.height);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('f1a6db6204c2c993a3bc213292d82ad32ca96b47dcb1ec36d90a3790c6e316fa');
  });

  it('is a level-1 render of the map centre, and its transform reproduces every matched label', () => {
    // The four banners it shares with the stored atlas measure the zoom themselves (they are fixed
    // size screen art), and they agree with the measured ladder's level 1.
    expect(calibration.factor).toBeGreaterThan(ZOOM_LADDER[1]! * 0.95);
    expect(calibration.factor).toBeLessThan(ZOOM_LADDER[1]! * 1.05);
    expect(calibration.spreadPx).toBeLessThanOrEqual(15);
    const sites = new Map(WORLD_MAP_SITES.map((site) => [site.id, site]));
    for (const label of calibration.labels) {
      const site = sites.get(label.id)!;
      const projected = {
        x: calibration.factor * (site.x - calibration.origin.x),
        y: calibration.factor * (site.y - calibration.origin.y),
      };
      expect(Math.abs(projected.x - label.at.x)).toBeLessThanOrEqual(15);
      expect(Math.abs(projected.y - label.at.y)).toBeLessThanOrEqual(15);
    }
  });

  it('covers the centre, not the whole map — and is not a replacement for the stored atlas', () => {
    const covered = {
      width: calibration.size.width / calibration.factor,
      height: calibration.size.height / calibration.factor,
    };
    expect(covered.width).toBeLessThan(ATLAS.width * 0.6);
    expect(calibration.origin.x).toBeGreaterThan(0);
    expect(calibration.origin.x + covered.width).toBeLessThan(ATLAS.width);
    expect(calibration.origin.y + covered.height).toBeLessThan(ATLAS.height);
    // Pasted into the stored atlas it would cover 22% of it, and it is a different render: measured
    // 2026-11-10, a composite lowered every recorded frame (max-out 0.813 -> 0.575), so the atlas is
    // per-zoom and this crop is the first level-1 tile, not a patch for the max-out stitch.
    expect((covered.width * covered.height) / (ATLAS.width * ATLAS.height)).toBeLessThan(0.3);
  });
});
