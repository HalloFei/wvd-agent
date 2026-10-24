/**
 * 3-D exploration-view perception: `HudPerceiver` names the screen the route opens the map *from*
 * (contracts §2 `dungeon`) — the party walking, the HUD up, no map open.
 *
 * It answers one question and refuses everything else. The 3-D view has a HUD (a minimap panel and a
 * 2×2 command grid in the frame's top-right corner); a black or uniform frame has nothing, a frame
 * that still shows the **map's structure** belongs to the map perceiver, and a frame without the
 * HUD's *structure* is not the walking view. So:
 *
 * - a black or uniform frame is `unknown` (contracts §2);
 * - the map gate must be **absent**: the readout's eight glyph runs (the decisive test — 0 of 198
 *   non-map frames produced eight), no white map ink at the map panel's density, no 36-px lattice;
 * - the **HUD structure** must be present, not merely bright ink in the right place: the bright ink
 *   must be a bounded minority of the minimap box (a filled block or a mostly-bright panel is not
 *   line work), and the 2×2 command grid beneath it must carry its four glyphs. Both are measured
 *   from `minimap-and-hud.jpg`.
 * - **the minimap's player arrow is the live layout's evidence.** In the FFXI zones the minimap is
 *   smaller and the command grid sits left of the measured cells, so the structure test fails on a
 *   real 3D view; the operator's rule is simpler: a minimap in the top-right corner means the
 *   dungeon. The saturated yellow arrow inside that corner measures 35 px in both 3D views and 0 on
 *   every other committed screen, so it is the fallback that names the live frame.
 *
 * Everything is measured from `testdata/nav-1024-0213/` and recorded in
 * `.superpowers/sdd/2026-10-24-wvd-world-v1/research-map-parser.md` (cited as "research §n"). The
 * numbers that report calls one-sample are named with that word in their comment and are never
 * presented as facts.
 *
 * Two rules shape the code:
 *
 * - **Slice before thresholding, and pay for the cheap test first.** A whole-frame pass costs ~85 ms
 *   on this machine (contracts §0.7 is a 50 ms half-tick), so the uniformity gate samples every
 *   fourth pixel (~130 k reads instead of 2 M) and the common 3-D frame then reads three small rects
 *   (the readout band, the map panel at a stride, the HUD area). The lattice rect is read only when
 *   the panel's ink says a map could be there.
 * - **Refusal is a first-class answer, and it has two strengths.** `unknown` at **confidence 0** is
 *   "nothing was drawn": a uniform or black frame, or a decode failure — the only case where the
 *   session classifier may stop (contracts §2). A frame this perceiver cannot name but that is
 *   plainly *not* flat — another size, the map's structure (the map perceiver's frame), or a busy
 *   screen that is not the 3-D view — is `unknown` at `UNNAMED_CONFIDENCE`: positive, so the loop
 *   escalates and asks a human, and below every act floor, so nothing is ever clicked on it. No path
 *   throws into the loop (contracts §0.6).
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
 * A uniform or black frame is `unknown` with confidence 0 (contracts §2). Measured the way the map
 * parser measures it (research §1, §10 step 0): mean and standard deviation over every fourth pixel
 * on both axes — the research's full pass is ~85 ms, this is the same answer for a flat frame and
 * stays inside the half-tick. A flat field is refused *before* the map gate, so a uniform frame at a
 * luma above the HUD's ink threshold cannot be read as a minimap.
 */
const UNIFORM_SAMPLE_STRIDE = 4;
const UNIFORM_STD = 6;
const UNIFORM_MEAN = 8;

/**
 * G1 — the coordinate readout `X: n  Y: n`, the map's decisive structural gate (research §3).
 *
 * The same measured fact the map parser uses, declared here instead of imported (contracts §0.1: a
 * module imports contracts and its own files). It is a *structure* test, not a brightness test: the
 * HUD frame has bright pixels inside this rect (the 3-D scene shows through) yet only two runs; the
 * map has eight, at these fixed x positions. 0 of 198 non-map frames produced eight.
 *
 * The map parser also checks the four digit runs' widths (3–10 px) before it *reads* them; this gate
 * deliberately does not. For a recogniser whose job is to hand the map's frame to the map perceiver,
 * the weaker gate is the safe direction: it can only add frames to `unknown` (a wait), never turn a
 * frame into `dungeon` (a click), whereas a stricter gate could miss a real map and let the route
 * press the map key on the map screen. The run count and the two label anchors are the structural
 * core; the digit widths validate glyphs this gate never reads.
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
 * G3 — white map ink in the panel: from 15 000 px up over 26 map frames against 198 non-map frames
 * (research §1). Read at a stride: the count is an estimate, scaled back by the stride squared. The
 * HUD fixture is three orders of magnitude below the floor (≈1 200 against ≈35 000 for the map), so
 * the estimate's noise cannot move the decision.
 *
 * Only the floor is used here. The map parser's 200 000-px ceiling rejects desktop captures, but a
 * recogniser for the *walking* view must not refuse a legitimately bright 3-D scene: with the HUD
 * structure required below, a flash or a washed-out frame is already refused, and a bright frame that
 * still carries the HUD is the 3-D view. "Not stricter than the parser" cuts both ways; this is the
 * direction where a wrong answer costs a wait instead of a click.
 */
const MAP_INK_X = 480;
const MAP_INK_Y = 150;
const MAP_INK_W = 1220;
const MAP_INK_H = 750;
const MAP_INK_LUMA = 185;
const MAP_INK_SAT = 60;
const MAP_INK_MIN = 15_000;
const MAP_INK_STRIDE = 4;

/**
 * G6 — the floor's 36-px wall lattice: at least eight long white lines, best fit within the map
 * parser's pitch range (35.5–36.5 px, step 0.05) and rms ≤ 3.5 px (research §5, §8 item 5).
 *
 * The pitch is *searched*, not pinned at the measured 36.0, and this is deliberate: a recogniser
 * whose job is refusing maps must not be stricter than the parser that reads them, or a map whose
 * best fit sits away from 36.0 would be called the 3-D view and the route would press the map key on
 * the map screen. Only the phase is a per-frame unknown (the canvas scrolls, research §5). The
 * profiles are sampled at a stride; the research's 100-lit-px line floor is therefore halved. This
 * check runs only when G3 is at map-panel density, i.e. almost never on a 3-D frame.
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
const PITCH_MIN = 35.5;
const PITCH_MAX = 36.5;
const PITCH_STEP = 0.05;
const LATTICE_PHASE_STEP = 0.1;
const LATTICE_RMS_MAX = 3.5;

/**
 * The HUD anchor — **one sample**: the minimap box at x 1761–1901, y 18–168 and the 2×2 command grid
 * at x 1761–1901, y 185–255, measured on `minimap-and-hud.png` and cross-checked against
 * `navigation-design.md` §3a (the `↻` resume control at (1824, 196), which agrees with §3a's
 * (1825, 195)). The panel is opaque: the 3-D scene does not show through it, which is what makes ink
 * inside it mean "HUD", not "bright scene".
 *
 * Brightness alone is not the evidence, because a bright rectangle in this box would satisfy it. Two
 * measurements make it structural instead:
 *
 * - **ink density.** The box is a dark surface carrying line work: 78.7 % of it is dark (L < 100) and
 *   only 12.5 % is bright ink (L > 150 ∧ sat < 60), drawn across every row. A filled block is ~100 %
 *   ink and a mostly-bright panel is above a third; both are refused by the density bound. The bright
 *   shapes are the floor plan's walls, not a chrome border — there is no bright border in the sample,
 *   so "the border runs" is not a structure this fixture offers.
 * - **the 2×2 command grid** beneath the panel: four cells whose glyphs measure 82 / 107 / 157 / 157
 *   bright px. A stray bright shape in the box has nothing there.
 */
const HUD_X = 1761;
const HUD_Y = 18;
const HUD_W = 140;
const HUD_H = 150;
const HUD_INK_LUMA = 150;
const HUD_INK_SAT = 60;
/** The panel is a dark surface with a minority of ink: 0.125 measured; a filled block is 1.0. */
const HUD_INK_FRACTION_MAX = 0.35;
/** Brightness pre-filter: without any ink there is no HUD (the panel's own border is ≈320 px). */
const HUD_INK_FLOOR = 300;
/** The level at which the panel is unmistakably drawn: half the sample's 2 629 ink. */
const HUD_INK_STRONG = 1_200;

/** The 2×2 command grid below the minimap: its four cells, each carrying a glyph (one sample). */
const GRID_X = 1761;
const GRID_Y = 185;
const GRID_W = 140;
const GRID_H = 70;
/** Measured cells: 82 / 107 / 157 / 157 bright px; 40 requires half of the weakest. One sample. */
const GRID_QUADRANT_MIN_INK = 40;

/**
 * Confidence is evidence strength, and it is deliberately compressed into [0.8, 1] once the HUD
 * structure is there: below the ink floor there is no HUD, and at the measured panel level the
 * evidence is as strong as this perceiver can make it. The calibration is this module's own choice —
 * unlike the map parser's floors, it is not a measured fact — so it is named here and reported.
 * Every dungeon observation therefore clears the route's 0.5 act floor (contracts §6, §2).
 */
const HUD_CONFIDENCE_MIN = 0.8;

/**
 * **Something is on the screen and this perceiver cannot name it.**
 *
 * The uniformity gate above answers "nothing is drawn". Between that and "I know what this is" there
 * is a third case the session classifier must be able to tell apart (contracts §2, Task 10 review
 * Critical 1): a battle, a loading screen, the opener panel, a menu — a frame that is *busy* and
 * therefore not black. Reporting it at confidence 0 says "nothing was perceived", which the
 * classifier must turn into a `stop`; that ends the run on the first fight or floor transition.
 *
 * So a non-uniform frame this perceiver cannot name is `unknown` at this confidence: positive, so a
 * session **escalates** and asks Coo to look at it, and far below every act floor (0.5), so it can
 * never become a `dungeon` and a click on it. `unknown` at **confidence 0** is reserved for a
 * uniform or black frame and for a frame that could not be decoded at all — the two cases where
 * there really is nothing to look at.
 */
export const UNNAMED_CONFIDENCE = 0.2;

/**
 * The minimap's player arrow, in the top-right corner: R>160, G>130, B<110, R−B>60, G−B>40.
 * Measured 2026-10-24: 35 px on `view-empty-minimap.jpg` and `view.jpg`; 0 px on the town, the
 * world map, Dungeon Select, the dungeon map, combat, the chest prompt and the third-zone map. The
 * corner rect is wider and taller than either minimap so a smaller FFXI panel still lands inside.
 */
const MINIMAP_CORNER = { x: 1_700, y: 0, width: 220, height: 220 } as const;
const MINIMAP_ARROW_MIN = 8;
const MINIMAP_CONFIDENCE = 0.8;

// ---------------------------------------------------------------------------------------------
// The perceiver
// ---------------------------------------------------------------------------------------------

/**
 * Names the 3-D exploration view, and says "something is drawn but not named" when it cannot.
 *
 * Two answers, never three: `dungeon` above the route's act floor, or `unknown`. The confidence on
 * `unknown` is the whole point (compare `UNNAMED_CONFIDENCE`): **0 means nothing was drawn** — a
 * uniform or black frame, or a frame that could not be decoded — while a positive confidence means
 * the frame is busy and this perceiver does not recognise it, which is a question for a human, not
 * a reason to end the session.
 *
 * The steps are the research's refusal order, each one reading the smallest rect that can answer:
 * uniformity, size, the readout structure, the panel's ink mass, the wall lattice, then the HUD.
 */
export class HudPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      // Failure is a value (contracts §0.6): a decode failure is "not observed", not a throw.
      return nothingAt(frame.atMs);
    }

    // 0. A black or uniform frame is `unknown` at confidence 0, never a minimap (contracts §2). --
    // This runs before the size gates because it reads the decoded image's own geometry: a flat
    // frame is "nothing drawn" whatever size it declares.
    const { data, width, height } = image;
    if (isUniform(data, width, height)) return nothingAt(frame.atMs);

    // 1. Size, from the frame's declared dimensions (contracts §0.5) ----------------------------
    // The rects are indexed against the decoded pixels, so they must be the frame the contract
    // describes; a source that hands back another size is unsupported, not re-scaled. It is still
    // *a frame with something on it*, so it earns the unnamed confidence rather than a 0.
    if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) return unnamed(frame.atMs);
    if (width !== frame.width || height !== frame.height) return unnamed(frame.atMs);

    // 2. G1: the readout's eight runs — the map's decisive structure, and the map's frame. ------
    if (readoutPresent(image)) return unnamed(frame.atMs);

    // 3. G3 + G6: the map panel's white ink and, at map density, its wall lattice. --------------
    const panelInkPx = panelInk(image);
    if (panelInkPx >= MAP_INK_MIN && latticePresent(image)) return unnamed(frame.atMs);

    // 4. The HUD's structure must be there — a scene, or a bright rectangle, is not a screen. ---
    const hudInk = minimapInk(image);
    if (hudStructure(hudInk, image)) {
      return { screen: 'dungeon', atMs: frame.atMs, confidence: confidenceOf(hudInk) };
    }
    // The live FFXI view: the structure's fixed cells do not fit, but the minimap's arrow is there.
    if (minimapArrow(image) >= MINIMAP_ARROW_MIN) {
      return { screen: 'dungeon', atMs: frame.atMs, confidence: MINIMAP_CONFIDENCE };
    }
    return unnamed(frame.atMs);
  }
}

/** Nothing was drawn at all: the one refusal that may end a session (contracts §2). */
function nothingAt(atMs: number): Observation {
  return { screen: 'unknown', atMs, confidence: 0 };
}

/** Something is drawn and this perceiver cannot name it: ask, do not stop (see `UNNAMED_CONFIDENCE`). */
function unnamed(atMs: number): Observation {
  return { screen: 'unknown', atMs, confidence: UNNAMED_CONFIDENCE };
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
 *   carry white ink (research §1: 0–869 655 over 198 frames), so the ink alone never decides; at
 *   map density the lattice is read;
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

/**
 * Is this axis at least eight lines on a 36-px lattice — the map parser's own pitch sweep
 * (35.5–36.5 px), best phase, rms within 3.5 px? The sweep is the parser's, not narrower: a
 * recogniser whose answer hands the frame to that parser must not be stricter than it, or a real
 * map whose best fit sits away from 36.0 would be read as the 3-D view.
 */
function fitsLattice(profile: Float64Array, origin: number): boolean {
  const centres = lineCentres(profile, origin);
  if (centres.length < LATTICE_MIN_LINES) return false;

  let best = Infinity;
  const pitchSteps = Math.round((PITCH_MAX - PITCH_MIN) / PITCH_STEP);
  for (let step = 0; step <= pitchSteps; step += 1) {
    const pitch = PITCH_MIN + step * PITCH_STEP;
    const phaseSteps = Math.floor(pitch / LATTICE_PHASE_STEP);
    for (let phaseStep = 0; phaseStep <= phaseSteps; phaseStep += 1) {
      const phase = phaseStep * LATTICE_PHASE_STEP;
      let sumSq = 0;
      for (const centre of centres) {
        const residual = centre - (phase + Math.round((centre - phase) / pitch) * pitch);
        sumSq += residual * residual;
      }
      const rms = Math.sqrt(sumSq / centres.length);
      if (rms < best) best = rms;
    }
  }
  return best <= LATTICE_RMS_MAX;
}

// ---------------------------------------------------------------------------------------------
// The HUD structure
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

/**
 * Is the HUD really drawn? Brightness is only the cheap pre-filter: a bright rectangle in this box
 * would pass it. The evidence is the structure the fixture shows — sparse line work on a dark panel,
 * with the 2×2 command grid beneath it — so a block of brightness fails the density bound and a stray
 * patch fails the grid.
 */
function hudStructure(hudInk: number, image: RgbaImage): boolean {
  // Cheapest first: without bright ink there is no HUD at all (a black or faded frame).
  if (hudInk < HUD_INK_FLOOR) return false;
  // Line work, not a block: a filled block or a mostly-bright panel is far above the measured 12.5 %.
  if (hudInk > HUD_INK_FRACTION_MAX * HUD_W * HUD_H) return false;
  // The 2×2 command grid below the minimap: four cells, each carrying a glyph.
  return commandGridPresent(image);
}

/** The four cells of the command grid; each must carry bright ink (one sample: 82 / 107 / 157 / 157). */
function commandGridPresent(image: RgbaImage): boolean {
  const { data, width } = image;
  const halfW = GRID_W / 2;
  const halfH = GRID_H / 2;
  const cells = [0, 0, 0, 0];
  for (let y = 0; y < GRID_H; y += 1) {
    const row = (GRID_Y + y) * width;
    const cellRow = y < halfH ? 0 : 2;
    for (let x = 0; x < GRID_W; x += 1) {
      const offset = (row + GRID_X + x) * 4;
      if (lumaAt(data, offset) <= HUD_INK_LUMA) continue;
      if (saturationAt(data, offset) >= HUD_INK_SAT) continue;
      cells[cellRow + (x < halfW ? 0 : 1)] += 1;
    }
  }
  return cells.every((count) => count >= GRID_QUADRANT_MIN_INK);
}

/** The minimap's saturated yellow player arrow in the top-right corner. */
function minimapArrow(image: RgbaImage): number {
  const { data, width } = image;
  let count = 0;
  for (let y = MINIMAP_CORNER.y; y < MINIMAP_CORNER.y + MINIMAP_CORNER.height; y += 1) {
    const row = y * width;
    for (let x = MINIMAP_CORNER.x; x < MINIMAP_CORNER.x + MINIMAP_CORNER.width; x += 1) {
      const offset = (row + x) * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      if (r > 160 && g > 130 && b < 110 && r - b > 60 && g - b > 40) count += 1;
    }
  }
  return count;
}

/** The HUD structure is present; how densely the panel is drawn is the confidence. */
function confidenceOf(hudInk: number): number {
  const span = HUD_INK_STRONG - HUD_INK_FLOOR;
  const earned = Math.min(1, Math.max(0, (hudInk - HUD_INK_FLOOR) / span));
  return HUD_CONFIDENCE_MIN + (1 - HUD_CONFIDENCE_MIN) * earned;
}

// ---------------------------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------------------------

/** A flat or black frame: mean and standard deviation over a strided sample (research §10 step 0). */
function isUniform(data: Uint8Array, width: number, height: number): boolean {
  let sum = 0;
  let sumSq = 0;
  let samples = 0;
  for (let y = 0; y < height; y += UNIFORM_SAMPLE_STRIDE) {
    const row = y * width;
    for (let x = 0; x < width; x += UNIFORM_SAMPLE_STRIDE) {
      const value = lumaAt(data, (row + x) * 4);
      sum += value;
      sumSq += value * value;
      samples += 1;
    }
  }
  const mean = sum / samples;
  const variance = sumSq / samples - mean * mean;
  return Math.sqrt(Math.max(0, variance)) < UNIFORM_STD || mean < UNIFORM_MEAN;
}

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
