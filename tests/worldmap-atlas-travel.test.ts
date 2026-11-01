import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { travelTo, travelViaAtlas } from '../src/actions/worldmap.ts';
import { LOCATIONS } from '../src/perception/locations.ts';
import { LABEL_ANCHORS, MAP_STRIP, WORLD_MAP_SITES } from '../src/perception/worldmap-atlas.ts';

const STRIP = MAP_STRIP;

/** The band of the legacy art the game draws as a node's icon (locations.ts's 68.7% rule). */
function iconBand(locationId: string): { width: number; height: number; gray: Uint8Array } | null {
  const entry = LOCATIONS.get(locationId);
  if (entry === undefined) return null;
  const height = Math.round(entry.template.height * 0.687);
  return { width: entry.template.width, height, gray: entry.template.gray.subarray(0, height * entry.template.width) };
}

function project(at: Point, offset: Point, level: number): Point {
  const factor = Math.pow(1.34, level);
  const centre = { x: STRIP.width / 2, y: STRIP.height / 2 };
  return {
    x: Math.round(centre.x + factor * (at.x - offset.x - centre.x)),
    y: Math.round(centre.y + factor * (at.y - offset.y - centre.y)),
  };
}

function blit(image: RgbaImage, art: { width: number; height: number; gray: Uint8Array }, at: Point, scale: number): void {
  const width = Math.max(1, Math.round(art.width * scale));
  const height = Math.max(1, Math.round(art.height * scale));
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(art.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(art.width - 1, Math.floor(x / scale));
      const value = art.gray[sourceY * art.width + sourceX]!;
      const px = at.x + x;
      const py = at.y + y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const offset = (py * image.width + px) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
}

function blank(): RgbaImage {
  const data = new Uint8Array(1920 * 1080 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 92;
    data[offset + 1] = 88;
    data[offset + 2] = 80;
    data[offset + 3] = 255;
  }
  return { data, width: 1920, height: 1080 };
}

/**
 * A synthetic world map: the real label banners and node icons drawn at the place the atlas says,
 * for whatever offset and zoom level the session is in. Drags move the offset, keys change the
 * level, a tap on the target's icon leaves the map. That makes the action's geometry testable
 * without a game.
 */
class AtlasSession {
  offset: Point = { x: 100, y: 60 };
  level = 0;
  left = false;
  hideLabels = false;
  hideIcons = false;
  gain = 1;
  clock = 0;
  readonly taps: Point[] = [];
  readonly keys: number[] = [];
  readonly drags: Array<{ from: Point; to: Point }> = [];
  tapResult: ActionResult = { ok: true };

  readonly abort = undefined;

  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => { this.clock += ms; };
  capture = async (): Promise<Frame> => {
    const image = this.render();
    return { atMs: this.clock, width: image.width, height: image.height, toRgba: async () => image };
  };
  observe = async (frame: Frame): Promise<Observation> => {
    void frame;
    return { screen: this.left ? 'dungeon' : 'worldmap', atMs: this.clock, confidence: 0.9 } as Observation;
  };
  actuator: Actuator = {
    tap: async (at) => {
      this.taps.push(at);
      const icon = this.targetIconRect();
      if (icon !== null && at.x >= icon.x && at.x <= icon.x + icon.width && at.y >= icon.y && at.y <= icon.y + icon.height) {
        this.left = true;
      }
      return this.tapResult;
    },
    doubleTap: async () => this.tapResult,
    holdKey: async (scan) => {
      this.keys.push(scan);
      if (scan === 0x10) this.level = Math.max(0, this.level - 1);
      if (scan === 0x12) this.level = Math.min(3, this.level + 1);
      return { ok: true };
    },
    drag: async (from, to) => {
      this.drags.push({ from, to });
      this.offset = {
        x: Math.max(0, Math.min(400, Math.round(this.offset.x - (to.x - from.x) * this.gain))),
        y: Math.max(0, Math.min(416, Math.round(this.offset.y - (to.y - from.y) * this.gain))),
      };
      return { ok: true };
    },
  };

  private render(): RgbaImage {
    const image = blank();
    const factor = Math.pow(1.34, this.level);
    if (!this.hideLabels) {
      for (const anchor of LABEL_ANCHORS) {
        const at = project({ x: anchor.at.x, y: anchor.at.y }, this.offset, this.level);
        blit(image, { width: anchor.template.width, height: anchor.template.height, gray: anchor.template.gray }, { x: STRIP.x + at.x, y: at.y }, factor);
      }
    }
    if (!this.hideIcons) {
      for (const site of WORLD_MAP_SITES) {
        if (site.templateId === undefined) continue;
        const art = iconBand(site.templateId);
        if (art === null) continue;
        const at = project({ x: site.x, y: site.y }, this.offset, this.level);
        const scale = 0.45 * factor;
        blit(image, art, { x: Math.round(STRIP.x + at.x - (art.width * scale) / 2), y: Math.round(at.y - (art.height * scale) / 2) }, scale);
      }
    }
    return image;
  }

  /** The screen rectangle the destination's icon occupies right now, for the tap check. */
  private targetIconRect(): { x: number; y: number; width: number; height: number } | null {
    const site = WORLD_MAP_SITES.find((candidate) => candidate.id === 'ffxi-gcn');
    if (site === undefined || site.templateId === undefined) return null;
    const art = iconBand(site.templateId);
    if (art === null) return null;
    const at = project({ x: site.x, y: site.y }, this.offset, this.level);
    const scale = 0.45 * Math.pow(1.34, this.level);
    return {
      x: Math.round(STRIP.x + at.x - (art.width * scale) / 2),
      y: Math.round(at.y - (art.height * scale) / 2),
      width: Math.round(art.width * scale),
      height: Math.round(art.height * scale),
    };
  }
}

describe('travelViaAtlas', () => {
  it('locates the view from a banner, pans, zooms and taps the confirmed icon', async () => {
    const session = new AtlasSession();
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session, { trace: true });

    expect(result.ok).toBe(true);
    expect(result.trace?.located).toMatchObject({ by: 'anchor', offset: { x: 100, y: 60 } });
    expect(result.trace?.placed).toMatchObject({ offset: { x: 228, y: 0 }, level: 3 });
    expect(result.trace?.zooms).toBe(3);
    expect(result.trace?.confirmed?.by).toBe('icon');
    expect(session.left).toBe(true);
    expect(session.taps).toHaveLength(1);
  });

  it('locates a label-less view by the node icons, which the game draws at every zoom', async () => {
    const session = new AtlasSession();
    session.hideLabels = true;
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session, { trace: true });

    expect(result.ok).toBe(true);
    expect(result.trace?.located?.by).toBe('anchor');
    expect(session.left).toBe(true);
  });

  it('falls back to the north-west clamp when nothing legible is drawn', async () => {
    const session = new AtlasSession();
    session.hideLabels = true;
    session.hideIcons = true;
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session, { trace: true });

    expect(result.trace?.located).toMatchObject({ by: 'clamp', offset: { x: 0, y: 0 } });
    expect(session.drags.length).toBeGreaterThan(0);
    // the clamp places the view, but with no icon on screen the node cannot be confirmed
    expect(result).toMatchObject({ ok: false, reason: 'location-not-found' });
    expect(session.left).toBe(false);
  });

  it('refuses a node whose icon is not drawn, and taps nothing', async () => {
    const session = new AtlasSession();
    session.hideIcons = true;
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session);

    expect(result).toMatchObject({ ok: false, reason: 'location-not-found' });
    expect(session.taps).toHaveLength(0);
  });

  it('honours a zoom plan of none: no key is pressed and the node is taken at max zoom-out', async () => {
    const session = new AtlasSession();
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session, { zoom: 'none', trace: true });

    expect(result.ok).toBe(true);
    expect(result.trace?.zooms).toBe(0);
    expect(session.keys).not.toContain(0x12);
    expect(session.left).toBe(true);
  });

  it('reports an unknown site as a typed failure', async () => {
    const session = new AtlasSession();
    expect(await travelViaAtlas({ kind: 'site', id: 'not-a-site' }, session)).toMatchObject({ ok: false, reason: 'unknown-location' });
  });

  it('honours the anchor option: a pinned banner that is not drawn leaves the view unplaced', async () => {
    const session = new AtlasSession();
    session.hideLabels = true;
    session.hideIcons = true;
    const result = await travelViaAtlas({ kind: 'site', id: 'ffxi-gcn' }, session, {
      anchor: 'vnh',
      locate: 'anchor',
    });
    expect(result).toMatchObject({ ok: false, reason: 'location-not-found', detail: 'no atlas label was in view' });
  });

  it('is what travelTo reaches for a catalogued node with the atlas enabled', async () => {
    const session = new AtlasSession();
    const result = await travelTo('ffxi-gcn', { ...session, atlas: true } as never);
    expect(result.ok).toBe(true);
    expect(session.left).toBe(true);
  });
});
