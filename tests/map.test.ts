import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, MapIcon, MapState, RgbaImage } from '../src/contracts.ts';
import { MapPerceiver, readMap, readMapDetailed, tileOnScreen } from '../src/perception/map.ts';
import { floorKeyDistance } from '../src/tasks/steps.ts';

/**
 * R26: the engine hands the World JPEG, not PNG, so the fixtures under test are the JPEGs the
 * engine would produce (`ffmpeg -q:v 6`, measured as the q75-equivalent; see the report). Decoding
 * here mirrors the source: `jpeg-js` into RGBA, then a Frame whose `toRgba()` returns that image.
 */
const FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

/**
 * The live 2026-11-01 maps the parser refused while a human read them instantly — both refused the
 * farm loop with an unknown screen. They are fixtures so the next regression names them:
 * 第三区's panel border fused with the X label, 第四区's title strip is lit by the lava wall behind
 * the translucent panel.
 */
const LIVE_MAPS = new URL('../testdata/nav-2026-11-01-maps/', import.meta.url);

async function liveMapFrame(name: string): Promise<Frame> {
  const bytes = await readFile(new URL(name, LIVE_MAPS));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 1, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

async function jpegFrame(name: string, atMs = 4_000): Promise<Frame> {
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return {
    atMs,
    width: decoded.width,
    height: decoded.height,
    toRgba: async () => image,
  };
}

const cell = (point: { x: number; y: number }) => `${point.x},${point.y}`;

describe('the live map frames of 2026-11-01', () => {
  it('reads 第三区 whose panel border fused with the X label', async () => {
    const map = await readMap(await liveMapFrame('third-2f.jpg'));
    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 13, y: 25 });
  });

  it('reads 第四区 whose title strip is lit by the wall behind the translucent panel', async () => {
    const map = await readMap(await liveMapFrame('fourth-2f.jpg'));
    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 19, y: 2 });
  });
});

describe('the 楼梯-门 icon (operator name, 2026-11-03)', () => {
  it('is found on the FFXI 第三区-城内2F map, one cell from the party', async () => {
    // The door-with-arrow glyph the operator sent: the stair entrance to the next floor. The operator's
    // rule: the farm's area is beside it and the harken teleports far from the farm, so the climb walks
    // to this icon. The frame is the live capture kept for the reader work.
    const url = new URL('../testdata/screens/2026-11-03-ffxi-map/map-1920.jpg', import.meta.url);
    const bytes = await readFile(url);
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const map = await readMap({
      atMs: 0,
      width: image.width,
      height: image.height,
      toRgba: async () => ({ data: image.data, width: image.width, height: image.height }),
    });
    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 13, y: 25 });
    const stairs = map!.icons.filter((icon) => icon.kind === 'stair-door');
    expect(stairs).toEqual([{ kind: 'stair-door', at: { x: 13, y: 26 } }]);
  });

  it('is found again after the party moves, at the same tile', async () => {
    // The live run 2026-11-03 21:34 stopped on exactly this: the same floor read six cells and one row
    // away (player 7,24) and the icon vanished, because the search lattice rides with the party's
    // chevron while the glyph is drawn a few px off the cell centre. The reader seeds around the cell
    // before sweeping, so the glyph is found from any party position.
    const url = new URL('../.tmp/map-live2.jpg', import.meta.url);
    const bytes = await readFile(url);
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const map = await readMap({
      atMs: 0,
      width: image.width,
      height: image.height,
      toRgba: async () => ({ data: image.data, width: image.width, height: image.height }),
    });
    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 7, y: 24 });
    expect(map!.icons.filter((icon) => icon.kind === 'stair-door')).toEqual([
      { kind: 'stair-door', at: { x: 13, y: 26 } },
    ]);
  });
});

describe('readMap', () => {
  it('reads the floor token, the party cell and the icons from map.jpg', async () => {
    const map = await readMap(await jpegFrame('map.jpg'));

    expect(map).not.toBeNull();
    // R27: the Latin token only — the localized half is a one-sample atlas entry and is not read.
    expect(map!.floorTitle).toBe('B1F');
    // The readout says X: 20 Y: 14 (research §3, §13); the old 19/21 is popup.png's reading.
    expect(map!.player).toEqual({ x: 20, y: 14 });

    const chests = map!.icons
      .filter((icon) => icon.kind === 'chest')
      .map((icon) => cell(icon.at))
      .sort();
    expect(chests).toEqual(['18,9', '23,13', '8,8']);

    // The hazard is the cell directly north of the party (research §6).
    expect(map!.icons.filter((icon) => icon.kind === 'hazard').map((icon) => cell(icon.at))).toEqual([
      '20,15',
    ]);

    // One sample, unproven (research §6, §9): the template is exact here because it came from this
    // floor, so this asserts the pipeline, not that the glyph generalizes.
    expect(map!.icons.some((icon) => icon.kind === 'stairs')).toBe(true);

    // The harken: the white sparkle the operator changes floor by, matched at two drawn sizes
    // (12 px here, 16 px on 第三区) — cell (20,21), the floor's only one.
    expect(map!.icons.filter((icon) => icon.kind === 'harken').map((icon) => cell(icon.at))).toEqual(['20,21']);

    // contracts §3 `origin`: the chevron's own screen point, the anchor every tile click is placed
    // from. The canvas scrolls, so this is the only absolute position a walk may use. It is a blob
    // centroid, hence fractional: a half pixel is nothing against a 36 px cell.
    expect(map!.origin.x).toBeCloseTo(1_212.7, 0);
    expect(map!.origin.y).toBeCloseTo(569.3, 0);
  });

  it('reads the map behind the automove banner', async () => {
    const map = await readMap(await jpegFrame('popup.jpg'));

    expect(map).not.toBeNull();
    expect(map!.floorTitle).toBe('B1F');
    expect(map!.player).toEqual({ x: 19, y: 21 });
    expect(map!.icons.filter((icon) => icon.kind === 'chest')).toHaveLength(2);
    expect(map!.icons.some((icon) => icon.kind === 'hazard')).toBe(true);
  });

  it('refuses the HUD-only frame instead of misreading it as a map', async () => {
    expect(await readMap(await jpegFrame('minimap-and-hud.jpg'))).toBeNull();
  });

  it('refuses a readout glyph that the template atlas cannot match', async () => {
    const frame = await jpegFrame('map.jpg');
    const image = await frame.toRgba();
    const data = Uint8Array.from(image.data);

    // Overwrite the X tens digit (x 1041–1046, y 900–911) with a pattern no digit template covers.
    for (let y = 900; y < 912; y += 1) {
      for (let x = 1041; x < 1047; x += 1) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        const offset = (y * image.width + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    const mutated: Frame = {
      ...frame,
      toRgba: async () => ({ data, width: image.width, height: image.height }),
    };

    expect(await readMap(mutated)).toBeNull();
  });

  it('refuses a frame of another size rather than mis-scaling the fixed rects', async () => {
    const image: RgbaImage = { data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 };
    const frame: Frame = { atMs: 1, width: 64, height: 64, toRgba: async () => image };

    expect(await readMap(frame)).toBeNull();
  });
});

/**
 * The refusal names its gate (task t-mvmuxnkc-jveshn). `readMap` keeps answering `null`; the detailed
 * reader is what a diagnosis reads, so a live refusal costs one call on the saved frame instead of a
 * bisected copy of the parser.
 */
describe('readMapDetailed — a refusal names the gate that refused it', () => {
  it('names the size gate for a frame that is not 1920x1080', async () => {
    const image: RgbaImage = { data: new Uint8Array(64 * 64 * 4), width: 64, height: 64 };
    const frame: Frame = { atMs: 1, width: 64, height: 64, toRgba: async () => image };

    expect(await readMapDetailed(frame)).toEqual({ ok: false, gate: 'unsupported-size' });
  });

  it('names the gate that refuses the HUD-only frame', async () => {
    expect(await readMapDetailed(await jpegFrame('minimap-and-hud.jpg')))
      .toEqual({ ok: false, gate: 'readout-labels' });
  });

  it('names the digit gate when a readout glyph matches no template', async () => {
    const frame = await jpegFrame('map.jpg');
    const image = await frame.toRgba();
    const data = Uint8Array.from(image.data);

    // The same mutation the refusal test above uses: the X tens digit becomes a checkerboard.
    for (let y = 900; y < 912; y += 1) {
      for (let x = 1041; x < 1047; x += 1) {
        const value = (x + y) % 2 === 0 ? 255 : 0;
        const offset = (y * image.width + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    const mutated: Frame = {
      ...frame,
      toRgba: async () => ({ data, width: image.width, height: image.height }),
    };

    expect(await readMapDetailed(mutated)).toEqual({ ok: false, gate: 'readout-digit-unmatched' });
  });

  it('names a decode failure rather than folding it into a refusal', async () => {
    const frame: Frame = {
      atMs: 1,
      width: 1920,
      height: 1080,
      toRgba: async () => {
        throw new Error('decode failed');
      },
    };

    expect(await readMapDetailed(frame)).toEqual({ ok: false, gate: 'decode-failed' });
  });
});

describe('MapPerceiver', () => {
  it('reports a dungeonmap observation with its confidence and the frame time', async () => {
    const frame = await jpegFrame('map.jpg', 12_345);
    const observation = await new MapPerceiver().observe(frame);

    expect(observation.screen).toBe('dungeonmap');
    if (observation.screen !== 'dungeonmap') return;
    expect(observation.atMs).toBe(12_345);
    expect(observation.confidence).toBeGreaterThanOrEqual(0.7);
    expect(observation.confidence).toBeLessThanOrEqual(1);
    expect(observation.map.floorTitle).toBe('B1F');
  });

  it('reports unknown with confidence 0 for the HUD-only frame', async () => {
    const frame = await jpegFrame('minimap-and-hud.jpg', 7_000);
    const observation = await new MapPerceiver().observe(frame);

    expect(observation).toEqual({ screen: 'unknown', atMs: 7_000, confidence: 0 });
  });
});

/**
 * R27a: the floor's title fingerprint. The FFXI collab floors print a Chinese title where the
 * Latin slots expect `B1F`; the fingerprint is what makes those floors nameable at all. Measured
 * 2026-10-24 on the live game (1920×1080, `第四区-城内2F深处-`).
 */
describe('readMap — the floor title fingerprint', () => {
  const FFXI = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);

  async function ffxiFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, FFXI));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads a map whose title is not Latin, with the measured key', async () => {
    const map = await readMap(await ffxiFrame('map.jpg'));

    expect(map).not.toBeNull();
    expect(map!.floorTitle).toBe('');
    expect(map!.titleKey).toBe('000000007f3ffe007f7efe00220ba600');
    // The readout is still the gate that proves this is a map: X: 11 Y: 23 on the captured frame.
    expect(map!.player).toEqual({ x: 11, y: 23 });
  });

  it('keeps the Latin token and gives it a key too', async () => {
    const map = await readMap(await jpegFrame('map.jpg'));

    expect(map!.floorTitle).toBe('B1F');
    expect(map!.titleKey).toBe('0000c00003e6c00003efe00003874000');
  });

  it('gives two floors different keys', async () => {
    const latin = await readMap(await jpegFrame('map.jpg'));
    const ffxi = await readMap(await ffxiFrame('map.jpg'));

    expect(latin!.titleKey).not.toBe(ffxi!.titleKey);
  });

  // Measured 2026-10-31: this frame is refused at the readout band and never reaches the floor-key
  // gate; the gate's name is pinned by the readMapDetailed test above.
  it('still refuses the HUD frame, at the readout band', async () => {
    expect(await readMap(await jpegFrame('minimap-and-hud.jpg'))).toBeNull();
  });
});

/**
 * The FFXI collab floors are translucent over the 3D view, so the map panel carries the scene's
 * glow; the readout band also picks up the panel's scrollbar. Both are handled (R28, R29) and this
 * is the frame class that first exposed them.
 */
describe('readMap — the FFXI third floor', () => {
  const FFXI = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);

  async function ffxiFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, FFXI));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads the floor, the party cell and three chests', async () => {
    const map = await readMap(await ffxiFrame('third-floor.jpg'));

    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 13, y: 23 });
    const chests = map!.icons.filter((icon) => icon.kind === 'chest').map((icon) => cell(icon.at)).sort();
    expect(chests).toEqual(['5,16', '6,17', '9,13']);
    // The floor the route farms: its chevron is what a tile walk is aimed from.
    expect(map!.origin.x).toBeCloseTo(959.5, 0);
    expect(map!.origin.y).toBeCloseTo(264.7, 0);
  });

  it('keeps the floor key under the harken glow, within the gate tolerance', async () => {
    const clean = await readMap(await ffxiFrame('third-floor.jpg'));
    const glow = await readMap(await ffxiFrame('third-floor-glow.jpg'));

    expect(glow).not.toBeNull();
    expect(glow!.player).toEqual({ x: 7, y: 24 });
    // R27b: the glow shifts a couple of bits; the task's gate compares with a small tolerance.
    expect(floorKeyDistance(clean!.titleKey, glow!.titleKey)).toBeLessThanOrEqual(8);
  });

  it('reads the same markers after the party walked and the harken glows', async () => {
    const clean = await readMap(await ffxiFrame('third-floor.jpg'));
    const glow = await readMap(await ffxiFrame('third-floor-glow.jpg'));

    // The glow capture is the same floor after the party walked from X: 13 Y: 23 to the harken
    // (X: 7 Y: 24); the canvas scrolls by 210 px but a mark does not move. Measured 2026-10-31:
    // this frame used to read its harken and nothing else, because the icon cells were placed from
    // the lattice fit's phase (2 px off in Y on this translucent frame) instead of the chevron.
    const of = (map: MapState, kind: MapIcon['kind']): string[] =>
      map.icons.filter((icon) => icon.kind === kind).map((icon) => cell(icon.at)).sort();
    expect(of(glow!, 'chest')).toEqual(of(clean!, 'chest'));
    expect(of(glow!, 'hole')).toEqual(of(clean!, 'hole'));
    expect(of(glow!, 'harken')).toEqual(of(clean!, 'harken'));
  });
});

/**
 * The live capture the World refused on 2026-10-25 (task t-mvmln6jh-zy0cij). With the party standing
 * at the harken, its light column lights long runs of the panel's row profile, the residual quality
 * test read 7.86 px against the 6.5 ceiling, and `status` answered `unknown` 0.2 for a map the rest
 * of the gates had already read. The X axis of the same frame is clean; G6 now counts the lines one
 * 36-px grid explains (support) instead of the residual every lit run leaves. The frame is the
 * session's own 1920×1080 capture, committed unmodified.
 */
describe('readMap — the live 第三区 capture the glow refused (2026-10-25)', () => {
  const LIVE = new URL('../testdata/nav-2026-10-25-ffxi4f/', import.meta.url);

  async function liveFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, LIVE));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads the party cell and the floor markers through the harken glow', async () => {
    const map = await readMap(await liveFrame('third-floor-harken.jpg'));

    expect(map).not.toBeNull();
    // The readout the operator saw on screen: X: 7 Y: 24.
    expect(map!.player).toEqual({ x: 7, y: 24 });

    const of = (kind: MapIcon['kind']): string[] =>
      map!.icons.filter((icon) => icon.kind === kind).map((icon) => cell(icon.at)).sort();
    // The same cells the clean capture of this floor carries (the tests above): a glow moves no mark.
    expect(of('harken')).toEqual(['6,24']);
    expect(of('hole')).toEqual(['1,17', '20,8']);
    // This session's chest spawns at (25,8) — the 2026-10-24 floor spawns a different set, so the
    // clean capture above is not the oracle for it; the glyph was pixel-verified on the frame.
    expect(of('chest')).toEqual(['25,8']);
    // R27b: the floor gate compares fingerprints with a small tolerance; the glow shifts a few bits.
    expect(floorKeyDistance(map!.titleKey, '0c0280000d6ff0000d7ffc0008c37000')).toBeLessThanOrEqual(8);
  });
});

/**
 * The live 第四区 capture the 4F route depends on (2026-10-31, player X: 21 Y: 1). The parser read
 * the six orchid teleport rings and **no chest**, while the canvas draws three of the 第三区 chest
 * glyphs (measured NCC 0.96–0.98 at their cells). Root cause: the icon cells were enumerated from
 * the X lattice fit, whose pitch on this translucent frame came out 35.9 and whose phase therefore
 * sits 3.1 px east of the true 36-px grid; the template search only reaches ±2 px, so every
 * template icon missed. The colour blobs (teleport, hazard) and the chevron do not use the lattice
 * phase, which is why the frame still read six rings.
 *
 * The harken is **not** visible here: this floor's harken cell is (10,23), which under this frame's
 * scroll lands at y ≈ 10 — above the map panel. The bright cross the operator saw at ~(835,535) is
 * a wall-line corner (a vertical and a horizontal cell border meeting), not the sparkle; the same
 * floor's 2026-10-24 capture draws the sparkle at (10,23). Pinning the empty set is what stops a
 * future detector from inventing one and sending the party to a wall.
 */
describe('readMap — the live 第四区 capture (2026-10-31)', () => {
  const LIVE = new URL('../testdata/nav-2026-10-31-ffxi4f-4f/', import.meta.url);

  async function liveFrame(name: string): Promise<Frame> {
    const bytes = await readFile(new URL(name, LIVE));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('reads the party cell, the six rings and the three chests the canvas draws', async () => {
    const map = await readMap(await liveFrame('fourth-floor-live.jpg'));

    expect(map).not.toBeNull();
    // The readout and the floor fingerprint the operator saw on screen, byte for byte.
    expect(map!.player).toEqual({ x: 21, y: 1 });
    expect(map!.titleKey).toBe('000000007f3ffe007ffeff00220bb600');

    const of = (kind: MapIcon['kind']): string[] =>
      map!.icons.filter((icon) => icon.kind === kind).map((icon) => cell(icon.at)).sort();

    // The two chests the operator pointed at, plus the third the canvas draws south of the party:
    // the chest glyphs are cell-centred, so the cells are the answer a tile walk consumes.
    expect(of('chest')).toEqual(['12,3', '20,2', '21,5']);
    // The orchid rings this frame carries, including (0,3), the sixth ring the row below the
    // 2026-10-24 capture could not show (its canvas hung it below the panel).
    expect(of('teleport')).toEqual(['0,3', '12,18', '17,13', '17,15', '4,9', '7,13']);
    // See the header: the floor's harken is off-panel on this scroll; the (835,535) cross is walls.
    expect(of('harken')).toEqual([]);
  });
});

/**
 * The grid→screen transform a tile walk is aimed with (contracts §3 `origin`): exactly the inverse
 * of `findIcons`' own `toGrid`, so the cell the parser names and the cell a tap lands on are one
 * cell.
 */
describe('tileOnScreen', () => {
  /** The shape of one `map.jpg` readout: the party on (20,14), its chevron at (1213,569). */
  const map: MapState = {
    floorTitle: 'B1F',
    titleKey: '0000',
    player: { x: 20, y: 14 },
    origin: { x: 1_213, y: 569 },
    icons: [],
  };

  it("puts the party's own cell back on the chevron", () => {
    expect(tileOnScreen(map, map.player)).toEqual({ x: 1_213, y: 569 });
  });

  it('steps one 36 px cell per grid step, with y inverted', () => {
    // Grid y counts upward and the screen's downward: north of the party is a smaller screen y.
    expect(tileOnScreen(map, { x: 21, y: 14 })).toEqual({ x: 1_249, y: 569 });
    expect(tileOnScreen(map, { x: 20, y: 15 })).toEqual({ x: 1_213, y: 533 });
    expect(tileOnScreen(map, { x: 18, y: 9 })).toEqual({ x: 1_141, y: 749 });
  });

  it('rounds to a pixel, because the chevron is a centroid and a tap has no fractions', () => {
    expect(tileOnScreen({ ...map, origin: { x: 1_212.7, y: 569.3 } }, map.player)).toEqual({ x: 1_213, y: 569 });
  });

  it("aims the FFXI third floor's nearest chest inside the map panel", () => {
    // player 13,23; chevron (959.5,264.7); the chests are (6,17), (5,16), (9,13) and the nearest by
    // the route's Manhattan proxy is (6,17). The map panel's icon window is x 460-1710, y 140-920,
    // so an aim that leaves it means the transform, not the route, is wrong.
    const ffxi: MapState = {
      floorTitle: '',
      titleKey: '000000007f3ffe007f7efe00220ba600',
      player: { x: 13, y: 23 },
      origin: { x: 959.476, y: 264.726 },
      icons: [],
    };
    const aim = tileOnScreen(ffxi, { x: 6, y: 17 });
    expect(aim).toEqual({ x: 707, y: 481 });
    expect(aim.x).toBeGreaterThan(460);
    expect(aim.x).toBeLessThan(1_710);
    expect(aim.y).toBeGreaterThan(140);
    expect(aim.y).toBeLessThan(920);
  });
});

/**
 * The floor-transition markers (2026-10-24): what the map draws where a party changes floor. The
 * kinds are named by glyph — the mechanic they serve is not asserted here — and every positive below
 * is also a negative on the other two floors, which is what stops a marker from being invented.
 */
describe('readMap — floor-transition markers', () => {
  const FFXI = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);

  async function frame(name: string, base = FFXI): Promise<Frame> {
    const bytes = await readFile(new URL(name, base));
    const decoded = jpeg.decode(bytes, { useTArray: true });
    const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  const of = (map: MapState, kind: MapIcon['kind']): string[] =>
    map.icons.filter((icon) => icon.kind === kind).map((icon) => cell(icon.at)).sort();

  it('reads the two holes on the FFXI third floor and nothing else that crosses', async () => {
    const map = await readMap(await frame('third-floor.jpg'));

    // The down-arrow-over-an-oval glyph: two instances, at cell centre + (-1, +1). Measured NCC 1.00
    // and 0.98; the best score anywhere else in any committed map frame is 0.65.
    expect(of(map!, 'hole')).toEqual(['1,17', '20,8']);
    expect(of(map!, 'harken')).toEqual(['6,24']);
    expect(of(map!, 'teleport')).toEqual([]);
    expect(of(map!, 'stairs')).toEqual([]);
  });

  it('reads all five orchid rings on the FFXI fourth floor — the floor that read zero icons', async () => {
    const map = await readMap(await frame('map.jpg'));

    expect(map).not.toBeNull();
    expect(map!.player).toEqual({ x: 11, y: 23 });
    expect(of(map!, 'teleport')).toEqual(['12,18', '17,13', '17,15', '4,9', '7,13']);
    // Five rings move the party *within* the floor; the one harken is what crosses it.
    expect(of(map!, 'harken')).toEqual(['10,23']);
    // And the floor draws its own 楼梯-门 (the stairs back up), found by the same reader: the icon is
    // the way the FFXI climb works (operator rule 2026-11-03), so its presence here is the rule, not a
    // false positive.
    expect(of(map!, 'stair-door')).toEqual(['16,26']);
    expect(map!.icons).toHaveLength(7);
    expect(of(map!, 'chest')).toEqual([]);
    expect(of(map!, 'hole')).toEqual([]);
  });

  it('invents no transition marker on B1F, which draws only the staircase', async () => {
    const map = await readMap(await frame('map.jpg', new URL('../testdata/nav-1024-0213/', import.meta.url)));

    expect(of(map!, 'hole')).toEqual([]);
    expect(of(map!, 'teleport')).toEqual([]);
    expect(of(map!, 'stairs')).toEqual(['25,25']);
    expect(of(map!, 'harken')).toEqual(['20,21']);
  });

  it('aims a walk at the ring it identified: the identified cell is the cell a tap would hit', async () => {
    const map = await readMap(await frame('map.jpg'));
    const ring = map!.icons.find((icon) => icon.kind === 'teleport' && icon.at.x === 12 && icon.at.y === 18);
    expect(ring).toBeDefined();

    // contracts §3: a consumer converts the published cell once, with `origin` and `tileOnScreen`,
    // and hands `automoveToTile` a screen point. The ring's measured centre is (923.5, 449), so the
    // transform lands inside the glyph — identification and initiation meet at one cell.
    const aim = tileOnScreen(map!, ring!.at);
    expect(aim).toEqual({ x: 925, y: 446 });
    expect(Math.abs(aim.x - 923.5)).toBeLessThanOrEqual(3);
    expect(Math.abs(aim.y - 449)).toBeLessThanOrEqual(4);
  });
});

