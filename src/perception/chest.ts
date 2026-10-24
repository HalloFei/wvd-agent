/**
 * Chest perception: `parseQte` reads the QTE bar's geometry and the 解除 control from one frame, or
 * refuses with a named reason.
 *
 * Every number here was measured from `testdata/chest/2026-10-24-qte-0141/` (six stills) and the
 * 250-frame `…-qte-recorded/qte.mp4`, and is recorded in `.superpowers/sdd/2026-10-24-wvd-world-v1/
 * research-qte-parser.md`, cited as "research §n". The values are not re-derived here; numbers the
 * research calls one-sample are named with that word in their comment.
 *
 * **The opener panel.** `parseOpener` reads the `由谁打开?` roster from `testdata/chest/
 * 2026-10-24-opener/` — the panel captured live on 2026-10-24, two captures of one screen — and
 * `ChestPerceiver` tries it before the bar. The panel is a 2×3 grid of member cards (a smaller party
 * fills the same grid row-major and stops), each card carrying a heart numeral (willpower),
 * 陷阱发现 and 陷阱解除, and a CJK name the parser cannot read; members are therefore addressed by
 * card position (`#1` … `#6`). The digits come from a committed atlas extracted by
 * `scripts/extract-opener-digits.mjs`: the fixture's twelve 陷阱 values are `38 49 28 50 34 38 92 105
 * 62 43 77 79`, which contain every digit 0–9, and the heart numerals are drawn one pixel taller, so
 * they get their own atlas and only 0, 1 and 9 are observed (100 and 90). A digit whose best match is
 * below the measured floor refuses the whole panel — never rounded to a plausible number.
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
 */
import type {
  Frame,
  Observation,
  OpenerMember,
  OpenerPanel,
  Perceiver,
  Point,
  QteState,
  RgbaImage,
} from '../contracts.ts';

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

interface BandScan {
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
 */
export async function parseQte(frame: Frame, previousMarkerX?: number): Promise<QteParse> {
  // Dimensions come from the frame (contracts §0.5), and a foreign size is refused before its
  // decode is paid for: a 1080p JPEG costs ~190 ms here, more than the whole half-tick.
  if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) {
    return { ok: false, reason: 'unsupported-size' };
  }
  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch {
    // Failure is a value (contracts §0.6): an undecodable frame is "not observed", not a throw.
    return { ok: false, reason: 'decode-failed' };
  }
  return parseImage(image, previousMarkerX);
}

function parseImage(image: RgbaImage, previousMarkerX?: number): QteParse {
  const { data, width, height } = image;
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT) {
    return { ok: false, reason: 'unsupported-size' };
  }

  // 1. One pass over the band: the three profiles, the row profile and the marker's extents. -----
  const band = scanBand(image);

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
  const button = readButton(data, width, height, left, right);
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
    const opener = await parseOpener(frame);
    if (opener !== null) {
      return { screen: 'chest-open', atMs: frame.atMs, confidence: 1, opener };
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

/** One pass over rows 36–82 × 645–1275: 29 657 pixels, 2.2 % of a 1080p frame. */
function scanBand(image: RgbaImage): BandScan {
  const { data, width, height } = image;
  const y0 = Math.round(BAND_Y0_FRACTION * height);
  const x0 = Math.round(BAR_X0_FRACTION * width);
  const x1 = Math.round(BAR_X1_FRACTION * width);
  const zoneX0 = Math.round(ZONE_WINDOW_X0_FRACTION * width);
  const zoneX1 = Math.round(ZONE_WINDOW_X1_FRACTION * width);
  const columns = x1 - x0 + 1;

  const columnWarm = new Uint16Array(columns);
  const columnWhite = new Uint16Array(columns);
  const columnLuma = new Uint32Array(columns);
  const whiteTop = new Int16Array(columns).fill(-1);
  const whiteBottom = new Int16Array(columns).fill(-1);
  const rowWarm = new Uint16Array(BAND_ROWS);

  for (let bandRow = 0; bandRow < BAND_ROWS; bandRow += 1) {
    const rowOffset = (y0 + bandRow) * width;
    for (let x = x0; x <= x1; x += 1) {
      const offset = (rowOffset + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const column = x - x0;

      columnLuma[column] += (77 * r + 150 * g + 29 * b) >> 8;

      if (r >= WARM_R_MIN && r - b >= WARM_RB_MIN && g >= WARM_G_MIN) {
        columnWarm[column] += 1;
        if (x >= zoneX0 && x < zoneX1) rowWarm[bandRow] += 1;
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
 */
function readButton(
  data: Uint8Array,
  width: number,
  height: number,
  left: ZoneRun,
  right: ZoneRun,
): ButtonReading {
  const x = Math.round((left.from + right.to) / 2);
  const y = Math.round(BUTTON_Y_FRACTION * height);
  const point: Point = { x, y };

  // A frame whose anchor is not fully inside it cannot carry this control.
  if (x - BUTTON_ANNULUS_OUTER < 0 || x + BUTTON_ANNULUS_OUTER >= width) {
    return { point, onScreen: false, enabled: false };
  }
  if (y - BUTTON_ANNULUS_OUTER < 0 || y + BUTTON_ANNULUS_OUTER >= height) {
    return { point, onScreen: false, enabled: false };
  }

  let boxSum = 0;
  let pale = 0;
  for (let dy = -BUTTON_BOX_HALF_HEIGHT; dy <= BUTTON_BOX_HALF_HEIGHT; dy += 1) {
    const rowOffset = (y + dy) * width;
    for (let dx = -BUTTON_BOX_HALF_WIDTH; dx <= BUTTON_BOX_HALF_WIDTH; dx += 1) {
      const offset = (rowOffset + x + dx) * 4;
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
    const offset = ((y + dy) * width + x + dx) * 4;
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

// ---------------------------------------------------------------------------------------------
// The opener panel (由谁打开?)
// ---------------------------------------------------------------------------------------------

/**
 * The panel anchors, all measured from `testdata/chest/2026-10-24-opener/panel-00.jpg` and identical
 * in `panel-01.jpg` (two captures of the same screen).
 *
 * The modal is opaque and screen-anchored: its title band reads ~55 mean luma even over this lit
 * corridor, while the same box reads 147 on `after-pick.jpg`, 98–103 on the QTE stills and 73 on the
 * walking view — the dark band is a necessary gate, and the title's ~696 ink pixels inside it are what
 * makes it sufficient. The six cards' bottom borders are 160–164 bright columns wide and 120 is the
 * per-card presence test; a border count alone is not the frame's gate (`map.jpg` happens to reach
 * 160 at one slot), which is why the dark band and the title ink are tested before any card is.
 */
const PANEL_BAND = { x0: 860, x1: 1040, y0: 612, y1: 666 } as const;
const PANEL_BAND_MEAN_MAX = 80;
const TITLE_BOX = { x0: 890, x1: 1018, y0: 630, y1: 658 } as const;
const TITLE_INK_LUMA = 150;
const TITLE_INK_MIN = 400;

/**
 * The card grid: three columns and two rows of 165 px cards, 110 px tall. The second row starts at
 * 853: its content rows are the first row's + 124, and both rows' bottom borders sit at top + 110.
 * A smaller party fills the same grid row-major and stops, which is the only layout assumption this
 * parser makes — a hole in the prefix is refused, not renumbered.
 */
const CARD_COLUMNS: ReadonlyArray<readonly [number, number]> = [[704, 868], [879, 1046], [1057, 1220]];
const CARD_ROW_TOPS: readonly number[] = [729, 853];
const CARD_HEIGHT = 110;
const CARD_SLOTS = 6;
const CARD_BORDER_INSET = 2;
const CARD_BORDER_LUMA = 65;
const CARD_BORDER_MIN_COLUMNS = 120;

/** Field bands, as y offsets from a card's top border (exclusive end). */
const TRAP_DETECT_BAND: readonly [number, number] = [64, 80];
const TRAP_DISARM_BAND: readonly [number, number] = [85, 101];
const HEART_BAND: readonly [number, number] = [1, 17];

/**
 * The numbers' x windows. The 陷阱 labels end at card x0 + 71 and their numerals start at x0 + 76, so
 * 74 clears the CJK. The heart numeral is right-aligned in the card's right 70 px and the grey heart
 * glyph sits just left of it; the heart numerals are yellow, which is what keeps the two apart.
 */
const TRAP_NUMBER_LEFT = 74;
const NUMBER_RIGHT_INSET = 3;
const HEART_LEFT = 70;

/**
 * Ink rules. On a card's dark fill (`median` ~45–110) the white numerals are ≥ 55 luma above it; the
 * heart numerals are yellow (`g − b ≥ 45`, luma ≥ 140) while the heart glyph beside them is grey, so
 * the chroma rule is the heart's segmentation and the luma rule is everyone else's.
 */
const INK_LUMA_DELTA = 55;
const HEART_GREEN_MINUS_BLUE = 45;
const HEART_LUMA_MIN = 140;

/**
 * Glyph geometry. Digits are 7–9 px wide and 12–13 rows tall, separated by 1–2 px; a run wider than
 * 12 px is two digits whose JPEG halo closed the gap, split at the measured 9.4 px pitch ("00" in a
 * heart is 18 px). A narrow sliver (fewer than 4 columns) is antialiasing, not a glyph.
 */
const MIN_GLYPH_COLUMNS = 4;
const MAX_GLYPH_COLUMNS = 12;
const DIGIT_PITCH = 9.4;
/** A card shows at most three digits (105 is the widest observed); more runs is noise, not a number. */
const MAX_GLYPH_DIGITS = 3;

/**
 * Numerals are left-aligned: the first glyph starts 2–4 px into the measured band on all twelve
 * 陷阱 values (a 1 or a 3 begins closer to the edge than a 0 does), so 6 tolerates that wobble and
 * still rejects a *missing* leading digit, which pushes the next glyph 11 px in. A number whose
 * first glyph is not where numerals start is refused, not read as a shorter number.
 */
const NUMBER_START_TOLERANCE = 6;
/** Successive glyphs start 7–11 px apart; a missing middle digit leaves a 16 px gap or more. */
const MAX_DIGIT_START_GAP = 13;

/**
 * The heart numeral is right-aligned: its last glyph ends 4–6 px short of the card's right border on
 * all five cards that draw one, so 8 tolerates the wobble and still rejects a truncated trailing
 * digit (which would stop ~9 px short). The 陷阱 numerals are left-aligned and carry no such anchor.
 */
const HEART_RIGHT_INSET_MAX = 8;

/**
 * The feature: the glyph's ink rows cropped, scaled by its own peak, centred in a 10 × 14 cell and
 * bilinearly resized to 8 × 10, then mean-subtracted and unit-normalised for NCC (map.ts's rule).
 */
const GLYPH_CELL_WIDTH = 10;
const GLYPH_CELL_HEIGHT = 14;
const GLYPH_FEATURE_WIDTH = 8;
const GLYPH_FEATURE_HEIGHT = 10;

/**
 * The match floors, measured on both captures: the twelve 陷阱 numbers' lowest best score is 0.921
 * with a 0.133 runner-up margin; the heart numerals' is 0.760 with a 0.419 margin. Below either
 * floor the panel is refused — a wrong opener choice spends the chest (chest §5).
 */
const DIGIT_MATCH_MIN = 0.7;
const DIGIT_MARGIN_MIN = 0.1;

/**
 * The two digit atlases, extracted by `scripts/extract-opener-digits.mjs` from `panel-00.jpg`:
 * `TRAP_DIGITS` from the twelve 陷阱 values in `measurements.json`, `HEART_DIGITS` from the five
 * heart numerals that frame shows (cards 1–3, 5, 6: 100 100 100 90 100 — card 4, DragonSlayer, draws
 * no heart). Each constant is the **mean** of every instance of that digit in the frame: an 8 × 10
 * grid of 0–255 intensities, mean-centred and normalised at load. `node
 * scripts/extract-opener-digits.mjs --verify` checks every one of these strings, and
 * `tests/opener.test.ts` reads both captures with them.
 */
const TRAP_DIGITS: Readonly<Record<string, string>> = {
  '0': 'AQkaHh0TBAARYoZkgXsmAjO0fhZOr1kESc9oBjG2hgpY3FoHIbqkDljeWRAktacPR9BpCze1hQoxuIAWTa1YBBVnhFR1dSwCAgsWFBUQBQA=',
  '1': 'AAQUJxYEAAAAHoXiehYAAAASffKFDwAAAAxq64ESAAAADGnqfhYAAAAObut/FwAAAA1s6oMWAAAAD3LuihUAAAAef8uNLwAAAAQSHBMGAAA=',
  '2': 'ARxIblonBQAGQ3Wez5UbAAISDRClwysAAAQEE52iIAAABAVIpmgOAAAEIXt+IwEAARlbaTEXDAAHWJZqTmMkAAx7q6qugyAAAQwQERILAgA=',
  '3': 'AAw0YWY9EwEBHFOGxrpUBQEQDwplw20HAAUQL4KPNgIADTiJ2a1LBQAEDiyS2qgRAhAIBzWuwBYHPCkJL5ulEglaYz1XeEsGAQ0TExMPBwA=',
  '4': 'AAEAAiMrBwAAAgMwp5gWAAAEIIHnrRYAABNLi82mGgADLFBcwagaAAtkSEzDrx4AD3Zdc9nEKwADGxlT1LMhAAADDFG1myQAAAACDhoXBgA=',
  '5': 'ABIyR0UlBwADNoWro2QWAAZCVjIeGxACFHB5RhkJHwUWlNLLkjsxBwYmXavkmUUGBQ0UNam2TAUlKw4PcaE+BDVmQT5wUxYACBEQDxEJAgA=',
  '6': 'AAADEBUSBAAADkB4WzEKAAAym4ssBAcBDIGoZD8uCQAZ2LeDpLVLBB7jgydZx44MHddvDTbEpQ8SoIISQbmBCgREb1NcczQDAAYQDw0LAgA=',
  '7': 'Ah82Nz82JAMKapKZlKtvCgQlGxYnbzECAAcFBWBlGgAAAgkjok0LAAAEE2WrLgYAAAQqsJknAwAADVPjhxUBAAAQT6FZDQYAAAIJEggBAAA=',
  '8': 'Axs9Q0IwDAAWc4xOWHc3Ay6npRschVIFG5LKhWZqJAEFRLbs1HUWAAxJgqTg0FcFN4lQIWfRnQ4+k0UHL6SYDx5kWTxPgFAGAQsSExMQBwA=',
  '9': 'AQkZHB0WCAASW4ljb4JJBi2wliMroYsOMrqYKiGdqxMop7xhRra8FQ5QoaiXyqIQAw4gMIKtYAcEBA0/m3glAgEQL1tOHwUAAAQICwQBAAA=',
};
const HEART_DIGITS: Readonly<Record<string, string>> = {
  '0': 'ABtxqqdKBwAJd59MjbI5ASDNawQZxokJRNZXAhO4ow9V1lABEa+uEU7WVQISs6UPJ8pnBBjCjAoNmawwbM5UAwAke4iNVQoAAAAHFhABAAA=',
  '1': 'AAAKJyYLAAAAATuruzsAAAAAHaPFPgAAAAATertCAAAAABN3ukYAAAAAE3m6QgAAAAAQerpAAAAAABWAzE8AAAABJaLQagAAAAAIISYVAAA=',
  '9': 'AAkQEwgAAAAtfHqXfgkAALanJUjrYAAA03sAANiqIwPVtSMA3b9ZCXW3q6nxt1cJAyY8uO1yGAIAAAvcxgAAAAAba3ceAAAAAA0dAwAAAAA=',
};

interface DigitTemplate {
  readonly digit: string;
  /** Mean-subtracted, unit-norm 8 × 10 values. */
  readonly values: Float64Array;
}

const ATLASES = new WeakMap<object, readonly DigitTemplate[]>();

function atlasOf(table: Readonly<Record<string, string>>): readonly DigitTemplate[] {
  const cached = ATLASES.get(table);
  if (cached) return cached;
  const atlas = Object.entries(table).map(([digit, base64]) => ({
    digit,
    values: normaliseGlyph(Buffer.from(base64, 'base64')),
  }));
  ATLASES.set(table, atlas);
  return atlas;
}

function normaliseGlyph(bytes: Uint8Array): Float64Array {
  const values = new Float64Array(bytes.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    values[i] = bytes[i] ?? 0;
    sum += values[i]!;
  }
  const mean = sum / values.length;
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    values[i] = values[i]! - mean;
    normSq += values[i]! * values[i]!;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) for (let i = 0; i < values.length; i += 1) values[i]! /= norm;
  return values;
}

const pixelLuma = (data: Uint8Array, width: number, x: number, y: number): number => {
  const offset = (y * width + x) * 4;
  return (77 * data[offset]! + 150 * data[offset + 1]! + 29 * data[offset + 2]!) >> 8;
};

interface PanelBand {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

type InkRule = (x: number, y: number) => boolean;

/** The band's median luma: the card fill under the numerals, robust to the numerals themselves. */
function bandMedianLuma(data: Uint8Array, width: number, band: PanelBand): number {
  const values = new Float64Array((band.x1 - band.x0) * (band.y1 - band.y0));
  let index = 0;
  for (let y = band.y0; y < band.y1; y += 1) {
    for (let x = band.x0; x < band.x1; x += 1) values[index++] = pixelLuma(data, width, x, y);
  }
  values.sort();
  return values[values.length >> 1]!;
}

/** Maximal runs of columns that carry ink (raw: no width filtering, so locating can use them). */
function columnRuns(
  data: Uint8Array,
  width: number,
  band: PanelBand,
  ink: InkRule,
): Array<readonly [number, number]> {
  const columns = band.x1 - band.x0;
  const lit = new Uint16Array(columns);
  for (let y = band.y0; y < band.y1; y += 1) {
    for (let x = band.x0; x < band.x1; x += 1) if (ink(x, y)) lit[x - band.x0]! += 1;
  }
  const runs: Array<readonly [number, number]> = [];
  let start = -1;
  for (let column = 0; column <= columns; column += 1) {
    const on = column < columns && lit[column]! > 0;
    if (on && start < 0) start = column;
    else if (!on && start >= 0) {
      runs.push([band.x0 + start, band.x0 + column - 1] as const);
      start = -1;
    }
  }
  return runs;
}

/** Filter slivers and split runs that are two digits wide, at the measured pitch. */
function glyphAtoms(runs: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const atoms: Array<readonly [number, number]> = [];
  for (const [from, to] of runs) {
    const glyphWidth = to - from + 1;
    if (glyphWidth < MIN_GLYPH_COLUMNS) continue;
    if (glyphWidth <= MAX_GLYPH_COLUMNS) {
      atoms.push([from, to] as const);
      continue;
    }
    const count = Math.max(2, Math.round(glyphWidth / DIGIT_PITCH));
    for (let k = 0; k < count; k += 1) {
      atoms.push([
        from + Math.round((k * glyphWidth) / count),
        from + Math.round(((k + 1) * glyphWidth) / count) - 1,
      ] as const);
    }
  }
  return atoms;
}

/** One glyph's normalised 8 × 10 feature, or null when the atom carries no ink rows. */
function glyphFeature(
  data: Uint8Array,
  width: number,
  band: PanelBand,
  from: number,
  to: number,
  ink: InkRule,
  background: number,
): Float64Array | null {
  let top = -1;
  let bottom = -1;
  for (let y = band.y0; y < band.y1; y += 1) {
    let any = false;
    for (let x = from; x <= to; x += 1) {
      if (ink(x, y)) {
        any = true;
        break;
      }
    }
    if (any) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return null;

  const glyphWidth = to - from + 1;
  const glyphHeight = bottom - top + 1;
  const cell = new Float64Array(GLYPH_CELL_WIDTH * GLYPH_CELL_HEIGHT);
  let peak = 1;
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const value = pixelLuma(data, width, from + x, top + y) - background;
      if (value > peak) peak = value;
    }
  }
  const offsetX = Math.floor((GLYPH_CELL_WIDTH - glyphWidth) / 2);
  const offsetY = Math.floor((GLYPH_CELL_HEIGHT - glyphHeight) / 2);
  for (let y = 0; y < glyphHeight; y += 1) {
    for (let x = 0; x < glyphWidth; x += 1) {
      const cellX = offsetX + x;
      const cellY = offsetY + y;
      if (cellX < 0 || cellX >= GLYPH_CELL_WIDTH || cellY < 0 || cellY >= GLYPH_CELL_HEIGHT) continue;
      cell[cellY * GLYPH_CELL_WIDTH + cellX] = Math.max(0, pixelLuma(data, width, from + x, top + y) - background) / peak;
    }
  }

  const feature = new Float64Array(GLYPH_FEATURE_WIDTH * GLYPH_FEATURE_HEIGHT);
  for (let ty = 0; ty < GLYPH_FEATURE_HEIGHT; ty += 1) {
    const sy = ((ty + 0.5) * GLYPH_CELL_HEIGHT) / GLYPH_FEATURE_HEIGHT - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const ya = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0));
    const yb = Math.min(GLYPH_CELL_HEIGHT - 1, Math.max(0, y0 + 1));
    for (let tx = 0; tx < GLYPH_FEATURE_WIDTH; tx += 1) {
      const sx = ((tx + 0.5) * GLYPH_CELL_WIDTH) / GLYPH_FEATURE_WIDTH - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const xa = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0));
      const xb = Math.min(GLYPH_CELL_WIDTH - 1, Math.max(0, x0 + 1));
      const upper = cell[ya * GLYPH_CELL_WIDTH + xa]! * (1 - fx) + cell[ya * GLYPH_CELL_WIDTH + xb]! * fx;
      const lower = cell[yb * GLYPH_CELL_WIDTH + xa]! * (1 - fx) + cell[yb * GLYPH_CELL_WIDTH + xb]! * fx;
      feature[ty * GLYPH_FEATURE_WIDTH + tx] = upper * (1 - fy) + lower * fy;
    }
  }

  let mean = 0;
  for (const value of feature) mean += value;
  mean /= feature.length;
  let normSq = 0;
  for (let i = 0; i < feature.length; i += 1) {
    feature[i] = feature[i]! - mean;
    normSq += feature[i]! * feature[i]!;
  }
  const norm = Math.sqrt(normSq);
  if (!(norm > 0)) return null;
  for (let i = 0; i < feature.length; i += 1) feature[i]! /= norm;
  return feature;
}

/** Read a run of glyph atoms as a decimal number, or null at the first unreadable digit. */
function readNumber(
  data: Uint8Array,
  width: number,
  band: PanelBand,
  ink: InkRule,
  background: number,
  atlas: readonly DigitTemplate[],
  atoms: ReadonlyArray<readonly [number, number]>,
): number | null {
  if (atoms.length === 0 || atoms.length > MAX_GLYPH_DIGITS) return null;
  // Structure before recognition: a truncated number is still a number, and must be refused.
  if (atoms[0]![0] - band.x0 > NUMBER_START_TOLERANCE) return null;
  for (let i = 1; i < atoms.length; i += 1) {
    if (atoms[i]![0] - atoms[i - 1]![0] > MAX_DIGIT_START_GAP) return null;
  }
  let text = '';
  for (const [from, to] of atoms) {
    const feature = glyphFeature(data, width, band, from, to, ink, background);
    if (feature === null) return null;
    let best: string | null = null;
    let bestScore = -2;
    let secondScore = -2;
    for (const { digit, values } of atlas) {
      let score = 0;
      for (let i = 0; i < feature.length; i += 1) score += feature[i]! * values[i]!;
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = digit;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    // Never a guess: an unreadable or ambiguous digit refuses the whole panel.
    if (best === null || bestScore < DIGIT_MATCH_MIN || bestScore - secondScore < DIGIT_MARGIN_MIN) return null;
    text += best;
  }
  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}

function cardBand(slot: number, offsets: readonly [number, number]): PanelBand {
  const [x0, x1] = CARD_COLUMNS[slot % CARD_COLUMNS.length]!;
  const top = CARD_ROW_TOPS[Math.floor(slot / CARD_COLUMNS.length)]!;
  return { x0, x1, y0: top + offsets[0], y1: top + offsets[1] };
}

/** Is this card slot drawn? Its bottom border spans the card, and both rows carry one. */
function cardPresent(data: Uint8Array, width: number, slot: number): boolean {
  const [x0, x1] = CARD_COLUMNS[slot % CARD_COLUMNS.length]!;
  const top = CARD_ROW_TOPS[Math.floor(slot / CARD_COLUMNS.length)]!;
  const y = top + CARD_HEIGHT;
  let lit = 0;
  for (let x = x0 + CARD_BORDER_INSET; x <= x1 - CARD_BORDER_INSET; x += 1) {
    if (pixelLuma(data, width, x, y) >= CARD_BORDER_LUMA) lit += 1;
  }
  return lit >= CARD_BORDER_MIN_COLUMNS;
}

/** Is this frame the opener panel at all? A dark modal band carrying the title's glyph ink. */
function isOpenerPanel(data: Uint8Array, width: number): boolean {
  let sum = 0;
  let count = 0;
  for (let y = PANEL_BAND.y0; y < PANEL_BAND.y1; y += 1) {
    for (let x = PANEL_BAND.x0; x < PANEL_BAND.x1; x += 1) {
      sum += pixelLuma(data, width, x, y);
      count += 1;
    }
  }
  if (sum / count > PANEL_BAND_MEAN_MAX) return false;

  let ink = 0;
  for (let y = TITLE_BOX.y0; y < TITLE_BOX.y1; y += 1) {
    for (let x = TITLE_BOX.x0; x < TITLE_BOX.x1; x += 1) {
      if (pixelLuma(data, width, x, y) >= TITLE_INK_LUMA) ink += 1;
    }
  }
  return ink >= TITLE_INK_MIN;
}

/** 陷阱发现 / 陷阱解除: white numerals on the card's dark fill. */
function readTrapNumber(data: Uint8Array, width: number, slot: number, field: 'detect' | 'disarm'): number | null {
  const [x0, x1] = CARD_COLUMNS[slot % CARD_COLUMNS.length]!;
  const card = cardBand(slot, field === 'detect' ? TRAP_DETECT_BAND : TRAP_DISARM_BAND);
  const band: PanelBand = {
    x0: x0 + TRAP_NUMBER_LEFT,
    x1: x1 - NUMBER_RIGHT_INSET,
    y0: card.y0,
    y1: card.y1,
  };
  const background = bandMedianLuma(data, width, band);
  const ink: InkRule = (x, y) => pixelLuma(data, width, x, y) - background >= INK_LUMA_DELTA;
  const atoms = glyphAtoms(columnRuns(data, width, band, ink));
  return readNumber(data, width, band, ink, background, atlasOf(TRAP_DIGITS), atoms);
}

/**
 * The heart numeral. Its absence is a fact about the screen, not a failed read: the one recorded
 * panel draws **no heart at all** on DragonSlayer's card (Lv.48, silver gem), while the other five
 * show 100, 100, 100, 90 and 100. `willpower` has no absent value in the closed contract, so the
 * caller fills it with the panel's highest displayed heart — a bound the panel itself proves. A
 * numeral that is there but unreadable is different, and refuses the panel.
 */
type HeartReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly value: number };

function readHeartNumber(data: Uint8Array, width: number, slot: number): HeartReading {
  const [, x1] = CARD_COLUMNS[slot % CARD_COLUMNS.length]!;
  const band = cardBand(slot, HEART_BAND);
  const window: PanelBand = {
    x0: x1 - HEART_LEFT,
    x1: x1 - NUMBER_RIGHT_INSET,
    y0: band.y0,
    y1: band.y1,
  };
  const ink: InkRule = (x, y) => {
    const offset = (y * width + x) * 4;
    const green = data[offset + 1]!;
    const blue = data[offset + 2]!;
    return green - blue >= HEART_GREEN_MINUS_BLUE && pixelLuma(data, width, x, y) >= HEART_LUMA_MIN;
  };
  // Slivers belong to the grey heart's warm JPEG fringe, not to the numeral: drop them before the
  // extent is taken, or the number would start 8 px early and look like a missing digit.
  const located = columnRuns(data, width, window, ink).filter(([from, to]) => to - from + 1 >= MIN_GLYPH_COLUMNS);
  if (located.length === 0) return { kind: 'absent' };

  // The numeral is right-aligned and the grey heart sits left of it; the yellow extent is the number.
  if (x1 - located[located.length - 1]![1] > HEART_RIGHT_INSET_MAX) return { kind: 'unreadable' };
  const numberBand: PanelBand = {
    x0: located[0]![0],
    x1: located[located.length - 1]![1] + 1,
    y0: band.y0,
    y1: band.y1,
  };
  const background = bandMedianLuma(data, width, numberBand);
  const value = readNumber(data, width, numberBand, ink, background, atlasOf(HEART_DIGITS), glyphAtoms(located));
  return value === null ? { kind: 'unreadable' } : { kind: 'read', value };
}

function parseOpenerImage(image: RgbaImage): OpenerPanel | null {
  const { data, width, height } = image;
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT) return null;
  if (!isOpenerPanel(data, width)) return null;

  // Segment the cards rather than assuming six: the party fills the grid row-major and stops.
  let count = 0;
  while (count < CARD_SLOTS && cardPresent(data, width, count)) count += 1;
  if (count === 0) return null;
  // A drawn card after an undrawn one is a layout this parser has never seen: refuse, do not renumber.
  for (let slot = count; slot < CARD_SLOTS; slot += 1) if (cardPresent(data, width, slot)) return null;

  const traps: Array<{ detect: number; disarm: number }> = [];
  const hearts: HeartReading[] = [];
  for (let slot = 0; slot < count; slot += 1) {
    const detect = readTrapNumber(data, width, slot, 'detect');
    const disarm = readTrapNumber(data, width, slot, 'disarm');
    if (detect === null || disarm === null) return null;
    traps.push({ detect, disarm });
    hearts.push(readHeartNumber(data, width, slot));
  }

  if (hearts.some((reading) => reading.kind === 'unreadable')) return null;
  let highest = -1;
  for (const reading of hearts) {
    if (reading.kind === 'read' && reading.value > highest) highest = reading.value;
  }
  if (highest < 0 && hearts.some((reading) => reading.kind === 'absent')) return null;

  const members: OpenerMember[] = traps.map((value, index) => {
    const reading = hearts[index]!;
    return {
      // The name is CJK and cannot be read: address the member by the card it sits on (1-based).
      name: `#${index + 1}`,
      detect: value.detect,
      disarm: value.disarm,
      // No heart drawn: the panel's own highest heart is the bound (see `HeartReading`).
      willpower: reading.kind === 'read' ? reading.value : highest,
      // 陷阱恐惧 is not rendered in this panel — the willpower floor is what protects the choice.
      feared: false,
    };
  });
  return { members };
}

/**
 * Read the `由谁打开?` opener panel out of one frame, or `null` when it is not there or cannot be read
 * whole. `null` is every refusal: another frame size, a frame that is not the panel, a missing or
 * ambiguous digit, or a partial party laid out in a shape this parser does not know.
 */
export async function parseOpener(frame: Frame): Promise<OpenerPanel | null> {
  if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) return null;
  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch {
    return null;
  }
  return parseOpenerImage(image);
}

/**
 * Where the loop clicks to choose member `index`: the centre of the card the panel draws it on. The
 * measured click that chose DragonSlayer was (781, 899), 3–9 px from this card's centre (786, 908).
 */
export function openerCardCentre(index: number): Point | null {
  if (!Number.isInteger(index) || index < 0 || index >= CARD_SLOTS) return null;
  const [x0, x1] = CARD_COLUMNS[index % CARD_COLUMNS.length]!;
  const top = CARD_ROW_TOPS[Math.floor(index / CARD_COLUMNS.length)]!;
  return { x: Math.round((x0 + x1) / 2), y: top + Math.round(CARD_HEIGHT / 2) };
}
