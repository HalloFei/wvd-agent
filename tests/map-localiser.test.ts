import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { createAtlas, localiseView, worldMapAtlas } from '../src/perception/map-localiser.ts';
import { LABEL_ANCHORS, MAP_STRIP, WORLD_MAP_SITES, ZOOM_LADDER, zoomFactor } from '../src/perception/worldmap-atlas.ts';
import { findTemplate } from '../src/perception/match.ts';

const dir = new URL('../testdata/worldmap/2026-11-01/', import.meta.url);

function frame(name: string) {
  return jpeg.decode(readFileSync(new URL(name, dir)), { useTArray: true, formatAsRGBA: true });
}

/** The atlas as one luma image, at full resolution (1 atlas px per px). */
function fullAtlas(): { gray: Uint8Array; width: number; height: number } {
  const image = frame('overview-full.jpg');
  const gray = new Uint8Array(image.width * image.height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = Math.round((image.data[index * 4]! * 299 + image.data[index * 4 + 1]! * 587 + image.data[index * 4 + 2]! * 114) / 1000);
  }
  return { gray, width: image.width, height: image.height };
}

/**
 * A synthetic live frame: the atlas seen at zoom `factor` with the strip's top-left on `origin`,
 * i.e. `screen = factor * (atlas - origin)`, which is the model the localiser solves for.
 */
function synthesise(atlas: { gray: Uint8Array; width: number; height: number }, origin: { x: number; y: number }, factor: number) {
  const width = 1920;
  const height = 1080;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = x - MAP_STRIP.x;
      let value = 0;
      if (s >= 0 && s < MAP_STRIP.width) {
        const ax = Math.round(origin.x + s / factor);
        const ay = Math.round(origin.y + y / factor);
        if (ax >= 0 && ay >= 0 && ax < atlas.width && ay < atlas.height) value = atlas.gray[ay * atlas.width + ax]!;
      }
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

describe('localiseView', () => {
  it('recovers the pose of a view built from the atlas, at every measured zoom level', () => {
    const source = fullAtlas();
    const atlas = createAtlas({
      atlasWidth: source.width,
      atlasHeight: source.height,
      pixelsPerCell: 1,
      width: source.width,
      height: source.height,
      gray: source.gray,
    });
    for (const level of [0, 1, 2, 3]) {
      const origin = { x: 120, y: 90 };
      const pose = localiseView(synthesise(source, origin, zoomFactor(level)), atlas, { levels: [level], minScore: -1 });
      expect(pose).not.toBeNull();
      expect(pose!.level).toBe(level);
      expect(pose!.origin.x).toBeCloseTo(origin.x, 0);
      expect(pose!.origin.y).toBeCloseTo(origin.y, 0);
      expect(pose!.score).toBeGreaterThan(0.95);
    }
  }, 120_000);

  it('reads the recorded max-zoom-out frame at level 0, offset 0,0', () => {
    const pose = localiseView(frame('max-out.jpg'), worldMapAtlas(), {});
    expect(pose).not.toBeNull();
    expect(pose!.level).toBe(0);
    expect(pose!.origin).toEqual({ x: 0, y: 0 });
    // The stitched atlas is one JPEG generation behind a live frame: 0.81 is its ceiling here.
    expect(pose!.score).toBeGreaterThan(0.75);
  });

  it('reads a zoomed frame at the level its art was drawn at', () => {
    const two = localiseView(frame('level-in-2.jpg'), worldMapAtlas(), {});
    expect(two).not.toBeNull();
    expect(two!.level).toBe(2);
    expect(Math.abs(two!.origin.x - 26)).toBeLessThanOrEqual(12);
    expect(Math.abs(two!.origin.y - 58)).toBeLessThanOrEqual(12);
    expect(two!.score).toBeGreaterThan(0.7);
    const three = localiseView(frame('max-in.jpg'), worldMapAtlas(), {});
    expect(three).not.toBeNull();
    expect(three!.level).toBe(3);
    expect(Math.abs(three!.origin.x - 32)).toBeLessThanOrEqual(12);
    expect(Math.abs(three!.origin.y - 54)).toBeLessThanOrEqual(12);
    expect(three!.score).toBeGreaterThan(0.7);
  });

  it('agrees with the banner locator on a zoomed frame', () => {
    // The banners are fixed-size screen art, so the pose from two of them is independent evidence:
    // screen = factor * (atlas - origin) gives origin = atlas - screen / factor.
    const image = frame('level-in-1.jpg');
    // Floor 0: this frame is the atlas's weak case (0.49) and the test is about the geometry.
    const pose = localiseView(image, worldMapAtlas(), { minScore: 0 });
    expect(pose).not.toBeNull();
    const votes: Array<{ x: number; y: number }> = [];
    for (const anchor of LABEL_ANCHORS) {
      const match = findTemplate(image, MAP_STRIP, anchor.template, { scales: [1], minScore: 0.9 });
      const site = WORLD_MAP_SITES.find((candidate) => candidate.id === anchor.id);
      if (match === null || site === undefined) continue;
      votes.push({
        x: site.x - (match.at.x - MAP_STRIP.x) / pose!.factor,
        y: site.y - match.at.y / pose!.factor,
      });
    }
    expect(votes.length).toBeGreaterThanOrEqual(2);
    const mean = { x: votes.reduce((sum, vote) => sum + vote.x, 0) / votes.length, y: votes.reduce((sum, vote) => sum + vote.y, 0) / votes.length };
    // 60 px, not 10: this frame is the atlas's weak case (score 0.49-0.54), and the registration
    // aligns the whole painting while two banners are point evidence — the pan loop absorbs the
    // difference (it converges to 40 atlas px and the confirmation window is 180 px).
    expect(Math.abs(pose!.origin.x - mean.x)).toBeLessThanOrEqual(60);
    expect(Math.abs(pose!.origin.y - mean.y)).toBeLessThanOrEqual(60);
  });
});

describe('the measured ladder', () => {
  it('is the one the frames were measured with', () => {
    expect(ZOOM_LADDER).toEqual([1, 1.52, 1.96, 2.4]);
    expect(zoomFactor(2)).toBe(1.96);
    expect(zoomFactor(9)).toBe(2.4);
    expect(zoomFactor(-1)).toBe(1);
  });
});
