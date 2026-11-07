import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { openWorldMap, travelTo, zoomWorldMap, type WorldMapEnv } from '../src/actions/worldmap.ts';

async function frame(relative: string): Promise<Frame> {
  const bytes = await readFile(new URL('../' + relative, import.meta.url));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

interface Fixtures {
  readonly townUp: Frame;
  readonly townLive: Frame;
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
    townLive: await frame('testdata/screens/2026-11-07-town-live/town-1920.jpg'),
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
  foundOnZoomIn = false;
  foundOnDrag = false;
  tapResult: ActionResult = { ok: true };
  holdResult: ActionResult = { ok: true };
  /** The first N icon/node taps are swallowed by the game, as a click during a fade is. */
  dropTownIconTaps = 0;
  dropNodeTaps = 0;
  dragResult: ActionResult = { ok: true };
  readonly fixtures: Fixtures;
  readonly abort: AbortSignal | undefined;

  /** The frame the panel-up town is drawn on: the 2026-10-25 recording, or the live 2026-11-07 one. */
  townUpFrame: Frame;

  constructor(fixtures: Fixtures, options: { abort?: AbortSignal; start?: 'town-up' | 'town-down' | 'town-live' | 'map' | 'dungeon' | 'combat' } = {}) {
    this.fixtures = fixtures;
    this.abort = options.abort;
    this.townUpFrame = options.start === 'town-live' ? fixtures.townLive : fixtures.townUp;
    this.mapFrame = fixtures.mapNoVnh;
    if (options.start === 'town-down') this.panel = 'down';
    if (options.start === 'map') { this.mapOpen = true; this.panel = 'down'; }
    if (options.start === 'dungeon' || options.start === 'combat') this.forced = fixtures[options.start];
  }

  forced: Frame | null = null;
  screenOf = (frame: Frame): Observation => {
    // The guard measures stability on the observation's own clock; a frozen atMs would never hold.
    if (frame === this.townUpFrame || frame === this.fixtures.townDown) return { screen: 'town', atMs: this.clock, confidence: 0.9 };
    if (frame === this.fixtures.dungeon) return { screen: 'dungeon', atMs: this.clock, confidence: 0.9 };
    if (frame === this.fixtures.combat) return { screen: 'unknown', atMs: this.clock, confidence: 0.2 };
    return { screen: 'worldmap', atMs: this.clock, confidence: 0.9 };
  };
  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => { this.clock += ms; };
  captureFailures = 0;
  capture = async (): Promise<Frame> => {
    if (this.captureFailures > 0) {
      this.captureFailures -= 1;
      throw new Error('capture timeout: stale-frame');
    }
    if (this.forced !== null) return this.forced;
    if (this.left) return this.fixtures.townDown;
    if (this.mapOpen) return this.mapFrame;
    return this.panel === 'up' ? this.townUpFrame : this.fixtures.townDown;
  };
  observe = async (frame: Frame): Promise<Observation> => this.screenOf(frame);
  actuator: Actuator = {
    tap: async (at) => {
      this.taps.push(at);
      if (!this.tapResult.ok) return this.tapResult;
      if (!this.mapOpen) {
        if (this.panel === 'up') {
          this.panel = 'down';
        } else if (this.dropTownIconTaps > 0) {
          this.dropTownIconTaps -= 1;
        } else {
          this.mapOpen = true;
        }
      } else if (this.dropNodeTaps > 0) {
        this.dropNodeTaps -= 1;
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
        if (scan === 0x10) {
          this.zoom += 1;
          if (this.foundOnZoom !== null && this.zoom >= this.foundOnZoom) this.mapFrame = this.fixtures.mapVnh;
        } else if (scan === 0x12 && this.foundOnZoomIn) {
          this.mapFrame = this.fixtures.mapVnh;
        }
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
    expect(near(session.taps[1]!, { x: 1185, y: 1023 })).toBe(true);
  });

  it('collapses the panel on the live client chevron, then taps the icon it reveals', async () => {
    // Live camera 2026-11-07: the client redrew the chevron tile; the legacy mobile-art template
    // scores 0.600 here, below the 0.8 floor, so the entry could not collapse the panel at all.
    // The live sample (`src/perception/town-template.ts`) is the 34x26 tile at (679,789) — a press
    // must land on its centre (696,802), not the operator screenshot point (1577,669).
    const session = new Session(await fixtures(), { start: 'town-live' });
    expect(await openWorldMap(session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(2);
    expect(near(session.taps[0]!, { x: 696, y: 802 }, 4)).toBe(true);
    expect(near(session.taps[1]!, { x: 1185, y: 1023 })).toBe(true);
  });

  it('still finds the chevron on the older cameras', async () => {
    // The same live sample reads the six recorded town frames at 0.943-0.956, so it must find the
    // chevron on the five that draw one (town-panel-down.jpg draws the icon instead: the panel is down).
    for (const rel of [
      'testdata/frames/town-0.jpg',
      'testdata/frames/town-1.jpg',
      'testdata/frames/town-2.jpg',
      'testdata/frames/town-3.jpg',
      'testdata/frames/town-4.jpg',
    ]) {
      const session = new Session(await fixtures());
      session.townUpFrame = await frame(rel);
      expect(await openWorldMap(session)).toEqual({ ok: true });
      expect(session.taps).toHaveLength(2);
      expect(near(session.taps[0]!, { x: 696, y: 802 }, 6)).toBe(true);
    }
  });

  it('taps the icon directly when the panel is already down', async () => {
    const session = new Session(await fixtures(), { start: 'town-down' });
    expect(await openWorldMap(session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(1);
    expect(near(session.taps[0]!, { x: 1185, y: 1023 })).toBe(true);
  });


  it('retries the town icon once when the first click is swallowed', async () => {
    const session = new Session(await fixtures(), { start: 'town-down' });
    session.dropTownIconTaps = 1;
    expect(await openWorldMap(session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(2);
    expect(near(session.taps[0]!, { x: 1185, y: 1023 })).toBe(true);
    expect(near(session.taps[1]!, { x: 1185, y: 1023 })).toBe(true);
  });

  it('retries a map node once when the first tap is swallowed', async () => {
    const fixturesNow = await fixtures();
    const session = new Session(fixturesNow, { start: 'map' });
    session.mapFrame = fixturesNow.mapVnh;
    session.dropNodeTaps = 1;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(2);
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
    expect(session.keys).toEqual([0x10, 0x10, 0x10, 0x12, 0x12]);
    // The Dungeon Select map opens far from 诺森霍洛村; the pan is the 44-step serpentine.
    expect(session.drags).toHaveLength(44);
  });

  it('zooms in after the drags when the neighbour was hiding the node', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.foundOnZoomIn = true;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.keys).toEqual([0x10, 0x10, 0x10, 0x12]);
    expect(session.drags).toHaveLength(44);
    expect(near(session.taps[0]!, { x: 960, y: 469 })).toBe(true);
  });

  it('matches a node by its label band when the map is zoomed out (Dungeon Select path)', async () => {
    // Live frame 2026-10-31, the world map opened from Dungeon Select after three Q zoom-outs: the
    // whole map is visible, 诺森霍洛村 is on it, but its icon is drawn at half size so the composite
    // template scores 0.639 and the node is invisible to it. The label band is screen-space art and
    // scores 0.856; the icon's clickable centre sits 40 px above the band's top.
    const zoomed = await frame('testdata/worldmap/2026-10-31/dungeon-select-zoomout.jpg');
    const session = new Session(await fixtures(), { start: 'map' });
    session.mapFrame = zoomed;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(1);
    expect(near(session.taps[0]!, { x: 609, y: 398 }, 12)).toBe(true);
    expect(session.keys).toEqual([]);
    expect(session.drags).toHaveLength(0);
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

  it('retries a stale capture and still travels', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.mapFrame = (await fixtures()).mapVnh;
    session.captureFailures = 1;
    expect(await travelTo('vnh', session)).toEqual({ ok: true });
    expect(session.taps).toHaveLength(1);
  });

  it('fails capture-unavailable after three stale captures, without tapping', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.captureFailures = 3;
    const result = await travelTo('vnh', session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('capture-unavailable');
    expect(session.taps).toEqual([]);
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

describe('zoomWorldMap', () => {
  it('presses Q to zoom out and E to zoom in, and settles after the press', async () => {
    const fixturesNow = await fixtures();
    const out = new Session(fixturesNow, { start: 'map' });
    const before = out.clock;
    expect(await zoomWorldMap('out', out)).toEqual({ ok: true });
    expect(out.keys).toEqual([0x10]);
    expect(out.clock).toBeGreaterThan(before);

    const inMap = new Session(fixturesNow, { start: 'map' });
    expect(await zoomWorldMap('in', inMap)).toEqual({ ok: true });
    expect(inMap.keys).toEqual([0x12]);
  });

  it('returns a refused press unchanged, without settling', async () => {
    const session = new Session(await fixtures(), { start: 'map' });
    session.holdResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };
    const before = session.clock;
    expect(await zoomWorldMap('out', session)).toEqual({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    expect(session.clock).toBe(before);
  });
});
