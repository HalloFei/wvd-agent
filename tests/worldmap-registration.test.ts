import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Frame, Observation, Point, RgbaImage } from '../src/contracts.ts';
import { travelViaAtlas } from '../src/actions/worldmap.ts';
import { createAtlas, worldMapAtlas } from '../src/perception/map-localiser.ts';
import { MAP_STRIP, WORLD_MAP_SITES } from '../src/perception/worldmap-atlas.ts';

const VNH = WORLD_MAP_SITES.find((site) => site.id === 'vnh')!;
const LEVEL_ONE = 1.52;
const AIM = { x: MAP_STRIP.x + (MAP_STRIP.width - 24) / 2, y: 30 + 870 / 2 };

/**
 * The committed atlas at a quarter of its stored resolution (4 atlas px per stored px): the same
 * map, four times cheaper to register. The matching, the pyramid and the geometry are the same code.
 */
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
  return createAtlas({
    atlasWidth: full.atlasWidth,
    atlasHeight: full.atlasHeight,
    pixelsPerCell: 4,
    width,
    height,
    gray,
  });
}

/** A frame of the map at level 1 with 诺森霍洛村 on the aim point: `screen = f * (atlas - origin)`. */
function mapFrame(atlas: ReturnType<typeof quarterAtlas>): { frame: RgbaImage; tapAt: Point } {
  const origin = {
    x: VNH.x - (AIM.x - MAP_STRIP.x) / LEVEL_ONE,
    y: VNH.y - AIM.y / LEVEL_ONE,
  };
  const width = 1920;
  const height = 1080;
  const data = new Uint8Array(width * height * 4);
  const cells = atlas.layers[atlas.layers.length - 1]!;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = x - MAP_STRIP.x;
      let value = 0;
      if (s >= 0 && s < MAP_STRIP.width) {
        const ax = Math.round((origin.x + s / LEVEL_ONE) / atlas.pixelsPerCell);
        const ay = Math.round((origin.y + y / LEVEL_ONE) / atlas.pixelsPerCell);
        if (ax >= 0 && ay >= 0 && ax < cells.width && ay < cells.height) value = cells.data[ay * cells.width + ax]!;
      }
      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { frame: { data, width, height }, tapAt: { x: AIM.x, y: AIM.y } };
}

class Session {
  taps: Point[] = [];
  drags: Array<{ from: Point; to: Point }> = [];
  keys: number[] = [];
  readonly abort = undefined;
  /** A clock the fake sleep advances: every poll and settle in the action is deadline-driven. */
  clock = 0;
  now = (): number => this.clock;
  sleep = async (ms: number): Promise<void> => { this.clock += ms; };
  actuator = {
    tap: async (at: Point): Promise<ActionResult> => { this.taps.push(at); return { ok: true }; },
    drag: async (from: Point, to: Point): Promise<ActionResult> => { this.drags.push({ from, to }); return { ok: true }; },
    holdKey: async (scan: number): Promise<ActionResult> => { this.keys.push(scan); return { ok: true }; },
    moveTo: async (): Promise<ActionResult> => ({ ok: true }),
    scroll: async (): Promise<ActionResult> => ({ ok: true }),
  } as unknown as Actuator;
}

describe('travelViaAtlas with locate registration', () => {
  it('places the view by registration and taps the node without the zoom clamp or the banners', async () => {
    const atlas = quarterAtlas();
    const { frame, tapAt } = mapFrame(atlas);
    const session = new Session();
    const logs: string[] = [];
    const env = {
      actuator: session.actuator,
      capture: async (): Promise<Frame> => ({ atMs: 0, width: 1920, height: 1080, toRgba: async () => frame }),
      observe: async (): Promise<Observation> => ({
        screen: session.taps.length > 0 ? 'dungeon' : 'worldmap', atMs: 0, confidence: 0.9,
      } as Observation),
      sleep: session.sleep,
      log: (line: string) => { logs.push(line); },
      now: session.now,
    };
    const result = await travelViaAtlas({ kind: 'site', id: 'vnh' }, env as never, {
      locate: 'registration', trace: true, localiserAtlas: atlas,
    });
    expect(result.ok).toBe(true);
    expect(logs.some((line) => line.includes('registration located the view'))).toBe(true);
    // No zoom clamp: the localiser does not press the zoom-out key to find out where it is.
    expect(session.keys).toHaveLength(0);
    expect(session.taps).toHaveLength(1);
    expect(Math.abs(session.taps[0]!.x - tapAt.x)).toBeLessThanOrEqual(80);
    expect(Math.abs(session.taps[0]!.y - tapAt.y)).toBeLessThanOrEqual(80);
  }, 240_000);
});
