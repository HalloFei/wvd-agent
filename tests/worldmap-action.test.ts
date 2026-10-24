import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { openWorldMap, travelTo, type WorldMapEnv } from '../src/actions/worldmap.ts';

async function frame(relative: string): Promise<Frame> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

interface Fixtures {
  readonly townUp: Frame;
  readonly townDown: Frame;
  readonly mapVnh: Frame;
  readonly mapNoVnh: Frame;
  readonly mapClipped: Frame;
  readonly dungeon: Frame;
  readonly combat: Frame;
}

let loaded: Promise<Fixtures> | null = null;
function fixtures(): Promise<Fixtures> {
  loaded ??= (async () => ({
    townUp: await frame('testdata/frames/town-0.jpg'),
    townDown: await frame('testdata/frames/town-panel-down.jpg'),
    mapVnh: await frame('testdata/worldmap/2026-10-24/14.jpg'),
    mapNoVnh: await frame('testdata/worldmap/2026-10-24/20.jpg'),
    mapClipped: await frame('testdata/worldmap/2026-10-24/07.jpg'),
    dungeon: await frame('testdata/nav-2026-10-24-ffxi4f/third-floor.jpg'),
    combat: await frame('testdata/screens/2026-10-24-ffxi/combat.jpg'),
  }))();
  return loaded;
}

/** A scripted game: the panel collapses on a town tap, the map opens on the next, a node tap leaves. */
class Session implements WorldMapEnv {
  readonly taps: Point[] = [];
  readonly keys: number[] = [];
  readonly drags: Array<{ from: Point; to: Point; ms: number }> = [];
  clock = 0;
  panel: 'up' | 'down' = 'up';
  mapOpen = false;
  left = false;
  zoom = 0;
  dragCount = 0;
  mapFrame: Frame;
  foundOnZoom: number | null = null;
  foundOnDrag = false;
  tapResult: ActionResult = { ok: true };
  holdResult: ActionResult = { ok: true };
  dragResult: ActionResult = { ok: true };
  readonly fixtures: Fixtures;
  readonly abort: AbortSignal | undefined;

  constructor(fixtures: Fixtures, options: { abort?: AbortSignal; start?: 'town-up' | 'town-down' | 'map' | 'dungeon' | 'combat' } = {}) {
    this.fixtures = fixtures;
    this.abort = options.abort;
    this.mapFrame = fixtures.mapNoVnh;
    if (options.start === 'town-down') this.panel = 'down';
    if (options.start === 'map') { this.mapOpen = true; this.panel = 'down'; }
    if (options.start === 'dungeon' || options.start === 'combat') this.forced = fixtures[options.start];
  }

  forced: Frame | null = null;
  screenOf = (frame: Frame): Observation => {
    if (frame === this.fixtures.townUp || frame === this.fixtures.townDown) return { screen: 'town', atMs: 0, confidence: 0.9 };
    if (frame === this.fixtures.dungeon) return { screen: 'dungeon', atMs: 0, confidence: 0.9 };
    if (frame === this.fixtures.combat) return { screen: 'unknown', atMs: 0, confidence: 0.2 };
    return { screen: 'worldmap', atMs: 0, confidence: 0.9 };
  };
  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => { this.clock += ms; };
  capture = async (): Promise<Frame> => {
    if (this.forced !== null) return this.forced;
    if (this.left) return this.fixtures.townDown;
    if (this.mapOpen) return this.mapFrame;
    return this.panel === 'up' ? this.fixtures.townUp : this.fixtures.townDown;
  };
  observe = async (frame: Frame): Promise<Observation> => this.screenOf(frame);
  actuator: Actuator = {
    tap: async (at) => {
      this.taps.push(at);
      if (!this.tapResult.ok) return this.tapResult;
      if (!this.mapOpen) {
        if (this.panel === 'up') this.panel = 'down';
        else this.mapOpen = true;
      } else {
        this.left = true;
      }
      return { ok: true };
    },
    doubleTap: async () => this.tapResult,
    holdKey: async (scan, ms) => {
      if (!this.holdResult.ok) return this.holdResult;
      this.keys.push(scan);
      if (this.mapOpen) {
        this.zoom += 1;
        if (this.foundOnZoom !== null && this.zoom >= this.foundOnZoom) this.mapFrame = this.fixtures.mapVnh;
      }
      return { ok: true };
    },
    drag: async (from, to, ms) => {
      if (!this.dragResult.ok) return this.dragResult;
      this.drags.push({ from, to, ms });
      this.dragCount += 1;
      if (this.foundOnDrag) this.mapFrame = this.fixtures.mapVnh;
      return { ok: true };
    },
  };
}

const near = (actual: Point, expected: Point, tolerance = 8): boolean =>
  Math.abs(actual.x - expected.x) <= tolerance && Math.abs(actual.y - expected.y) <= tolerance;

describe('openWorldMap', () => {
  it('collapses the panel with the chevron, then taps the icon it reveals', async () => {
    const session = new Session(await fixtures());
    expect(await openWorldMap(session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(2);
    expect(near(session.taps[0]!, { x: 697, y: 799 })).toBe(true);
    expect(near(session.taps[1]!, { x: 1194, y: 1024 })).toBe(true);
  });

  it('taps the icon directly when the panel is already down', async () => {
    const session = new Session(await fixtures(), { start: 'town-down' });
    expect(await openWorldMap(session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(1);
    expect(near(session.taps[0]!, { x: 1194, y: 1024 })).toBe(true);
  });

  it('refuses a screen with neither control, without tapping', async () => {
    const session = new Session(await fixtures(), { start: 'combat' });
    const result = await openWorldMap(session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('world-map-control-not-found');
    expect(session.taps).toEqual([]);
  });
});

describe('travelTo', () => {
  it('taps the node it matched and waits for the map to close', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.mapFrame = (await fixtures()).mapVnh;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(1);
    expect(near(session.taps[0]!, { x: 960, y: 469 })).toBe(true);
  });

  it('zooms out before tapping when the node is off-view', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.foundOnZoom = 2;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.keys).toEqual([0x10, 0x10]);
    expect(session.drags).toHaveLength(0);
    expect(near(session.taps[0]!, { x: 960, y: 469 })).toBe(true);
  });

  it('drags the map when three zoom-outs do not reveal the node', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.foundOnDrag = true;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.keys).toEqual([0x10, 0x10, 0x10]);
    expect(session.drags).toHaveLength(1);
    expect(near(session.taps[0]!, { x: 960, y: 469 })).toBe(true);
  });

  it('gives up after the zoom and drag budget without tapping', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    const result = await travelTo('vnh', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('location-not-found');
    expect(session.taps).toEqual([]);
    expect(session.keys).toHaveLength(3);
    expect(session.drags).toHaveLength(8);
  });

  it('refuses a clipped node (score below 0.8) rather than clicking it', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.mapFrame = (await fixtures()).mapClipped;
    const result = await travelTo('ffxi-gcn', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('location-not-found');
    expect(session.taps).toEqual([]);
  });

  it('stops on a rejected drag and does not tap', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.dragResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };
    const result = await travelTo('vnh', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('rejected');
    expect(session.taps).toEqual([]);
  });

  it('refuses an id that is not a destination', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    const result = await travelTo('world-map-icon', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-location');
    expect(session.taps).toEqual([]);
  });

  it('does nothing when the party is already in the dungeon', async () => {
    const session = new Session(await fixtures(), { start: 'dungeon' });
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.taps).toEqual([]);
    expect(session.keys).toEqual([]);
  });

  it('cancels before the first capture on an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = new Session(await fixtures(), { start: 'town-up', abort: controller.signal });
    const result = await travelTo('vnh', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cancelled');
    expect(session.taps).toEqual([]);
  });
});
