import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { findTemplate, type MatchTemplate } from '../src/perception/match.ts';

/** A deterministic busy image: every 60×40 patch is unique enough to find again. */
function synthetic(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      // Low-frequency, the way UI art is: a box-averaged coarse pass must keep the peak.
      const value = Math.round(128 + 60 * Math.sin(x / 25) + 50 * Math.cos(y / 31) + 20 * Math.sin((x + y) / 17));
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height };
}

function crop(image: RgbaImage, x: number, y: number, width: number, height: number): MatchTemplate {
  const gray = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = ((y + row) * image.width + x + column) * 4;
      gray[row * width + column] = ((image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1000) | 0;
    }
  }
  return { width, height, gray };
}

async function jpegImage(relative: string): Promise<RgbaImage> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

describe('findTemplate', () => {
  it('finds a crop of its own image at the crop origin with score 1', () => {
    const image = synthetic(800, 600);
    const template = crop(image, 200, 150, 60, 40);
    const match = findTemplate(image, { x: 0, y: 0, width: 800, height: 600 }, template, { scales: [1] });
    expect(match).not.toBeNull();
    expect(match!.at).toEqual({ x: 200, y: 150 });
    expect(match!.score).toBeCloseTo(1, 5);
    expect(match!.width).toBe(60);
    expect(match!.height).toBe(40);
  });

  it('never matches a flat window, however large the correlation would look', () => {
    const image = synthetic(400, 300);
    const template = crop(image, 100, 80, 40, 30);
    // A black area: variance 0, so the normalized correlation is undefined and must be refused.
    const flat: RgbaImage = { data: new Uint8Array(200 * 120 * 4), width: 200, height: 120 };
    expect(findTemplate(flat, { x: 0, y: 0, width: 200, height: 120 }, template, { scales: [1] })).toBeNull();
  });

  it('finds the world-map icon on the panel-down town frame at the measured scale', async () => {
    const image = await jpegImage('testdata/frames/town-panel-down.jpg');
    const { LOCATIONS } = await import('../src/perception/locations.ts');
    const icon = LOCATIONS.get('world-map-icon')!.template;
    const match = findTemplate(image, { x: 950, y: 940, width: 400, height: 140 }, icon);
    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThan(0.9);
    expect(Math.abs(match!.at.x - 1169)).toBeLessThanOrEqual(6);
    expect(Math.abs(match!.at.y - 1005)).toBeLessThanOrEqual(6);
  });
});
