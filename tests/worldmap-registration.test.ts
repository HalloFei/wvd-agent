import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { travelViaAtlas } from '../src/actions/worldmap.ts';
import { createAtlas, worldMapAtlas } from '../src/perception/map-localiser.ts';
import { MAP_STRIP, WORLD_MAP_SITES, ZOOM_LADDER } from '../src/perception/worldmap-atlas.ts';

const VNH = WORLD_MAP_SITES.find((site) => site.id === 'vnh')!;
const AIM = { x: MAP_STRIP.x + (MAP_STRIP.width - 24) / 2, y: 30 + 870 / 2 };
/** Q is 缩小, E is 放大 — the codes worldmap.ts presses. */
const ZOOM_OUT = 0x10;
const ZOOM_IN = 0x12;

/** The committed atlas at a quarter of its stored resolution: same map, four times cheaper. */
function quarterAtlas() {
  const full = worldMapAtlas();
  const source = full.layers[full.layers.length - 1]!.data;
  const width = Math.floor(full.storedWidth / 2);
  const height = Math.floor(full.storedHeight / 2);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (row: number, column: number): number => source[row * full.storedWidth + column]!;
      gray[y * width + x] = Math.round((at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4);
    }
  }
  return createAtlas({ atlasWidth: full.atlasWidth, atlasHeight: full.atlasHeight, pixelsPerCell: 4, width, height, gray });
}

/**
 * A world-map session that actually behaves: the frame is the atlas at the current level and
 * origin, a zoom key changes the level, a drag moves the content 1:1, and a tap near the node leaves
 * the map. Static frames cannot test the zoom-out verification — that is the point of it.
 */
class MapSession {
  level = 1;
  origin: Point = { x: 200, y: 120 };
  left = false;
  clock = 0;
  taps: Point[] = [];
  drags: Array<{ from: Point; to: Point }> = [];
  keys: number[] = [];
  readonly abort = undefined;
  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => { this.clock += ms; };
  private readonly storage: ReturnType<typeof quarterAtlas>;
  private readonly cells: { width: number; height: number; data: Float64Array };

  constructor(storage: ReturnType<typeof quarterAtlas>, level: number, origin: Point) {
    this.storage = storage;
    this.level = level;
    this.origin = origin;
    this.cells = storage.layers[storage.layers.length - 1]!;
  }

  /** The node's screen point (absolute), for the tap check. */
  get nodeScreen(): Point {
    const factor = ZOOM_LADDER[this.level]!;
    return {
      x: MAP_STRIP.x + factor * (VNH.x - this.origin.x),
      y: factor * (VNH.y - this.origin.y),
    };
  }

  render(): RgbaImage {
    const factor = ZOOM_LADDER[this.level]!;
    const width = 1920;
    const height = 1080;
    const data = new Uint8Array(width * height * 4);
    const ppc = this.storage.pixelsPerCell;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const s = x - MAP_STRIP.x;
        let value = 0;
        if (s >= 0 && s < MAP_STRIP.width) {
          const ax = Math.round((this.origin.x + s / factor) / ppc);
          const ay = Math.round((this.origin.y + y / factor) / ppc);
          if (ax >= 0 && ay >= 0 && ax < this.cells.width && ay < this.cells.height) value = this.cells.data[ay * this.cells.width + ax]!;
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

  capture = async (): Promise<Frame> => {
    const image = this.render();
    return { atMs: this.clock, width: image.width, height: image.height, toRgba: async () => image };
  };

  observe = async (): Promise<Observation> => ({
    screen: this.left ? 'dungeon' : 'worldmap', atMs: this.clock, confidence: 0.9,
  } as Observation);

  actuator = {
    tap: async (at: Point): Promise<ActionResult> => {
      this.taps.push(at);
      const node = this.nodeScreen;
      if (Math.abs(at.x - node.x) <= 80 && Math.abs(at.y - node.y) <= 80) this.left = true;
      return { ok: true };
    },
    drag: async (from: Point, to: Point): Promise<ActionResult> => {
      this.drags.push({ from, to });
      const factor = ZOOM_LADDER[this.level]!;
      this.origin = {
        x: this.origin.x - (to.x - from.x) / factor,
        y: this.origin.y - (to.y - from.y) / factor,
      };
      return { ok: true };
    },
    holdKey: async (scan: number): Promise<ActionResult> => {
      this.keys.push(scan);
      if (scan === ZOOM_OUT) this.level = Math.max(0, this.level - 1);
      if (scan === ZOOM_IN) this.level = Math.min(3, this.level + 1);
      return { ok: true };
    },
    moveTo: async (): Promise<ActionResult> => ({ ok: true }),
    scroll: async (): Promise<ActionResult> => ({ ok: true }),
  } as unknown as Actuator;
}

describe('travelViaAtlas with locate registration', () => {
  it('zooms out before it pans, then taps the node at the level it zoomed in to', async () => {
    const atlas = quarterAtlas();
    // The live state that failed on 2026-11-09: the map was left at level 1, the node off the aim.
    const session = new MapSession(atlas, 1, { x: 260, y: 90 });
    const logs: string[] = [];
    const env = {
      actuator: session.actuator,
      capture: () => session.capture(),
      observe: () => session.observe(),
      sleep: session.sleep,
      log: (line: string) => { logs.push(line); },
      now: session.now,
    };
    const result = await travelViaAtlas({ kind: 'site', id: 'vnh' }, env as never, {
      locate: 'registration', trace: true, localiserAtlas: atlas,
    });
    expect(result.ok).toBe(true);
    expect(logs.some((line) => line.includes('registration located the view'))).toBe(true);
    expect(logs.some((line) => line.includes('before the tap'))).toBe(true);
    // The zoom-out press comes first and is verified; the drags happen only at max zoom-out.
    expect(session.keys.length).toBeGreaterThan(0);
    expect(session.keys[0]).toBe(ZOOM_OUT);
    expect(session.drags.length).toBeGreaterThan(0);
    expect(session.drags[0]!.from.y).toBeGreaterThanOrEqual(0);
    expect(session.taps).toHaveLength(1);
    expect(session.left).toBe(true);
  }, 240_000);
});
