/**
 * Chest perception: `parseQte` reads the QTE bar's geometry and the 解除 control from one frame, or
 * refuses with a named reason.
 *
 * Every number here was measured from `testdata/chest/2026-10-24-qte-0141/` (six stills) and the
 * 250-frame `…-qte-recorded/qte.mp4`, and is recorded in `.superpowers/sdd/2026-10-24-wvd-world-v1/
 * research-qte-parser.md`, cited as "research §n". The values are not re-derived here; numbers the
 * research calls one-sample are named with that word in their comment.
 *
 * **The opener panel lives in `opener.ts`**, which owns the fixed card grid, the per-slot read and
 * the click point; `ChestPerceiver` only orders the two screens, the panel before the bar.
 *
 * The order is safe in one direction only: the panel gates on a **dark modal band with the title's
 * glyph ink and the cards' full-width bottom borders** at fixed rows, and the QTE bar lives in rows
 * 36–82 of a different part of the frame, so a bar frame cannot satisfy a card grid. Trying the bar
 * first would be the unsafe order: an untrapped chest has no bar at all (chest §3a), and a bar-frame
 * "no-bar" refusal is the cheap answer that must not mask a panel.
 *
 * Two rules shape the code:
 *
 * - **Slice before thresholding.** Only the 47-row band (47 × 631 px) and the button window are
 *   read, never the 2 073 600-pixel frame: a whole-frame mask pass measured 85 ms against 0.8 ms
 *   for the slices, and observe() must fit the 50 ms half-tick (contracts §0.7). The masks are
 *   built in one pass over the band; the button window is read only once the zones located it.
 * - **Refusal is a first-class answer.** Every measured gate that fails returns a reason, never a
 *   partial `QteState` (research §10). This is the whole point of the parser: the earlier hand
 *   attempt's failure mode was not a refusal but *plausible garbage* — the wall read as a zone and
 *   the chest's gold highlight as the button.
 *
 * `attempts` is always `null`: the counter has only ever been seen as the numeral 3 (research §7),
 * and the contract makes the field nullable precisely so that an unvalidated OCR can stay absent.
 *
 * Geometry: 1920×1080 device pixels. Another size is unsupported, not re-scaled (contracts §0.5).
 * A sample may instead be the single crop `qteWindow` names — the bar's band and the button's annulus
 * in one rectangle — and `parseQte` then takes that rectangle's origin and still answers in full-frame
 * device pixels, so a caller never does the offset arithmetic itself.
 */
import type { Frame, Observation, Perceiver, PixelRect, Point, QteState, RgbaImage } from '../contracts.ts';
import { parseOpenerDetailed } from './opener.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/** The only frame size the fixed anchors were measured at (research §1, §14). */
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/**
 * The bar's horizontal clip and the fixed y band, as fractions of the frame (research §1).
 *
 * Y is stable — the band read (36, 82) in 199 of 199 parsed frames and in all six stills — so it is
 * a verified anchor, never a search. X is clipped to 645…1275: with the window removed, the lit
 * wall's specular highlights form 126–148 px warm runs on four frames and pass every shape test.
 * The window is the defence; the zone-width range below is only a sanity check (research §4).
 */
const BAR_X0_FRACTION = 0.336; // 645
const BAR_X1_FRACTION = 0.664; // 1275
const ZONE_WINDOW_X0_FRACTION = 0.354; // 680 — the row profile's zone-only window
const ZONE_WINDOW_X1_FRACTION = 0.646; // 1240
const BAND_Y0_FRACTION = 0.0333; // 36
const BAND_ROWS = 47; // 36..82 inclusive

/**
 * The three colour rules (research §2), computed on the band slice and the button window:
 * `warm` is zone fill, `white` is the marker's core (and nothing else once the width floor is in
 * place), `pale` is the button's hand glyph.
 */
const WARM_R_MIN = 230;
const WARM_RB_MIN = 140;
const WARM_G_MIN = 110;
const WHITE_MIN = 225;
/** Redundant at 225 (all three channels ≥ 225 already bounds R−B by 30); kept as a guard (§2). */
const WHITE_RB_MAX = 40;
const PALE_LUMA_MIN = 165;
const PALE_RB_MAX = 60;
const PALE_RG_MAX = 45;

/**
 * The bar is present when one band row has this many warm pixels inside the zone window. With the
 * bar: 448–492. Without: 0–10 (research §3 step 4, §4 last paragraph).
 */
const BAR_PEAK_MIN = 250;

/**
 * Marker gate (research §5). The core is 6–9 px wide and 30–34 rows tall; 18 white rows per column
 * and a 6 px width floor are what separate it from the zone border columns at the hazard gap's
 * ends (1 px wide, 35–42 rows tall). A floor of 18 px — the earlier hand attempt — finds nothing.
 */
const MARKER_COLUMN_MIN_ROWS = 18;
const MARKER_MIN_WIDTH = 6;
const MARKER_MAX_WIDTH = 26;
const MARKER_MIN_HEIGHT = 18;
const MARKER_MAX_HEIGHT = BAND_ROWS - 5;
/**
 * Two-frame elimination is a cross-check, not a load path: single-frame detection found exactly one
 * candidate in all 199 parsed frames (research §5). When a second candidate appears, the one within
 * 6 px of the previous frame's marker is the static run.
 */
const MARKER_STATIC_DROP_PX = 6;

/**
 * Zone gate (research §4). A zone column is warm in 44–47 of 47 band rows and a gap column in 0, so
 * the 55 % threshold sits in a wide margin. The width range is deliberately permissive (120, not
 * the spec's 150): both measured chests are 224–225 px, the ends of the range were never observed,
 * and the x window — not this range — is what keeps the wall out. The gap's bounds are the spec's
 * measured 40–140 px reading of a 78–80 px hazard gap.
 */
const ZONE_ROW_FRACTION = 0.55;
const ZONE_MIN_WIDTH = 120;
const ZONE_MAX_WIDTH = 340;
const GAP_MIN_WIDTH = 40;
const GAP_MAX_WIDTH = 140;
/**
 * The marker is white, so it punches a 13–17 px hole in the warm fill; a real hazard gap is
 * 78–80 px, so a hole this narrow cannot be one. Bridging is load bearing: without it, refusals on
 * the recording rise from 51 to 81 (research §4).
 */
const MARKER_HOLE_MAX_WIDTH = 20;
const MARKER_HOLE_SLACK_PX = 6;
/** Gap luma over zone luma; a bright bridge (the light beam crossing the gap) is not a bar. */
const GAP_LUMA_RATIO_MAX = 0.75;

/**
 * The 解除 control is anchored, not searched (research §6). Its x is the bar's centre between the
 * two zones; its y is the fixed HUD slot. A colour search for it lands on the chest's gold
 * highlight at y ≈ 553 — a measured 109 px error — or on the pale HUD icon row 125 px below.
 */
const BUTTON_Y_FRACTION = 0.613; // 662 at 1080
const BUTTON_BOX_HALF_WIDTH = 31;
const BUTTON_BOX_HALF_HEIGHT = 46;
/** Annulus radii beyond the box on every side, so a uniformly bright background scores ≈ 0. */
const BUTTON_ANNULUS_INNER = 52;
const BUTTON_ANNULUS_OUTER = 72;
/** Contrast = mean(box) − mean(annulus) in luma. Live: 66–73; dimmed: 20–32; gone: −6…−4. */
const BUTTON_ON_SCREEN_CONTRAST = 10;
const BUTTON_ENABLED_CONTRAST = 55;
/** The hand glyph's pale pixel count; 3107–3177 live, 0–83 dimmed. */
const BUTTON_ENABLED_PALE = 2_000;

/** Confidence deductions, each with measured evidence (research §9). They sum to 0.5. */
const CONFIDENCE_MARKER_MIN_WIDTH = 7;
const CONFIDENCE_MARKER_MIN_HEIGHT = 28;
const CONFIDENCE_MARKER = 0.15;
const CONFIDENCE_ZONE_WIDTH = 0.1;
const CONFIDENCE_NARROW_GAP = 0.05;
const CONFIDENCE_DISABLED_BUTTON = 0.2;

// ---------------------------------------------------------------------------------------------
// The QTE window
// ---------------------------------------------------------------------------------------------

/**
 * The rectangle one QTE sample needs, in the frame's own device pixels: the bar's clipped band and
 * the 解除 control's annulus. It is derived from the measured fractions, never from four numbers
 * typed in a second place, and it scales with the frame it is asked about.
 *
 * The button is inside the rectangle on purpose, although it sits 580 rows below the band and is read
 * only after the zones located it. **One rectangle means one parser and one set of refusals**: the
 * crop can still answer `no-bar`, `no-marker`, `no-zones`, `bad-gap`, `gap-not-dark` and `no-button`,
 * so the World never has to fall back to a full frame and `parseQte` never has to ask what a sample
 * contains. The lower edge is the price: 631 × 699 = 21.3 % of a 1080p frame rather than the band's
 * 1.4 %, and still cheap enough to take three times a pass (contracts §0.7).
 */
export function qteWindow(frame: { width: number; height: number }): PixelRect {
  const x = Math.round(BAR_X0_FRACTION * frame.width);
  const x1 = Math.round(BAR_X1_FRACTION * frame.width);
  const y = Math.round(BAND_Y0_FRACTION * frame.height);
  // Both far edges are inclusive pixels: the bar's right clip, and the annulus's lowest row.
  const bottom = Math.round(BUTTON_Y_FRACTION * frame.height) + BUTTON_ANNULUS_OUTER;
  return { x, y, width: x1 - x + 1, height: bottom - y + 1 };
}

/** The only size a crop may be: the QTE window of the frame size the anchors were measured at. */
function referenceWindow(): PixelRect {
  return qteWindow({ width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT });
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/**
 * Why a frame was refused. The names are the research's §10 scan of the recording, plus
 * `decode-failed` for contracts §0.6's failure-is-a-value rule (a frame that cannot be decoded has
 * no place in that table, but it must still be a value, not a throw). `contracts.ts` is closed, so
 * this union lives here.
 */
export type QteRefusalReason =
  | 'unsupported-size'
  | 'no-bar'
  | 'no-marker'
  | 'multi-marker'
  | 'no-zones'
  | 'bad-gap'
  | 'gap-not-dark'
  | 'no-button'
  | 'decode-failed';

/**
 * What the parser returns: a `QteState` the caller can plan against, or a named refusal. `enabled`
 * is a parser diagnostic rather than a contract field — `QteState` has no place for it, and the
 * policy needs it to tell a live pass from a resolved one (research §6).
 */
export type QteParse =
  | {
      readonly ok: true;
      readonly qte: QteState;
      readonly confidence: number;
      readonly enabled: boolean;
    }
  | { readonly ok: false; readonly reason: QteRefusalReason };

/**
 * Where the pixels being read sit in the full frame. The fractions' denominators are the **full
 * frame's** size — a crop is 631 × 699, so its own width would re-scale every anchor — and `origin`
 * is the crop's top-left in frame pixels. A full frame is its own size at origin (0, 0).
 */
interface FrameGeometry {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly origin: Point;
}

/** A frame that is not a crop: its own coordinates are the frame's. */
const FRAME_ORIGIN: Point = { x: 0, y: 0 };

interface BandScan {
  /** The band's first column in full-frame pixels; the column arrays are indexed from there. */
  readonly x0: number;
  readonly columns: number;
  /** Band rows that are warm, per column: the zone profile. */
  readonly columnWarm: Uint16Array;
  /** Band rows that are white, per column: the marker profile. */
  readonly columnWhite: Uint16Array;
  /** Summed luma per column: the gap-darkness test. */
  readonly columnLuma: Uint32Array;
  /** Warm pixels per band row inside the zone window: the bar-presence test. */
  readonly rowWarm: Uint16Array;
  /** First and last white band row per column (−1 when the column has none). */
  readonly whiteTop: Int16Array;
  readonly whiteBottom: Int16Array;
}

interface MarkerCandidate {
  readonly x0: number;
  readonly x1: number;
  readonly width: number;
  readonly height: number;
  /** Half-pixel resolution: the measured core centre (research §5). */
  readonly centreX: number;
}

interface ButtonReading {
  readonly point: Point;
  readonly onScreen: boolean;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------------

/**
 * Read the QTE bar out of one frame.
 *
 * `previousMarkerX` is the last parsed frame's marker centre. It is used only to drop a static
 * white run when two candidates appear — belt and braces, never a load path (research §5). Pass
 * `undefined` when there is no previous frame.
 *
 * `origin` says the frame is a crop of a full frame at that point — what `qteWindow` asked the
 * engine for. The frame must then be exactly the window's size, and every number returned stays in
 * full-frame device pixels. Without `origin` the frame must be a whole 1920 × 1080 frame: a crop is
 * never read as one, and a full frame is never accepted as a crop.
 */
export async function parseQte(
  frame: Frame,
  previousMarkerX?: number,
  origin?: Point,
): Promise<QteParse> {
  // Dimensions come from the frame (contracts §0.5), and a foreign size is refused before its
  // decode is paid for: a 1080p JPEG costs ~190 ms here, more than the whole half-tick.
  if (origin) {
    const window = referenceWindow();
    if (frame.width !== window.width || frame.height !== window.height) {
      return { ok: false, reason: 'unsupported-size' };
    }
  } else if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) {
    return { ok: false, reason: 'unsupported-size' };
  }
  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch {
    // Failure is a value (contracts §0.6): an undecodable frame is "not observed", not a throw.
    return { ok: false, reason: 'decode-failed' };
  }
  return parseImage(image, previousMarkerX, origin);
}

function parseImage(image: RgbaImage, previousMarkerX?: number, origin?: Point): QteParse {
  const { data, width, height } = image;
  // A crop is judged by the window's size and a full frame by the anchors' size; neither is ever
  // read as the other, and neither is re-scaled (contracts §0.5).
  const expected = origin ? referenceWindow() : { width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT };
  if (width !== expected.width || height !== expected.height) {
    return { ok: false, reason: 'unsupported-size' };
  }

  // The fractions keep the full frame's denominators; `origin` moves only the reads, so the offsets
  // below subtract it from an absolute anchor. A full frame is at its own origin.
  const geometry: FrameGeometry = origin
    ? { frameWidth: REFERENCE_WIDTH, frameHeight: REFERENCE_HEIGHT, origin }
    : { frameWidth: width, frameHeight: height, origin: FRAME_ORIGIN };

  // 1. One pass over the band: the three profiles, the row profile and the marker's extents. -----
  const band = scanBand(image, geometry);

  // 2. The bar's row profile. Refusing here is what makes "the QTE screen is gone" immediate. ---
  let peak = 0;
  for (const count of band.rowWarm) if (count > peak) peak = count;
  if (peak < BAR_PEAK_MIN) return { ok: false, reason: 'no-bar' };

  // 3. The marker. ---------------------------------------------------------------------------
  const marker = findMarker(band, previousMarkerX);
  if (!marker.ok) return marker;

  // 4. The zones, bridging the hole the marker punched *before* the width filter: the hole splits
  //    a zone into a wide piece and a narrow one, and filtering first would drop the narrow piece
  //    and turn the bridge into a fake 148 px gap (research §4).
  const runs = bridgeMarkerHole(warmRuns(band), marker.marker).filter((run) => {
    const width = run.to - run.from + 1;
    return width >= ZONE_MIN_WIDTH && width <= ZONE_MAX_WIDTH;
  });
  if (runs.length !== 2) return { ok: false, reason: 'no-zones' };
  const [left, right] = runs;

  // 5. The gap between them. ------------------------------------------------------------------
  const gap = right.from - left.to - 1;
  if (gap < GAP_MIN_WIDTH || gap > GAP_MAX_WIDTH) return { ok: false, reason: 'bad-gap' };
  if (gapLumaRatio(band, left, right) > GAP_LUMA_RATIO_MAX) return { ok: false, reason: 'gap-not-dark' };

  // 6. The 解除 control: anchored from the zones, then verified. -------------------------------
  const button = readButton(data, width, height, left, right, geometry);
  if (!button.onScreen) return { ok: false, reason: 'no-button' };

  // 7. Confidence: a claim about whether a timed tap can trust these two centres. --------------
  let confidence = 1;
  if (
    marker.marker.width < CONFIDENCE_MARKER_MIN_WIDTH ||
    marker.marker.height < CONFIDENCE_MARKER_MIN_HEIGHT
  ) {
    confidence -= CONFIDENCE_MARKER;
  }
  if (Math.abs(left.to - left.from - (right.to - right.from)) > 2) confidence -= CONFIDENCE_ZONE_WIDTH;
  if (gap < 50) confidence -= CONFIDENCE_NARROW_GAP;
  if (!button.enabled) confidence -= CONFIDENCE_DISABLED_BUTTON;

  const qte: QteState = {
    zones: [
      { from: left.from, to: left.to },
      { from: right.from, to: right.to },
    ],
    markerX: marker.marker.centreX,
    button: button.point,
    attempts: null,
  };
  return { ok: true, qte, confidence: Math.max(0, confidence), enabled: button.enabled };
}

/**
 * A panel the gates recognised but whose ranking fields could not be read: something *is* drawn (the
 * modal, the title, the cards), so this is not the blank-frame `unknown` at confidence 0 that ends a
 * session. 0.3 is below the route's 0.5 act floor, so nothing is clicked, and positive, so the
 * session classifier escalates for a human instead of stopping. `unknown` at 0 stays the answer for
 * a frame that is simply not a chest screen.
 */
const REFUSED_PANEL_CONFIDENCE = 0.3;

/**
 * A `Perceiver` over the chest screens. **The opener panel is tried first**, then the QTE bar; a
 * frame that is neither is `unknown` (contracts §2: something drawn, nothing named).
 *
 * The order is safe because the two parsers' anchors cannot both fire: the panel needs the modal's
 * dark band, the title's glyph ink and the cards' full-width borders at fixed rows, and the bar lives
 * in rows 36–82 with its own warm/white/gap structure (see the module header). It is also the only
 * workable order — a chest with no trap goes from the panel straight to loot (chest §3a), so the loop
 * must act while the bar may never exist.
 */
export class ChestPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const opener = await parseOpenerDetailed(frame);
    if (opener.ok) {
      return { screen: 'chest-open', atMs: frame.atMs, confidence: 1, opener: opener.panel };
    }
    if (opener.reason === 'unreadable') {
      // A recognised panel whose 陷阱 numerals or card layout cannot be read: escalate, never fall
      // through to the bar (an untrapped chest has none) and never click a roster it cannot rank.
      return { screen: 'unknown', atMs: frame.atMs, confidence: REFUSED_PANEL_CONFIDENCE };
    }
    const parsed = await parseQte(frame);
    if (!parsed.ok) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    return {
      screen: 'chest-qte',
      atMs: frame.atMs,
      confidence: parsed.confidence,
      qte: parsed.qte,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------------------------

/**
 * One pass over rows 36–82 × 645–1275, in the pixels `image` actually holds: 29 657 pixels, 2.2 % of
 * a 1080p frame. The anchors come from the full frame's fractions and `geometry.origin` moves them
 * into a crop; the returned `x0` is the absolute column, so every consumer below stays in
 * full-frame coordinates.
 */
function scanBand(image: RgbaImage, geometry: FrameGeometry): BandScan {
  const { data, width } = image;
  const x0 = Math.round(BAR_X0_FRACTION * geometry.frameWidth);
  const x1 = Math.round(BAR_X1_FRACTION * geometry.frameWidth);
  const y0 = Math.round(BAND_Y0_FRACTION * geometry.frameHeight);
  const zoneX0 = Math.round(ZONE_WINDOW_X0_FRACTION * geometry.frameWidth);
  const zoneX1 = Math.round(ZONE_WINDOW_X1_FRACTION * geometry.frameWidth);
  const columns = x1 - x0 + 1;
  // The same three edges inside the buffer being read: zero for a full frame.
  const localX0 = x0 - geometry.origin.x;
  const localX1 = x1 - geometry.origin.x;
  const localY0 = y0 - geometry.origin.y;

  const columnWarm = new Uint16Array(columns);
  const columnWhite = new Uint16Array(columns);
  const columnLuma = new Uint32Array(columns);
  const whiteTop = new Int16Array(columns).fill(-1);
  const whiteBottom = new Int16Array(columns).fill(-1);
  const rowWarm = new Uint16Array(BAND_ROWS);

  for (let bandRow = 0; bandRow < BAND_ROWS; bandRow += 1) {
    const rowOffset = (localY0 + bandRow) * width;
    for (let x = localX0; x <= localX1; x += 1) {
      const offset = (rowOffset + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const column = x - localX0;

      columnLuma[column] += (77 * r + 150 * g + 29 * b) >> 8;

      if (r >= WARM_R_MIN && r - b >= WARM_RB_MIN && g >= WARM_G_MIN) {
        columnWarm[column] += 1;
        const absoluteX = x + geometry.origin.x;
        if (absoluteX >= zoneX0 && absoluteX < zoneX1) rowWarm[bandRow] += 1;
      }

      if (r >= WHITE_MIN && g >= WHITE_MIN && b >= WHITE_MIN && Math.abs(r - b) <= WHITE_RB_MAX) {
        columnWhite[column] += 1;
        if (whiteTop[column] < 0) whiteTop[column] = bandRow;
        whiteBottom[column] = bandRow;
      }
    }
  }

  return { x0, columns, columnWarm, columnWhite, columnLuma, rowWarm, whiteTop, whiteBottom };
}

// ---------------------------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------------------------

function findMarker(
  band: BandScan,
  previousMarkerX: number | undefined,
): { ok: true; marker: MarkerCandidate } | { ok: false; reason: QteRefusalReason } {
  const candidates: MarkerCandidate[] = [];
  let start = -1;
  for (let column = 0; column <= band.columns; column += 1) {
    const lit = column < band.columns && band.columnWhite[column] >= MARKER_COLUMN_MIN_ROWS;
    if (lit && start < 0) start = column;
    else if (!lit && start >= 0) {
      const end = column - 1;
      const width = end - start + 1;
      let height = 0;
      for (let k = start; k <= end; k += 1) {
        const top = band.whiteTop[k];
        if (top < 0) continue;
        const extent = band.whiteBottom[k] - top + 1;
        if (extent > height) height = extent;
      }
      if (
        width >= MARKER_MIN_WIDTH &&
        width <= MARKER_MAX_WIDTH &&
        height >= MARKER_MIN_HEIGHT &&
        height <= MARKER_MAX_HEIGHT
      ) {
        candidates.push({
          x0: start + band.x0,
          x1: end + band.x0,
          width,
          height,
          centreX: (start + end) / 2 + band.x0,
        });
      }
      start = -1;
    }
  }

  let survivors = candidates;
  if (previousMarkerX !== undefined && survivors.length > 1) {
    survivors = survivors.filter(
      (candidate) => Math.abs(candidate.centreX - previousMarkerX) > MARKER_STATIC_DROP_PX,
    );
  }
  if (survivors.length === 0) return { ok: false, reason: 'no-marker' };
  // Never guess between two moving white bars.
  if (survivors.length > 1) return { ok: false, reason: 'multi-marker' };
  return { ok: true, marker: survivors[0] };
}

// ---------------------------------------------------------------------------------------------
// The zones
// ---------------------------------------------------------------------------------------------

interface ZoneRun {
  readonly from: number;
  readonly to: number;
}

/**
 * Maximal runs of columns warm in at least 55 % of the band rows (research §4). Unfiltered: the
 * marker still splits a zone in two, so the width gate belongs *after* the bridge.
 */
function warmRuns(band: BandScan): ZoneRun[] {
  const threshold = ZONE_ROW_FRACTION * BAND_ROWS;
  const runs: ZoneRun[] = [];
  let start = -1;
  for (let column = 0; column <= band.columns; column += 1) {
    const lit = column < band.columns && band.columnWarm[column] >= threshold;
    if (lit && start < 0) start = column;
    else if (!lit && start >= 0) {
      runs.push({ from: start + band.x0, to: column - 1 + band.x0 });
      start = -1;
    }
  }
  return runs;
}

/**
 * Merge two warm runs when the hole between them is narrow and sits under the marker: that hole is
 * the marker itself, not the hazard gap (research §4). A real gap is 78–80 px, so a ≤ 20 px bridge
 * can never swallow one.
 */
function bridgeMarkerHole(runs: readonly ZoneRun[], marker: MarkerCandidate): ZoneRun[] {
  const merged: Array<{ from: number; to: number }> = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const hole = run.from - previous.to - 1;
      const underMarker = previous.to + 1 >= marker.x0 - MARKER_HOLE_SLACK_PX &&
        run.from - 1 <= marker.x1 + MARKER_HOLE_SLACK_PX;
      if (hole > 0 && hole <= MARKER_HOLE_MAX_WIDTH && underMarker) {
        previous.to = run.to;
        continue;
      }
    }
    merged.push({ from: run.from, to: run.to });
  }
  return merged;
}

/** `mean(lum over the gap columns) / mean(lum over the zone columns)` (research §4). */
function gapLumaRatio(band: BandScan, left: ZoneRun, right: ZoneRun): number {
  let gapSum = 0;
  for (let x = left.to + 1; x < right.from; x += 1) gapSum += band.columnLuma[x - band.x0];
  const gapColumns = right.from - left.to - 1;

  let zoneSum = 0;
  for (let x = left.from; x <= left.to; x += 1) zoneSum += band.columnLuma[x - band.x0];
  for (let x = right.from; x <= right.to; x += 1) zoneSum += band.columnLuma[x - band.x0];
  const zoneColumns = left.to - left.from + 1 + (right.to - right.from + 1);

  return gapSum / gapColumns / (zoneSum / zoneColumns);
}

// ---------------------------------------------------------------------------------------------
// The 解除 control
// ---------------------------------------------------------------------------------------------

/**
 * Annulus offsets, precomputed once: `52 ≤ r ≤ 72` around the anchor. Iterating this list costs
 * ~7 800 reads instead of a 181 × 181 = 32 761-pixel scan with a radius test per pixel.
 */
const BUTTON_ANNULUS: ReadonlyArray<readonly [number, number]> = (() => {
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -BUTTON_ANNULUS_OUTER; dy <= BUTTON_ANNULUS_OUTER; dy += 1) {
    for (let dx = -BUTTON_ANNULUS_OUTER; dx <= BUTTON_ANNULUS_OUTER; dx += 1) {
      const squared = dx * dx + dy * dy;
      if (squared >= BUTTON_ANNULUS_INNER * BUTTON_ANNULUS_INNER &&
          squared <= BUTTON_ANNULUS_OUTER * BUTTON_ANNULUS_OUTER) {
        offsets.push([dx, dy]);
      }
    }
  }
  return offsets;
})();

/**
 * Verify the control at its anchor: the glyph box's mean luma against the disc annulus's. A
 * uniformly bright background scores ≈ 0 however pale it is, which is why the contrast test — not
 * a pale-pixel search — is what makes the anchor safe (research §6).
 *
 * The anchor is absolute, computed from the zones and the full frame's y fraction; the scan runs in
 * the pixels `data` holds (`localX`/`localY`), and the point returned is the absolute one.
 */
function readButton(
  data: Uint8Array,
  width: number,
  height: number,
  left: ZoneRun,
  right: ZoneRun,
  geometry: FrameGeometry,
): ButtonReading {
  const x = Math.round((left.from + right.to) / 2);
  const y = Math.round(BUTTON_Y_FRACTION * geometry.frameHeight);
  const point: Point = { x, y };
  const localX = x - geometry.origin.x;
  const localY = y - geometry.origin.y;

  // A frame whose anchor is not fully inside it cannot carry this control.
  if (localX - BUTTON_ANNULUS_OUTER < 0 || localX + BUTTON_ANNULUS_OUTER >= width) {
    return { point, onScreen: false, enabled: false };
  }
  if (localY - BUTTON_ANNULUS_OUTER < 0 || localY + BUTTON_ANNULUS_OUTER >= height) {
    return { point, onScreen: false, enabled: false };
  }

  let boxSum = 0;
  let pale = 0;
  for (let dy = -BUTTON_BOX_HALF_HEIGHT; dy <= BUTTON_BOX_HALF_HEIGHT; dy += 1) {
    const rowOffset = (localY + dy) * width;
    for (let dx = -BUTTON_BOX_HALF_WIDTH; dx <= BUTTON_BOX_HALF_WIDTH; dx += 1) {
      const offset = (rowOffset + localX + dx) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const luma = (77 * r + 150 * g + 29 * b) >> 8;
      boxSum += luma;
      if (luma >= PALE_LUMA_MIN && Math.abs(r - b) <= PALE_RB_MAX && Math.abs(r - g) <= PALE_RG_MAX) {
        pale += 1;
      }
    }
  }
  const boxMean = boxSum / ((BUTTON_BOX_HALF_WIDTH * 2 + 1) * (BUTTON_BOX_HALF_HEIGHT * 2 + 1));

  let annulusSum = 0;
  for (const [dx, dy] of BUTTON_ANNULUS) {
    const offset = ((localY + dy) * width + localX + dx) * 4;
    annulusSum += (77 * data[offset] + 150 * data[offset + 1] + 29 * data[offset + 2]) >> 8;
  }
  const annulusMean = annulusSum / BUTTON_ANNULUS.length;

  const contrast = boxMean - annulusMean;
  return {
    point,
    onScreen: contrast >= BUTTON_ON_SCREEN_CONTRAST,
    enabled: contrast >= BUTTON_ENABLED_CONTRAST && pale >= BUTTON_ENABLED_PALE,
  };
}

