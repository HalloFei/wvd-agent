import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { LOCATIONS, TRAVEL_IDS } from '../src/perception/locations.ts';
import { findTemplate } from '../src/perception/match.ts';

async function jpegImage(relative: string): Promise<RgbaImage> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

const template = (id: string) => LOCATIONS.get(id)!.template;

describe('location templates against the engineered frames', () => {
  it('matches the world-map icon when the panel is down', async () => {
    const image = await jpegImage('testdata/frames/town-panel-down.jpg');
    expect(findTemplate(image, { x: 950, y: 940, width: 400, height: 140 }, template('world-map-icon'))?.score)
      .toBeGreaterThan(0.9);
  });

  it('refuses the world-map icon when the party panel covers it', async () => {
    const image = await jpegImage('testdata/frames/town-0.jpg');
    expect(findTemplate(image, { x: 950, y: 900, width: 500, height: 180 }, template('world-map-icon')))
      .toBeNull();
  });

  it('matches the panel chevron with the panel up', async () => {
    const image = await jpegImage('testdata/frames/town-0.jpg');
    const match = findTemplate(image, { x: 520, y: 720, width: 500, height: 200 }, template('panel-chevron'));
    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThan(0.9);
    expect(Math.abs(match!.at.x - 668)).toBeLessThanOrEqual(6);
    expect(Math.abs(match!.at.y - 774)).toBeLessThanOrEqual(6);
  });

  it('matches 诺森霍洛村 and 北穿幽冥城 on the world map', async () => {
    const image = await jpegImage('testdata/worldmap/2026-10-24/14.jpg');
    const vnh = findTemplate(image, { x: 760, y: 340, width: 390, height: 260 }, template('vnh'));
    expect(vnh).not.toBeNull();
    expect(vnh!.score).toBeGreaterThan(0.9);
    expect(Math.abs(vnh!.at.x - 919)).toBeLessThanOrEqual(6);
    expect(Math.abs(vnh!.at.y - 415)).toBeLessThanOrEqual(6);

    const gcn = findTemplate(image, { x: 960, y: 300, width: 240, height: 200 }, template('ffxi-gcn'));
    expect(gcn).not.toBeNull();
    expect(gcn!.score).toBeGreaterThan(0.9);
    expect(Math.abs(gcn!.at.x - 1019)).toBeLessThanOrEqual(6);
    expect(Math.abs(gcn!.at.y - 353)).toBeLessThanOrEqual(6);
  });

  it('refuses 北穿幽冥城 when the map edge clips it', async () => {
    const image = await jpegImage('testdata/worldmap/2026-10-24/07.jpg');
    expect(findTemplate(image, { x: 860, y: 0, width: 260, height: 180 }, template('ffxi-gcn')))
      .toBeNull();
  });

  it('does not confuse the two FFXI nodes', async () => {
    const image = await jpegImage('testdata/worldmap/2026-10-24/14.jpg');
    // The boxes are disjoint: 诺森霍洛村 at (919,415), 北穿幽冥城 at (1019,353).
    const vnhBox = { x: 860, y: 400, width: 150, height: 200 };
    const gcnBox = { x: 960, y: 300, width: 240, height: 200 };
    expect(findTemplate(image, vnhBox, template('vnh'))).not.toBeNull();
    expect(findTemplate(image, vnhBox, template('ffxi-gcn'))).toBeNull();
    expect(findTemplate(image, gcnBox, template('vnh'))).toBeNull();
  });

  it('travels only to destinations, never to a control', () => {
    expect(TRAVEL_IDS.has('vnh')).toBe(true);
    expect(TRAVEL_IDS.has('ffxi-gcn')).toBe(true);
    expect(TRAVEL_IDS.has('world-map-icon')).toBe(false);
    expect(TRAVEL_IDS.has('panel-chevron')).toBe(false);
  });
});
