/**
 * 3-D exploration-view perception: `HudPerceiver` names the screen the route opens the map *from*
 * (contracts §2 `dungeon`) — the party walking, the HUD up, no map open.
 *
 * It answers one question and refuses everything else. The 3-D view has a HUD (a minimap panel and a
 * command grid in the frame's top-right corner); a black, uniform or faded frame has nothing, and a
 * frame that still shows the **map's structure** belongs to the map perceiver, not here. So:
 *
 * - the map gate must be **absent**: the readout's eight glyph runs (the decisive test — 0 of 198
 *   non-map frames produced eight), no white map ink at the map panel's density, and no 36-px wall
 *   lattice;
 * - the HUD anchor must be **present**: bright low-saturation ink inside the minimap box.
 *
 * Everything is measured from `testdata/nav-1024-0213/` and recorded in
 * `.superpowers/sdd/2026-10-24-wvd-world-v1/research-map-parser.md` (cited as "research §n"). The
 * numbers that report calls one-sample are named with that word in their comment and are never
 * presented as facts.
 *
 * Two rules shape the code:
 *
 * - **Slice before thresholding, and pay for the cheap test first.** A whole-frame pass costs ~85 ms
 *   on this machine (contracts §0.7 is a 50 ms half-tick), so the common 3-D frame only ever reads
 *   three small rects (the readout band, the map panel at a stride, the minimap box) and the answer
 *   is returned at the first one that decides. The lattice rect is read only when the panel's ink
 *   says a map could be there.
 * - **Refusal is a first-class answer.** Every non-dungeon frame — another size, a uniform frame, a
 *   decode failure, a frame showing any map structure — is `unknown` with confidence 0 (contracts
 *   §2/§3). No path throws into the loop (contracts §0.6).
 *
 * Geometry is 1920×1080 device pixels. Contracts §0.5: another size is unsupported, not re-scaled.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/** The only frame size the fixed rects were measured at (research §1, §12 item 3). */
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/**
 * G1 — the coordinate readout `X: n  Y: n`, the map's decisive structural gate (research §3).
 *
 * The same measured fact the map parser uses, declared here instead of imported (contracts §0.1: a
 * module imports contracts and its own files). It is a *structure* test, not a brightness test: the
 * HUD frame has bright pixels inside this rect (the 3-D scene shows through) yet only two runs; the
 * map has eight, at these fixed x positions. 0 of 198 non-map frames produced eight.
 */
const READOUT_X = 1010;
const READOUT_Y = 898;
const READOUT_W = 136;
const READOUT_H = 16;
const READOUT_INK_LUMA = 85;
/** `X`, `:`, digit, digit, `Y`, `:`, digit, digit (research §3). */
const READOUT_RUNS = 8;
const READOUT_LABEL_X = [1017, 1094] as const;
const READOUT_LABEL_TOLERANCE = 2;
const READOUT_LABEL_MIN_W = 9;
const READOUT_LABEL_MAX_W = 13;

/**
 * "A run is at least two lit columns" — the map parser's segmentation. The one-column gaps between
 * two digits must **not** be bridged: merging them collapses the eight runs into fewer (research §3,
 * and the map parser's measured note), which would make a real map look like a 3-D view.
 */
const RUN_MIN_COLUMNS = 2;

/**
 * G3 — white map ink in the panel: 15 000 … 200 000 px over 26 map frames against 198 non-map frames
 * (research §1). Read at a stride: the count is an estimate, scaled back by the stride squared. The
 * HUD fixture is far below the floor (≈1 200 against ≈35 000 for the map), so the estimate's noise
 * cannot move the decision. The **upper** bound is the other end of the same measured fact: the
 * busiest map frame is 164 905, and the captured desktop screens the research saw reach 869 655 — a
 * panel with far more white than any map is not a map panel, so the lattice is not even read.
 */
const MAP_INK_X = 480;
const MAP_INK_Y = 150;
const MAP_INK_W = 1220;
const MAP_INK_H = 750;
const MAP_INK_LUMA = 185;
const MAP_INK_SAT = 60;
const MAP_INK_MIN = 15_000;
const MAP_INK_MAX = 200_000;
const MAP_INK_STRIDE = 4;

/**
 * G6 — the floor's 36.0-px wall lattice: at least eight long white lines on a 36-px pitch, rms
 * ≤ 3.5 px (research §5, §8 item 5). The pitch is the measured constant (three independent
 * measurements agree on 36.0), so only the phase is fitted per frame — the canvas scrolls, the pitch
 * does not (research §5). The profiles are sampled at a stride; the research's 100-lit-px line floor
 * is therefore halved. This check runs only when G3 is in the map panel's range, i.e. almost never
 * on a 3-D frame.
 */
const LATTICE_X = 474;
const LATTICE_Y = 160;
const LATTICE_W = 972;
const LATTICE_H = 740;
const LATTICE_INK_LUMA = 185;
const LATTICE_INK_SAT = 60;
const LATTICE_STRIDE = 2;
/** The research's 100-lit-px line, read over every sampled row/column. */
const LATTICE_LINE_MIN_INK = 50;
const LATTICE_MIN_LINES = 8;
const TILE_PX = 36;
const LATTICE_PHASE_STEP = 0.5;
const LATTICE_RMS_MAX = 3.5;

/**
 * The HUD anchor — **one sample**: the minimap box at x 1761–1901, y 18–168, measured on
 * `minimap-and-hud.png` and cross-checked against `navigation-design.md` §3a (the `↻` resume control
 * at (1824, 196), which agrees with §3a's (1825, 195)). The panel is opaque: the 3-D scene does not
 * show through it, which is what makes "bright ink here" mean "HUD", not "bright scene".
 *
 * The box holds 2 629 bright low-saturation pixels in the JPEG fixture, and its own border lines
 * alone account for ≈320 of them (the panel's top edge is three 104–108-px runs). The floor is set
 * at the border level so a sparse minimap — one with little explored, not one with no HUD — still
 * passes; 1 200 is half the sample, the level at which the panel is unmistakably drawn.
 */
const HUD_X = 1761;
const HUD_Y = 18;
const HUD_W = 140;
const HUD_H = 150;
const HUD_INK_LUMA = 150;
const HUD_INK_SAT = 60;
const HUD_INK_FLOOR = 300;
const HUD_INK_STRONG = 1_200;

/**
 * Confidence is evidence strength, and it is deliberately compressed into [0.8, 1] once the HUD is
 * present: below the floor there is no HUD, and at the measured panel level the anchor is as strong
 * as this perceiver can make it. The calibration is this module's own choice — unlike the map
 * parser's floors, it is not a measured fact — so it is named here and reported. Every dungeon
 * observation therefore clears the route's 0.5 act floor (contracts §6, §2).
 */
const HUD_CONFIDENCE_MIN = 0.8;

// ---------------------------------------------------------------------------------------------
// The perceiver
// ---------------------------------------------------------------------------------------------

/**
 * Names the 3-D exploration view. `unknown` (confidence 0) is its refusal: another frame size, a
 * uniform or over-bright frame, a decode failure, a frame without the HUD, or any frame that still
 * shows the map — that frame is the map perceiver's business.
 *
 * The steps are the research's refusal order, each one reading a small rect and answering early:
 * size, the readout structure, the panel's ink mass, the wall lattice, then the HUD anchor.
 */
export class HudPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };

    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      // Failure is a value (contracts §0.6): a decode failure is "not observed", not a throw.
      return unknown;
    }

    // 0. Size (contracts §0.5) -----------------------------------------------------------------
    if (image.width !== REFERENCE_WIDTH || image.height !== REFERENCE_HEIGHT) return unknown;

    // 1. G1: the readout's eight runs — the map's decisive structure, and the map's frame. ------
    if (readoutPresent(image)) return unknown;

    // 2. G3: the panel's white ink, which decides both whether the lattice is worth reading and
    //    whether this is too bright to be the walking view at all. -------------------------------
    const ink = panelInk(image);
    // Whiter than any map frame and 25× whiter than any measured 3-D frame (≤ 8 000, research §1):
    // a combat flash, a desktop capture, or a screen this perceiver cannot name. Refuse it.
    if (ink > MAP_INK_MAX) return unknown;
    // G6: the floor's 36-px wall lattice, read only when the ink is map-scale. ------------------
    if (ink >= MAP_INK_MIN && latticePresent(image)) return unknown;

    // 3. The HUD anchor must be present — a scene is not a screen (contracts §2). --------------
    const hudInk = minimapInk(image);
    if (hudInk < HUD_INK_FLOOR) return unknown;

    return { screen: 'dungeon', atMs: frame.atMs, confidence: confidenceOf(hudInk) };
  }
}

// ---------------------------------------------------------------------------------------------
// The map gate: its measured structures mean "not this perceiver's frame"
// ---------------------------------------------------------------------------------------------

/*
 * The gate, in the research's order (research §1: G1, then G3, then G6), is spread over the steps of
 * `observe` above so that each answer is returned as soon as it is known:
 *
 * - G1, the readout's eight glyph runs — decisive (0 of 198 non-map frames) and cheap enough to run
 *   on every frame;
 * - G3, the panel's white ink — a *precondition* for G6, not a verdict: plenty of non-map frames
 *   carry white ink (research §1: 0–869 655 over 198 frames), so the ink alone never decides, but
 *   both of its ends are informative (below 15 000 the panel is a scene; above 200 000 it is no map);
 * - G6, the 36-px wall lattice — the second structure, so a map caught mid-open that has lost its
 *   readout but keeps its walls is still refused.
 *
 * G2 (the title bar's dark strip) is deliberately absent: it is a *necessary* condition for the map,
 * not a sufficient one — 95 of 198 non-map frames are dark there too (research §1). Using it would
 * turn a dark corridor into "not the dungeon", which is exactly the unreachability Task 7 found.
 */

/** G1 — the readout: exactly eight column runs, with the two labels at their measured x. */
function readoutPresent(image: RgbaImage): boolean {
  const { data, width } = image;
  const columnInk = new Uint8Array(READOUT_W);
  for (let y = 0; y < READOUT_H; y += 1) {
    const row = (READOUT_Y + y) * width;
    for (let x = 0; x < READOUT_W; x += 1) {
      if (lumaAt(data, (row + READOUT_X + x) * 4) > READOUT_INK_LUMA) columnInk[x] = 1;
    }
  }

  const runs = columnRuns(columnInk);
  if (runs.length !== READOUT_RUNS) return false;

  const labelRuns = [runs[0], runs[4]];
  for (let i = 0; i < READOUT_LABEL_X.length; i += 1) {
    const [from, to] = labelRuns[i];
    const runWidth = to - from + 1;
    if (runWidth < READOUT_LABEL_MIN_W || runWidth > READOUT_LABEL_MAX_W) return false;
    if (Math.abs(READOUT_X + from - READOUT_LABEL_X[i]) > READOUT_LABEL_TOLERANCE) return false;
  }
  return true;
}

/** Runs of lit columns over the readout band; a run narrower than two columns is noise. */
function columnRuns(columnInk: Uint8Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < columnInk.length; x += 1) {
    if (columnInk[x] > 0) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= RUN_MIN_COLUMNS) runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0 && columnInk.length - start >= RUN_MIN_COLUMNS) {
    runs.push([start, columnInk.length - 1]);
  }
  return runs;
}

/** G3 — white low-saturation ink in the map panel, estimated at a stride (see `MAP_INK_STRIDE`). */
function panelInk(image: RgbaImage): number {
  const { data, width } = image;
  let count = 0;
  for (let y = 0; y < MAP_INK_H; y += MAP_INK_STRIDE) {
    const row = (MAP_INK_Y + y) * width;
    for (let x = 0; x < MAP_INK_W; x += MAP_INK_STRIDE) {
      const offset = (row + MAP_INK_X + x) * 4;
      if (lumaAt(data, offset) > MAP_INK_LUMA && saturationAt(data, offset) < MAP_INK_SAT) {
        count += 1;
      }
    }
  }
  return count * MAP_INK_STRIDE * MAP_INK_STRIDE;
}

/** G6 — does either axis show the floor's 36-px wall lattice? */
function latticePresent(image: RgbaImage): boolean {
  const { data, width } = image;
  const columns = new Float64Array(LATTICE_W);
  const rows = new Float64Array(LATTICE_H);

  for (let y = 0; y < LATTICE_H; y += LATTICE_STRIDE) {
    const row = (LATTICE_Y + y) * width;
    for (let x = 0; x < LATTICE_W; x += LATTICE_STRIDE) {
      const offset = (row + LATTICE_X + x) * 4;
      if (lumaAt(data, offset) <= LATTICE_INK_LUMA) continue;
      if (saturationAt(data, offset) >= LATTICE_INK_SAT) continue;
      columns[x] += 1;
      rows[y] += 1;
    }
  }

  // One axis is enough to say "the lattice is on this frame": the rule is to give the frame to the
  // map perceiver, so a partly drawn lattice must not become a 3-D view.
  return fitsLattice(columns, LATTICE_X) || fitsLattice(rows, LATTICE_Y);
}

/** Column/row centres of long lines, merging the one-pixel gaps a thin wall line can leave. */
function lineCentres(profile: Float64Array, origin: number): number[] {
  const centres: number[] = [];
  let start = -1;
  for (let i = 0; i <= profile.length; i += 1) {
    const lit = i < profile.length && profile[i] > LATTICE_LINE_MIN_INK;
    if (lit && start < 0) start = i;
    else if (!lit && start >= 0) {
      const bridged = i + 1 < profile.length && profile[i + 1] > LATTICE_LINE_MIN_INK;
      if (!bridged) {
        centres.push(origin + (start + i - 1) / 2);
        start = -1;
      }
    }
  }
  return centres;
}

/** Is this axis at least eight lines on a 36-px lattice, best phase, rms within 3.5 px? */
function fitsLattice(profile: Float64Array, origin: number): boolean {
  const centres = lineCentres(profile, origin);
  if (centres.length < LATTICE_MIN_LINES) return false;

  let best = Infinity;
  for (let phase = 0; phase < TILE_PX; phase += LATTICE_PHASE_STEP) {
    let sumSq = 0;
    for (const centre of centres) {
      const offset = centre - phase;
      const residual = offset - Math.round(offset / TILE_PX) * TILE_PX;
      sumSq += residual * residual;
    }
    const rms = Math.sqrt(sumSq / centres.length);
    if (rms < best) best = rms;
  }
  return best <= LATTICE_RMS_MAX;
}

// ---------------------------------------------------------------------------------------------
// The HUD anchor
// ---------------------------------------------------------------------------------------------

/** Bright low-saturation ink inside the minimap box: the panel's border, walls and glyphs. */
function minimapInk(image: RgbaImage): number {
  const { data, width } = image;
  let ink = 0;
  for (let y = 0; y < HUD_H; y += 1) {
    const row = (HUD_Y + y) * width;
    for (let x = 0; x < HUD_W; x += 1) {
      const offset = (row + HUD_X + x) * 4;
      if (lumaAt(data, offset) > HUD_INK_LUMA && saturationAt(data, offset) < HUD_INK_SAT) ink += 1;
    }
  }
  return ink;
}

/** The HUD is present; how much of the measured panel is actually drawn is the confidence. */
function confidenceOf(hudInk: number): number {
  const span = HUD_INK_STRONG - HUD_INK_FLOOR;
  const earned = Math.min(1, Math.max(0, (hudInk - HUD_INK_FLOOR) / span));
  return HUD_CONFIDENCE_MIN + (1 - HUD_CONFIDENCE_MIN) * earned;
}

// ---------------------------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------------------------

/** Rec. 601 luma, floored, matching the research's `(299R + 587G + 114B) / 1000`. */
function lumaAt(data: Uint8Array, offset: number): number {
  return ((data[offset] * 299 + data[offset + 1] * 587 + data[offset + 2] * 114) / 1000) | 0;
}

function saturationAt(data: Uint8Array, offset: number): number {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  return max - min;
}
