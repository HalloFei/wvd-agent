/**
 * Dungeon-map perception: `readMap` turns one decoded frame into a `MapState`, or `null` when the
 * frame is not the map this parser was measured against.
 *
 * Everything here is measured from `testdata/nav-1024-0213/` and the 221-frame corpus, and recorded
 * in `.superpowers/sdd/2026-10-24-wvd-world-v1/research-map-parser.md` (cited as "research §n"). The
 * values are not re-derived here; numbers that report calls one-sample or unproven are named with
 * that word in their comment and are never presented as facts.
 *
 * The two rules that shape the code:
 *
 * - The map canvas **scrolls** (21, 72 and 210 px measured on one floor), so no absolute origin is a
 *   constant. The click transform is relative to the chevron: `chevron + (Δx·36, −Δy·36)`. Icons are
 *   mapped the same way; the lattice is fitted per frame only to validate the structure.
 * - Refusal is a first-class answer, and it **names the gate** that refused the frame
 *   (`readMapDetailed` → `{ ok: false, gate }`); `readMap` keeps the plain `null` for callers that
 *   only ever needed the map, and observe() still reports `unknown` with confidence 0. A confident
 *   wrong map is worse than no map, and an unnamed refusal is a diagnosis nobody can read.
 *
 * Geometry: 1920×1080 device pixels. A frame of another size is unsupported (contracts §0.5: refuse,
 * do not mis-scale the fixed rects). The digits are 12 px at a fixed rect and only seven of the ten
 * glyphs have ever been seen; a glyph below the match/margin floor makes the whole readout `null`.
 *
 * The map's markers, measured 2026-10-24 against every committed map frame: chest, hazard, stairs,
 * the orchid `teleport` ring (within a floor), the `hole` (down-arrow over an oval) and the `harken`
 * — the white sparkle the operator changes floor by. The harken is drawn at two sizes across floors
 * (16 px on 第三区, 12 px on B1F and 第四区), which is why it is matched at both scales: at one scale
 * it fires on the hole glyph and on B1F background cells. Navigation design §6 has the numbers.
 */
import type {
  Frame,
  MapIcon,
  MapState,
  Observation,
  Perceiver,
  Point,
  RgbaImage,
} from '../contracts.ts';
import { readNumbersViaOcr, type OcrReadout } from './readout-ocr.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/** The only frame size the fixed rects were measured at (research §1, §12 item 3). */
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/**
 * A uniform/black frame is `unknown` with confidence 0 (contracts §2). The research measured std
 * over every pixel (~85 ms); this samples every fourth pixel on both axes instead, which is the same
 * answer for a uniform frame and keeps observe() inside the half-tick. The thresholds are the
 * research's (research §1, §10 step 0).
 */
const UNIFORM_SAMPLE_STRIDE = 4;
const UNIFORM_STD = 6;
const UNIFORM_MEAN = 8;

/** G1 — the coordinate readout: the decisive structural gate (research §3). */
const READOUT_X = 1010;
const READOUT_Y = 898;
const READOUT_W = 130;
const READOUT_H = 16;
const READOUT_INK_LUMA = 85;
const READOUT_LABEL_X = [1017, 1094] as const;
const READOUT_LABEL_TOLERANCE = 2;
/** A band column with any ink at all counts; the chrome filter below is what removes noise. */
const READOUT_INK_ROWS_MIN = 1;
/** …and fewer than this, or it is the panel's border rather than a glyph (R28). */
const READOUT_CHROME_ROWS = 13;
/** The readout band a fallback OCR reader is handed: the line plus a little air around it. */
export const READOUT_BAND = { x: READOUT_X, y: READOUT_Y - 8, width: READOUT_W + 10, height: READOUT_H + 16 } as const;

/** The gates that mean "the line is there but its digits could not be named". */
export function isReadoutGate(gate: string): boolean {
  return gate.startsWith('readout-');
}

const READOUT_LABEL_MIN_W = 9;
const READOUT_LABEL_MAX_W = 13;
/** Digit widths measured 4–9 px; 3–10 leaves the proportional advances room (research §3). */
const READOUT_DIGIT_MIN_W = 3;
const READOUT_DIGIT_MAX_W = 13;
/** Refuse below either floor; never round to the nearest plausible tile (research §8 item 7). */
const DIGIT_NCC_FLOOR = 0.75;
const DIGIT_MARGIN_FLOOR = 0.15;
/** Confidence 1.0 needs both digits' margins ≥ 0.30 (research §9). */
const DIGIT_CONFIDENT_MARGIN = 0.3;

/** G2 — the title bar's dark strip. Weak alone (95/198 non-map frames pass) but necessary. */
const TITLE_BAR_X = 700;
const TITLE_BAR_Y = 20;
const TITLE_BAR_W = 600;
const TITLE_BAR_H = 22;
const TITLE_BAR_DARK_LUMA = 60;
const TITLE_BAR_DARK_FRACTION = 0.95;

/**
 * G3 — white map ink in the panel.
 *
 * The floor was 15 000 from the research's 第三区/第四区 captures, and it refused the operator's
 * **第二区-城内1F** map on 2026-11-08: that canvas draws **13 047** white pixels (shorter walls), so the
 * live map read refused at this gate and the loop could not name the floor. Measured across the corpus
 * the same day: maps 13 047–39 466, and non-maps 72–7 158 (a battle's command phase, the 3-D view after
 * a chest, the opener panel, a QTE still) — so 10 500 keeps a 1.5× margin over the brightest non-map
 * and accepts the smallest map.
 */
const MAP_INK_X = 480;
const MAP_INK_Y = 150;
const MAP_INK_W = 1220;
const MAP_INK_H = 750;
const MAP_INK_MIN = 10_500;
const MAP_INK_MAX = 200_000;
const MAP_INK_LUMA = 185;
const MAP_INK_SAT = 60;

/**
 * G4 — a centred title string is present (research §2). `map.png` 768, `popup.png` 770 pixels of it.
 */
const TITLE_INK_X = 800;
const TITLE_INK_Y = 40;
const TITLE_INK_W = 400;
const TITLE_INK_H = 40;
const TITLE_INK_LUMA = 170;
/** A glyph's stroke carries its own dark gap (or outline) within this radius of it. */
const TITLE_STROKE_DARK = 90;
const TITLE_STROKE_RADIUS = 2;
export const TITLE_BAR_INK_MIN = 20;

/**
 * G4's ink count — **text** ink: pixels in the centred title band above `TITLE_INK_LUMA` that sit within
 * `TITLE_STROKE_RADIUS` of a pixel below `TITLE_STROKE_DARK`. A title is characters, and characters have
 * their own dark gaps; a bright *surface* has none. Measured on the 1920×1080 corpus 2026-11-03:
 *
 * | frame | stroke ink | raw bright px |
 * | --- | --- | --- |
 * | 第四区 / 第三区 maps, Dungeon Select | 1 159–1 854 | 1 185–2 236 |
 * | the world map | 306 | 1 583 |
 * | the chest QTE frames, the opener panel | 31–56 | 446–5 569 |
 * | the encounter intro | 245 | 446 |
 * | **the 3-D view with its menu legend** | **0** | **5 227** |
 * | the rest town | 0 | 2 473 |
 * | battles | 0–1 | 0–1 |
 *
 * The menu frame is the reason the raw count is not the fact: the room's glowing wall fills the band with
 * 5 227 bright pixels and not one stroke, so the raw count ruled the 3-D view out and left the frame
 * unnamed (`t-mvy23qe2`, 2026-11-03). The stroke count separates it from every title in the corpus.
 *
 * Exported because the band also answers "this frame is not a battle" for `CombatPerceiver`, and "the
 * 3-D view's corner says otherwise" for the evidence table (`screens.ts`): a battle draws no title, and
 * neither does the 3-D view — but only a title's text may rule the 3-D view out.
 */
/**
 * The map panel's white ink: bright and unsaturated (G3). One predicate, so `scanPanel`'s count and the
 * exported measurement can never disagree.
 */
function isPanelInk(r: number, g: number, b: number): boolean {
  const luma = ((r * 299 + g * 587 + b * 114) / 1000) | 0;
  if (luma <= MAP_INK_LUMA) return false;
  return Math.max(r, g, b) - Math.min(r, g, b) < MAP_INK_SAT;
}

/**
 * The panel's white-ink count over the measured rect, px (G3's measurement, exported for the fixtures
 * that pin its floor). Measured 2026-11-08 across the corpus: a map's canvas draws **13 047–39 466**,
 * and the frames that are not maps draw **72–7 158** (a battle's command phase 4 509, the 3-D view
 * after a chest 7 158, the opener panel 4 754, a QTE still 72).
 */
export function panelInk(image: RgbaImage): number {
  const { data, width } = image;
  let count = 0;
  for (let y = MAP_INK_Y; y < MAP_INK_Y + MAP_INK_H; y += 1) {
    const row = y * width;
    for (let x = MAP_INK_X; x < MAP_INK_X + MAP_INK_W; x += 1) {
      const offset = (row + x) * 4;
      if (isPanelInk(data[offset]!, data[offset + 1]!, data[offset + 2]!)) count += 1;
    }
  }
  return count;
}

export function titleBarInk(image: RgbaImage): number {
  const { data, width } = image;
  const radius = TITLE_STROKE_RADIUS;
  const padX = TITLE_INK_X - radius;
  const padY = TITLE_INK_Y - radius;
  const padW = TITLE_INK_W + 2 * radius;
  const padH = TITLE_INK_H + 2 * radius;
  if (padX < 0 || padY < 0 || width < padX + padW || image.height < padY + padH) return 0;
  // The band's luma, then its local minimum over the stroke radius: one horizontal pass, one vertical.
  // The minimum is associative, so two 1-D passes give the same window a full 5×5 scan would.
  const luma = new Uint8Array(padW * padH);
  for (let y = 0; y < padH; y += 1) {
    const row = (padY + y) * width;
    for (let x = 0; x < padW; x += 1) luma[y * padW + x] = lumaAt(data, (row + padX + x) * 4);
  }
  const across = new Uint8Array(padW * padH);
  for (let y = 0; y < padH; y += 1) {
    for (let x = 0; x < padW; x += 1) {
      let low = 255;
      for (let d = -radius; d <= radius; d += 1) {
        const xx = x + d;
        if (xx >= 0 && xx < padW) low = Math.min(low, luma[y * padW + xx]!);
      }
      across[y * padW + x] = low;
    }
  }
  const near = new Uint8Array(padW * padH);
  for (let y = 0; y < padH; y += 1) {
    for (let x = 0; x < padW; x += 1) {
      let low = 255;
      for (let d = -radius; d <= radius; d += 1) {
        const yy = y + d;
        if (yy >= 0 && yy < padH) low = Math.min(low, across[yy * padW + x]!);
      }
      near[y * padW + x] = low;
    }
  }
  let ink = 0;
  for (let y = radius; y < radius + TITLE_INK_H; y += 1) {
    for (let x = radius; x < radius + TITLE_INK_W; x += 1) {
      const index = y * padW + x;
      if (luma[index]! > TITLE_INK_LUMA && near[index]! < TITLE_STROKE_DARK) ink += 1;
    }
  }
  return ink;
}

/**
 * R27: the floor title is the Latin token only. These three fixed slots were measured on one frame
 * (`map.png`: B 881–900, 1 906–913, F 922–938, ink rows 46–73) — one sample, so they are a safety
 * check, not a general title reader. A title that does not land in these slots is refused rather
 * than guessed, and the localized half is never matched.
 */
const TITLE_ROW_Y = 44;
const TITLE_ROW_H = 32;
const TITLE_SLOTS = [
  { char: 'B', x: 878, w: 25 },
  { char: '1', x: 903, w: 13 },
  { char: 'F', x: 918, w: 24 },
] as const;
/** `popup.png`'s dim overlay lowers the Latin match to 0.854; the HUD scores ≈0.05 (one sample). */
const TITLE_SLOT_NCC_FLOOR = 0.8;

/** G6 — the 36.0-px wall lattice. Pitch measured three ways; the phase is re-fitted every frame. */
const LATTICE_X = 474;
const LATTICE_Y = 160;
const LATTICE_W = 972;
const LATTICE_H = 740;
const LATTICE_INK_LUMA = 185;
const LATTICE_INK_SAT = 60;
/** A wall line must own at least this many lit pixels in its column/row to count as a line. */
const LATTICE_LINE_MIN_INK = 100;
const LATTICE_MIN_LINES = 8;
const TILE_PX = 36;
const PITCH_MIN = 35.5;
const PITCH_MAX = 36.5;
const PITCH_STEP = 0.05;
const PHASE_STEP = 0.1;
/**
 * G6's quality test — **support**, not residual.
 *
 * A lattice line is a line the fitted 36-px grid explains: its centre lies within
 * `LATTICE_SUPPORT_TOLERANCE` px of a cell boundary. Counting those is what a translucent map can
 * carry and a residual cannot. The FFXI floors draw the map over the 3D view, and the harken's light
 * column (white and unsaturated, so it counts as map ink) lights long runs of the row profile that
 * `lineCentres` turns into one point each. Such a point is no evidence against the grid — a lit band
 * cannot erase a wall line — but it is an outlier to a least-squares residual, and that is how the
 * live 2026-10-25 capture at `X: 7 Y: 24` was refused at 7.86 px against R29's 6.5 ceiling while
 * every other gate read the frame.
 *
 * Measured 2026-10-25 over every committed 1920×1080 frame, X-axis lines within 2 px of the fitted
 * grid: maps 9–19 (B1F 15, popup 19, 第四区 12, 第三区 10, its glow capture 9, the live capture 9);
 * non-maps at most 3 (the town HUDs 0–2, Dungeon Select 2, the rest fewer than eight detected
 * lines). The floor is 6 — three above the best non-map and three below the worst map — and the
 * presence test already requires eight detected lines, so a frame has to explain six of the lines it
 * found with one 36-px grid before it is read as a map.
 *
 * Only the X axis is gated. On the translucent floors the same glow crosses *rows* over the panel's
 * lower half, and the residual-optimal Y grid explains almost none of them (第三区's glow capture 2,
 * the live capture 1), so that axis cannot decide. Both axes are still fitted, because the chevron's
 * cell residual against that phase is what validates the chevron as the origin of the icon lattice
 * (≤6 px on every accepted frame; 0.69 / 1.18 px on the live capture). The glyph cells themselves
 * are placed from the chevron, not from this phase: a phase this contaminated cannot be trusted to
 * 2 px on a translucent frame, which is exactly the template search's reach.
 */
const LATTICE_SUPPORT_TOLERANCE = 2;
const LATTICE_SUPPORT_MIN = 6;
/** Confidence 1.0 needs the fitted 36-px grid's residual ≤ 2 px (research §9). */
const LATTICE_CLEAN_RMS = 2;
/** A chevron further than this from a cell centre has no trustworthy click origin (research §8). */
const CHEVRON_CELL_TOLERANCE = 6;

/** G5 — the party chevron is a yellow colour blob, not a shape template (research §4). */
const CHEVRON_R_MIN = 170;
const CHEVRON_G_MIN = 130;
const CHEVRON_B_MAX = 110;
const CHEVRON_RB_MIN = 90;
const CHEVRON_GB_MIN = 60;
/** The lossless fixture measures 125–135 px; JPEG chroma bleed reaches 124/127, so leave slack. */
const CHEVRON_AREA_MIN = 80;
const CHEVRON_AREA_MAX = 220;
const CHEVRON_W_MIN = 14;
const CHEVRON_W_MAX = 24;
const CHEVRON_H_MIN = 12;
const CHEVRON_H_MAX = 22;
/** The map content ends above the decorative chevron at the panel's bottom (research §4). */
const CHEVRON_SCAN_BOTTOM = 930;

/** Icon scan: a cell centre must sit inside this region for the template to fit the panel. */
const ICON_X_MIN = 460;
const ICON_X_MAX = 1710;
const ICON_Y_MIN = 140;
const ICON_Y_MAX = 920;
/** Templates are matched at a cell centre, with this integer search around it (± px). */
const ICON_OFFSET = 2;
/** Skip dark cells cheaply before paying for an NCC sweep. A chest glyph carries ≈125 lit px. */
const ICON_BRIGHT_MIN = 20;
const ICON_BRIGHT_LUMA = 150;
const ICON_BRIGHT_SAT = 60;
/** Chest: NCC 0.97–1.00 on every instance, nothing above 0.55 elsewhere (research §6). */
const CHEST_NCC_FLOOR = 0.9;
/**
 * Stairs: ~24×40 grey staircase, template cropped as a 36×36 cell at (25, 25). **One sample**,
 * template unproven (research §6, §9) — it is emitted only above a high floor and never used as the
 * sole basis for a cross-floor move.
 */
const STAIRS_NCC_FLOOR = 0.85;

/**
 * 楼梯-门: measured 1.000 at the icon's own cell on the FFXI 第三区-城内2F map and 0.92 at one pixel
 * off its centre (the lattice supplies that pixel); no other glyph on the map reaches it. Floor 0.85.
 */
const STAIR_DOOR_NCC_FLOOR = 0.85;
/** The stair-door's own search radius, once a seed has said a glyph is near. */
const STAIR_DOOR_OFFSET = 9;
/**
 * The seeds tried per cell before the sweep. The glyph is drawn a few px off the cell centre (measured
 * 2026-11-03: −4/−3 px on 第三区-城内2F, the same on two frames 6 cells apart), so a single sample at
 * the centre can score below the coarse floor while the glyph is right there.
 */
const STAIR_DOOR_SEEDS: readonly (readonly [number, number])[] = [
  [0, 0], [-4, -3], [4, 3], [-4, 3], [4, -3], [0, -3], [-4, 0], [4, 0], [0, 3],
];
/** The coarse score a seed must reach to justify the sweep: the glyph's own seeds measure 0.9+. */
const STAIR_DOOR_COARSE_FLOOR = 0.7;

/**
 * Hole — the white down-arrow over an oval, a 31×33 glyph inside a 36×36 cell (第三区 x 512–542,
 * y 466–498). Two instances in the corpus, both at cell centre + (−1, +1), NCC 1.00 and 0.98; the
 * best score anywhere else in any committed map frame is 0.65. One floor sample of the glyph, but a
 * two-instance floor and a 0.25 margin, so it is emitted.
 */
const HOLE_NCC_FLOOR = 0.9;

/**
 * Teleport — the orchid ring (the mobile art's `stair_teleport`). Colour, like the hazard, because
 * the ring's core is a saturated magenta that nothing else on the map draws: measured R≈148 G≈50
 * B≈188 over its most saturated pixels, five instances on 第四区 and **zero** false pixels on every
 * other committed frame. Area gates a ring (≈80 px) away from stray antialiasing (the combat
 * fixture leaks 8 px).
 */
const TELEPORT_R_MIN = 110;
const TELEPORT_G_MAX = 100;
const TELEPORT_B_MIN = 140;
const TELEPORT_B_MAX = 230;
const TELEPORT_BR_MIN = 25;
const TELEPORT_AREA_MIN = 30;

/**
 * Harken — the white 4-point sparkle, the point the party changes floor by (operator, 2026-10-24).
 * One glyph at two drawn sizes: 16 px on 第三区 (NCC 1.00) and 12 px on B1F (0.72) and 第四区 (0.72).
 * A single-scale template cannot carry it — at 16 px it scores 0.84 on the hole glyph and 0.78 on a
 * B1F background cell that outranks that floor's own sparkle — so both scales are matched and the
 * better score wins. With the ink gate below, the three instances score 1.00 / 0.72 / 0.72 and the
 * best impostor in the corpus is 0.63. The ink band also gates out the chest (≈125 px in the same
 * box is the top of the band, and it is a template match of its own).
 */
const HARKEN_NCC_FLOOR = 0.7;
const HARKEN_INK_MIN = 30;
const HARKEN_INK_MAX = 140;

/**
 * 楼梯-门 — the **door with the right arrow**, the stair entrance to the next floor (operator's name,
 * 2026-11-03: *name the icon as 楼梯-门, and use that to climb for the FFIX farm*). A 36×36 cell-sized
 * crop at (938,137) on `testdata/screens/2026-11-03-ffxi-map/map-1920.jpg`, including the bright cell
 * frame the icon sits in. Measured on that frame: 1.000 at the icon's own cell, best match anywhere
 * else 0.92 one pixel off its centre — the lattice enumeration supplies that pixel, so the cell is the
 * unit. The farm's area is close to the stair entrance, while the harken teleports far from it, so the
 * climb walks to this glyph and never to the harken.
 */
const STAIR_DOOR_TEMPLATE_B64 =
  'R0xQVFJSUE1JREJAQUFCQ0RDQUBBQ0FBQkFBQEFBQ0RCQklSTlFSUVFMUE1IQ0BAQEFFR0hGQj9BQ0VERERFRkZGRERDQ0pTT0tHRlNPTUtHQ0BAQEFDRkhHREFCQ0NBQEFCRENDQ0RDREpRU0xKUXN4eHd1dHNyc3Nxc3V2dnV0dHV0cnJzdHNzdXV1dnp+VU1OXZOdmpqZmZmZmZqampubmpmYmJybmpqam5ycm5qam52fTUVIWZafoJ+dm5qZmZmbm5uampufoaSioJ2amZiZmpmZm56gT0hNXJqfmJWRjIiGhYWChIeIipCaoauoopqQiYaFhoaGio6SSUtOW52alIiDenNzbGlrbnySoaSkp6mll6Wgn5V3b29vdYOFR0tPXZ2YjnxxaGFZUlpYboqco6SlpqaTamBxiZKQb2BaYmpwRElQXpyWiXViVlFGPUlgfpqioKGioKCUZTI4UXGYgGRRUlZiRElQX5yUhXVdSkg/OEmCk5+dm56fm5yfhzsaGzptj4FhUE9hR0pQX5yVgG1WRDwyO2KWmZqYmJucnJual1EcCxQud5J6VUlcTExQXZyWfWNPQjEmRoeWl5mamJWXmpySlWElDQgMQoOIY0RTUVBRXJuXfWBMPi8yXJqXmJqal5WVl5mWmG8sDgQIGWGGd0hPVFNSXJuXfGFMODFHcJiampiWl5ucmpWbmHc0EAEJCkd9hlBSWVtZYp6Ygl9PPSpcipWOjpOcmpqelJqYmHk4CwQGCipqkFxRW11faaWdg2NOODBllJheY4GZmZqem5mZmXc2DQgJByVnkV9TVlhdaqeeh3VkUE52mpNdL0F3mKGbm5yfnnk2DggGBiFjk2NUTU9TZKSempeMgX+LnI9iGxlIdpWYn5+fnns5DQUDCCBilGRSTEtOYKWkqqCAe3hxd2xDFhAaQHyVm6Ccmno5DQYHCiBilGRSTkxOYKiqr45CODctLSkaCwkDFUl4l6Khn3s3DAcKCCBilGRTT05PYamqtIgeEhAJBgcEBQsJAQxAfJOfpX02DgkGBCFllWRUUE9SY6mor4scFRIOBwkLCQMJCgMYOXeTpHs0EAoCAyJol2VVT1BSYqmrtIceGw8JCQgECAQKBQcNKmaWpno8DwQMByJnmWhVT1BSY6mrsYUfGA8KBwQSCQMLBQYZSH+epns8EQQGByJnmWhWUFBSZKqsuY4oFw4NCgsAAAYJBBhEfZumpnw7EgcFByJnmmlXUlFUZqysr488JRYSCwsRCgsGFUt9o6enpX04DwsIByJom2pYVFJVZ62rtbCQjISFfnpdIgsXSIagqKemqYM4DAkIByJonGxZVVNWaa2pp6mkoZObmZOCJBZFg6Wmp6iqrYc7DQgGCCNpnW1aVVNWaaummIuEdmeHn6F+M0Z7oqmkqqmoonk2DgkICCRqnm1bVFJWaKqkjXBfRzhsmaOLXoCapqqnqKegj2QqCwkJCSVrnm5bUVRWZq6kinNWPzZqm6egoaWqpKmunKF+SB0MDAoDBSRnoWtfUVRWaLGnjnJYRThpm6etqaitqKafg0stEgoJBgcMCCVqo2xfUFNWabGnkW9VRDNnn6qpqqiiiW5UMx0LAgoMBAIIBiJqpG1eUVNXarOokG1VQjBoo6mtrJt7TzIsIh8dHBwdHRsZHTN1pW5dUVRZbLWqjm9YQzNwqaqwq5NxT0FMUlBWVlFRV1dTUFuFn2xc';

/** Hazard: a translucent red bar with white spikes; colour is a difference rule (research §6). */
const HAZARD_RB_MIN = 45;
const HAZARD_RG_MIN = 40;
const HAZARD_R_MIN = 45;
const HAZARD_R_MAX = 210;
const HAZARD_G_MAX = 85;
const HAZARD_B_MAX = 85;
const HAZARD_WIDTH_MIN = 40;
const HAZARD_HEIGHT_MIN = 25;
const HAZARD_SCAN_BOTTOM = 900;

// ---------------------------------------------------------------------------------------------
// Glyph templates
// ---------------------------------------------------------------------------------------------

/**
 * Digits: 8×12 glyphs, one byte per pixel, luma after the research's normalisation (§3 step: crop
 * the 12-px ink row run, `(L−70)/170` clamped to [0,1], resize to 8×12). The set is what the corpus
 * measured: 0, 1, 2, 3, 4, 5, 7, 9 from the recordings, and **6 added 2026-11-07** when a floor's
 * readout first reached `X: 16` and every frame refused with `readout-digit-unmatched` — a digit the
 * atlas lacks is a map the loop cannot read at all. **8 is still missing** (no frame has carried it). A
 * glyph that falls below the match/margin floor returns `null`.
 *
 * Provenance (not run in CI): `scripts/extract-map-templates.mjs`. Digit 0/2/4 from `map.png`,
 * 9 from `popup.png`, 3 from a captured `007_017.png`, 7 from a captured `000_001.png`; the last two
 * come from the research corpus, not from a committed fixture. One sample per glyph.
 */
const DIGIT_TEMPLATE_B64: Readonly<Record<string, string>> = {
  '0': 'AAAAAAAAAAAAAAcZFgUAAAEjQxs8RwsACoRCABl+QwIsrzcAAYZ7BmO0LwAAf5gZd7QuAAB7oSZZtjMAAIGUFiWvPAADhnUGCH1QCyh9OwIBGz0sPjcHAAAAAQMEAQAA',
  '1': 'AAAAAAAAAAAAAAAKERUJACBNi62rhTgAAC5wucqlRgAAGUKbu6JGAAAWPZa4o0YAABY9lrikRgAAFjyWuKRGAAAXPpi8qkkACCxjtNjOZBIYM1h1hIRZNwAAAAEBAQAA',
  '2': 'AAAAAAAAAAAAAAAmLwwAAAAwhLHVuj8AAAAJDkTLhgQAAAAAAKR6BgAAAAAAnEwAAAAAAE9nCgAAAAAhbxYAAAAAM3YoAAAABlCssWx0bBoVV4GBfoFNDAAAAAAAAQAA',
  '3': 'AAAAAAAAAAAAAhcoJA8AACRNgKvBokUAAAAAHHzEeAkAAAAHVZZIAQAAIl+LawoAACFcntPUgQ8AAAAMR6TJVAAAAAAPXMJcPhcIBiFgjS1FOSMcOUwjAAACAwICAQAA',
  '4': 'AAAAAAAAAAAAAAAAAAseAAAAAAAcbaYAAAAAFWPKzwAAAAQ2itjPAAACFjlvus8ACk4pC0OzzwJUPxocX8LXKjgmGzZ8zt5PAAAADlrG2DMAAAAWR3d8TAAAAAAAAQIA',
  '5': 'AAAAAAAAAAAAAAAXOTwbAAAAfLz73WQAAAowKi8dAAAAcloeAAAAAADD7s97OgAAACiLz+/2KAEAAAAjc//EFAAAAAAIt+8jK0UQBwqkeAErXTshIU0AAAAAAwMAAAAA',
  // Measured live 2026-11-07: the floor's readout reached X:16 and every frame refused with
  // `readout-digit-unmatched` — the atlas had no 6. Cut from `testdata/screens/2026-11-07-map-refused/`
  // by scripts/extract-map-digit.ts (run index 3 of `X: 16  Y: 4`).
  '6': 'eHh4eHh4eHh4eHh4eHh5eHh4eHiHi3t4eHl/jId6eHh4go+Le3h4eHiUkoiHioB4fpuTgXqMmIOAm4h4eHyXjH6Xh3h4eJeNeI+LfHl8lYR4fIOCfYSCenh4eHl5eXh4',
  '7': 'AAAAAAAAAAAAHisrKSwqAkK51dXV1bsgLyAVEh1OTwAAAAAACmMBAAAAAABDYwAAAAAAKYQPAAAAAAJekQAAAAAAIoV7AAAAAABer1UAAAAAADtgIwAAAAAAAAAAAAAA',
  '9': 'AAAAAAAAAAAAAAQbHxEAAAA6XC0KZlEABKtkAAAssT8i2GEAAAPIdh7ahggAA8qLAIfCl1mG9HwADDI5Nm/QTgAAAAAUmHUIAAAJHmJwCAAAABsxJQAAAAAAAAAAAAAA',
};

/** Chest: 23×22 white line-art glyph at a cell centre (`map.png` x 1308–1329, y 594–616). */
const CHEST_TEMPLATE_B64 =
  'PjAjGhgXFxcXFxcXGBgYGBgYFxYWF1E6Fyk0ODg4ODg4ODg4ODg5ODYeEhuFUSBadX18fHx8fXx8fHx8fXx4RiAtq1sthaKjmpeYmJiYmJiXlpihqGovO6VKLoCHa01DRkdHSElJRUBIZpBjLjqlSi6BYTctREdISEhISEVANjGFYC06qVMuf1o7TYuOjIN/jI2NfFQphGEuOapYLnxYQF+wtK6Ne5+xtZ5lJn1eLTmPSSdlRzlgs7utc0x8s7ukZx1dSCQsSyAWMR8pYLO6oVwnR6m6pWUPIxkNEDUfFRwWKmKzuYA7DhyHsKdqDhcOCAxpMyNONzNdrbSMWjtHmLClbBlNNRoklUYvdVM0PnWUmo2Ch5SIbUQidlYpNahQNIduPSEyVX2VmY1kRisgOpFnMDyoTzSIkWQtFwwsTlU4FREYNG2obTA8p00xiqylgVErFg8PDA0qVYKjr2suO6dMMYqvtaqZhVMkCA5Nepqvt7FqLzymTDGJr7m4t7KSZ1Bkjae3vb2yay88qVEwhq+7u7y9tqafsrS4vL69tG0wPa9fL4Kvv769vb29vb29vb2+vbdwMT66cy+Jsr++vb29vb2+vr6+v762bzE9jFItcIqSkpSUlJSUlZSUlJWUjVwqK1MyHzY/QEFCQkJDQ0NDQ0NDQ0AtFxY=';
/**
 * Stairs: a 36×36 cell-sized crop at the one observed staircase (`map.png` x 1374–1409, y 156–191),
 * including the bright cell frame it sits in. **One sample; unproven** (research §6).
 */
const STAIRS_TEMPLATE_B64 =
  'i3xycnJyc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3NzdHWXeVI6Ojo6Ojo6Ojo4MzAwMDExMTExMTExMTExMTExMTExMTSFhWxdXV1dXV1dXVtQPC8vLy8vLy8vLy8vLy8vLy8vLy8vMDSFo661tbW1tbW1s66QWjEwMDAwMDAwMDAwMDAwMDAwMDAwMDSGnbXExMTExMTEwbyZWyspKSkpKSkpKSkpKSoqKystLi8wMDWGi6q+vr6+vr6+uraTVCMhICAgICAgICAgISIjJCUoKy4wMDSGd5y1tra2tra2sq6LTBoZGBgYGBgYGBgYGBkbHB4kKS0wMTWHZpCtrq6urq6uq6aDRBIQEBAQEBAQEBAQEBEUFhkgJi0xMTWHYIyrrKysrKysqaWBQg8NDQ0NDQ0NDQ0NDQ4RFBceJSwxMTWIWomqq6urq6urp6J9PAwKCgoKCgoKCgoKCgwPEhUcJCwxMTWJVYWoqampqamppZ94OBMQEBAQEBAOCwcHBwkMDxIbIywxMjaLUIOmp6enp6enpJ56RDAvLi4vLy8mFQUEBQcKDREaIiwyMjaMUIOmp6enp6enpaGNbmpub3BwcXFXLAYEBAcKDREaIiwyMzaNUYSnqKioqKiopqSckpSZm5ydnp57PggEBAcKDREaIiwyMzePUYWpqampqampqKaflpmgo6WmpqR8PQgFBQcKDREaIy0zNDiPUoWpqqqqqqqqqaiglZahpqioqKV2NwgFBQcKDREaJC0zNDiQUoaqq6urq6urq6mglJSgqKurqqV3PRQSEhQWGh0nKC40NDmRUoarq6urq6urq6qhlJWiqaysrKeGWjg5Ojs+QkVNNS40NTmSUYOnp6enp6enp6aelJWkq62tramZfm6DhoqNkJKaTS40NTmSSXKQkJGQkJCQkI+MjJiora6urqyhkoyapKisrrG4Vy40NTmSQWF5eXl5eHh4d3h8iJqrr6+vrq2kmZWgrbK1t7rBWi80NTmSPVdsbGxsa2traWp0h5urr6+vr66lmpahrrK1uLrCWS81NTmTPlhsbW1sa2tra2t1iJyrr6+vr6+nm5ejrrO2ubvCWS40NTmTP1pvb29vb29vbm52hpyssLCwsLCnm5emr7S3ubzCWS40NTmTQFtvb29vb29vbm91gpKipqampqafmJinsLS3ubvDWS41NTqTQFtvb29vb29vb29yeYOMjo6NjI2NkJmpsLW4urzDWi81NjqURV9ycnJycnJycXFyc3h5eXl5d3h+jJ6ts7e6vL7DWi81NjqVUWd4eHh4eHh3d3d3dnZ1dXV0c3R8jqWztru+v8DFXDA1NjqWYnOAgICAgIB/f39/f39/f39/fX2Cjp+ws7e7vcHJXzE2NzuXc36IiIiIiIiIiIeHh4iIiIiHh4eKjpSaoaGjo6KlVTM2NzuYgYmPj4+Pj4+Pj4+PkJCQkJCPj4+QkJCSlZWWlpaWUTM2NzuZj5OWlpaWlpaWlpaWl5eXlpaWlpWVlJSTk5SVlZWXUjQ2NzuZnJybm5ubm5ubnJycnJycnJubm5qampqampqbm5qaVDU2Nzuap6OgoKCgoKGhoaGhoaGhoaCgoKCgoKCgoKCgoJ+eVjY2NzuZr6uqqqqqq6urq6urq6uqqqmpqampqampqaqqqqmneGJiYmWmlHl5eXp8fX18e3t6enh2dXV0dHR0dXV1dnd5ent6aWBeXFxz';

/** The three Latin floor-title glyphs, one sample each (research §2; R27). */
const TITLE_TEMPLATE_B64: Readonly<Record<string, string>> = {
  B: 'GBcXFxgYGBgXGBgYGBgYGRkZGRkZGRoZGRkYFxcXFxcXGBkZGRkZGRkZGRkaGhoZGRkZGRgXFxcXFxgZGRkaGRkZGRkZGRkZGRkZGRkYFxcWFxcXGBkaGhoZGRkZGRkZGBgZGRgWGRgYGBgYGBgYFxQRDg0PExgZGBgYGRkWFzBYY2RkZGRkY2JfWlJJPTAYFBYYGBkaFh5TxPL///3m397f4OLi17qGNx0WFxkaGRsYEkvC///1TB4WGiM1eMf69u+TOAwbGhobGhYlsf//8z0XFRcZHCVLmf//5X4hGBoaGxsZGav///M8GhscHBoUFlbn/P+3VBMaGxsbGhaq///zPBobHBwbGw88y/n/1XoOGhsbGhkWqv//8zwaGxwbGxsSO774/9J2DxkaGRkYFqr///M8GhscGxsbDzzM+f+rRBQaGhkZGBaq///zPBocHBwbEhdc8P3ldhYZGxsaGRcWqv//8zwRDAwMDCVovfe/dTMSGhoaGxoYFqr///iAYFpaXF+BxvjfgCYMFRoaGhwcGRaq///90sfFxsrQ2unqyoJLJxcYGhodHBsWqv//8z4NBAQECTiH1v78+KA3CRkbHR0cF6r///M8FxQVFRcdJVC09/7qnyYYGR0dHBeq///zPBscHBwbGhUdUOf9/tVwFBcdHh0Xqv//8zwbHR4cHBwcFBrZ+//usRIVHR4dF6r///M8HB4eHR0dHRUZ0vj/+M4SFR0eHReq///zPBwdHx4dHBsUGdL4//bHEhUcHBoWqv//8zwaGxsbGhoZEhja+//lmhIVHBwaGaz///M8GhsbGxoYER9k6v78xEkWGB0bFiuz///zPBMQEBAPFjZywPj9zHMXGRsdGhhizP//9mhBOjo6OkmP3fXbx28cERscGhow0PX39/f39/f39/b18erSXBgKFh0cHBkRCSMqKioqKioqKioqKSkpKB4ZGRweHh4cGBMTERAQERITExMTExMUFBUaHR0dHR4eHR0cHBsbGxwdHh4eHx8fHh4fHx4eHR0dHR0cHBwbHBwcHR4eHh4fHh4eHh4eHR0dHBw=',
  '1': 'GRkYGBgYGBkYGBgYGBkaGRgYGBgYFxcYGBgZGRgXGBgYGBgYGBgZGRkZGBgYGBkYGBgZGBoaGRkZGBcVERQXGRgaGhoZFhMYKTskGxgYGRkZFxcbN2+rVycYGhkZFAM+nOL1+XowFxoaFSCUxuj7//98MRcaGxQVW3rH////fDEXGxoXDgkPlf3//3wxGBsaGxsaB4z8//98MhkcGhoaGgiN/P//fDIZHBsaGhoIjfz//3wyGRwaGhoaCI38//98MhkbGhoaGgiN/P//fDEYGxoZGhoIjfz//3wxFxoaGhoaCI38//98MRgbGhoaGwiN/P//fDEYHBoaGhsIjfz//3wxGRsbGhobCI38//98MhkbHBsbGwiN/P//fDIZHB0dHR0Jjfz//3wyGRsbGxoaCI38//98MRgaGxoaGQeN/P//gjMWGxsaGRQHjv3//6pDEBkcGhgdNan////keCcZHBgZUcv09/f399+KHh4VCA4iKSoqKiomGAgdGhMSEhISEhISExMUHR0cHB0dHRwcHB0eHx0dHR0dHR0cHBwdHR4=',
  F: 'FxgYGBcXFxcXFxcXFxcXFxcWFhcXFxcXGBgXFxcYGBcXFxcXFxcXFxcXFxcXGBgYFxcXFxcYGBgYFxcXFxcWFhYXFxgYGBgXGBgYFxcXFxcXFhcXFxYWFhYXFxcXFxcXGBcWGRgYGBgYGBgYGBgYGBgYGBgVFRYXGRYXLVZiZGRkZGRkZGRkZGRkZGRPKxMYGRYdSrvv///+5t/e3t7e3+Lq+P7OXw0ZGhoXEjW3///2UiAWFhYXHjNrzvnlbgsYGhoZFhmq///1QxgTFBMUFhokPqDLbQsYGhkZGBGm///1QhoYGRkZGRgUEjx2Sw8YGhkZGA+m///1QhsZGRkZGRkZFwsrJhQZGxoZGA+m///1QhsZGhoaGhkYFxkWFxoZGxsaGRCm///1QhsZGhoaGhQODhcZGRkaGxsaGRCm///1QhsZGhoaFhIpXhoXGhoaGxsaGRCm///1QhILCwsLEE+OfhkWGRoaGxsaGhCm///5h2RdXV1eZ67YgxkVGRkaGxsaGhCm///92c7Ly8zO1ufZgxkUGRkZGxsbGxCm///1RA8EBAQEIny8gxkWGhoaHBwbGhCm///1QhcUFBQUFydNeRsXGxsaGxsbGhCm///1QhsZGhkZFxMcORgYGhoaGxobGxCm///1QhsYGhkZGRcTExgaGhoaGxoaGxCm///1QhsYGhoaGhobGxoaGhkZGxsaGhCm///1QhsYGhobGxsbGxoaGhoaGhkZGRCm///1QhoXGBgZGRkZGRkZGRgYGhoaGROn///2SBwXGRkZGRkZGRkZGRgYHBsaFx2s///4dCkTGRkZGRkZGRkaGhoaHBwaFk/C///7vU0XGBoaGhoaGhobGxsbHBoYIcv09/f39pA2DxsbGxsbGxsbGxscHRoSByMpKioqKhkMDRoaGxsbGxscHBwcHh0ZEhISEhIREhITFhsbGxscHBwcHBwcHx4dHR0dHBwbHBwcHBwcHB0dHR0dHB0dHx8eHh0dHBwcHB0dHR0dHR0dHh0dHR0d',
};

interface Template {
  readonly w: number;
  readonly h: number;
  /** Mean-subtracted, unit-norm luma values; `sum` is ≈0 and kept so crop NCC shares one formula. */
  readonly values: Float64Array;
  readonly sum: number;
}

function decodeTemplate(base64: string, w: number, h: number): Template {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== w * h) {
    throw new Error(`map template is ${bytes.length} bytes, expected ${w * h}`);
  }
  return normaliseTemplate(bytes, w, h);
}

function normaliseTemplate(bytes: Uint8Array | readonly number[], w: number, h: number): Template {
  const values = new Float64Array(w * h);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = bytes[i] ?? 0;
    values[i] = value;
    sum += value;
  }
  const mean = sum / values.length;
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    values[i] -= mean;
    normSq += values[i] * values[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) for (let i = 0; i < values.length; i += 1) values[i] /= norm;
  return { w, h, values, sum: 0 };
}

const DIGIT_TEMPLATES: ReadonlyArray<{ digit: string; template: Template }> = Object.entries(
  DIGIT_TEMPLATE_B64,
).map(([digit, base64]) => ({ digit, template: decodeTemplate(base64, 8, 12) }));
const CHEST_TEMPLATE = decodeTemplate(CHEST_TEMPLATE_B64, 22, 23);
/**
 * Hole: a 36×36 cell-sized crop at the first instance (`third-floor.jpg` x 509–544, y 464–499),
 * including the bright cell frame it sits in. Two samples on one floor; the second matches at 0.98.
 */
const HOLE_TEMPLATE_B64 =
  'RENBVllbVlBMRTw+OCxQSkhGQEBGQzcyOj07Ojk5Oz5APz86Q0A8S1FUUUxIQTgnIiVfaWtraXNxWDAcJTAwMjExNDc4NzQ3Qz42PERISEZCOS8jHzGFoaenqaikejYQFyUlKSgoKSssKikyR0A0MjtCQ0I8MCYbFS2Rtbi2ure6jj8QFyQeJSQkJSYmJCMwTEQ1MTpERUM8LyQbEiuRtLWvs661jjwNFCMeJSMkJScnJiMvTkY1MzxGSEY/MiciGzSWt7m1t7K1ijoJEiMkJiUlJykqJyUvTUUzMDlCRUM+MyoWFjCPrrWys7q3iToLDyEkIyMjJigpKCYuSkMxKDI7Pz46MigTGDWRsLm4t7mzhjwMChgbICAgIycoJyUsS0kyKykwPD0yJiIUCjSRubO5ra+3jjkEChoWFxcfIx0gKCQwS0cwKCwxMy0iGxkWDTGHsLG7s8G1h0MZFhoTHRMWHx4iKCUuSkUuKCwvMztGUFNUS1yYtLK7tbmrjGZPS0pITS4fIyIhIyEsSUUtKyknL0tzk6Cjmpaxu7K4s7O2saOcnp6bckIjISEfISIqSUYvKSklIzFajK24u6+0t661s6+7vbe6vq2SVSkSGh8hJCQqSkk0JiwtIhYnWYajvLa2t6+3uLK1sayzrYNQJw8NHSQkJCAqS0w5LCsuLR8ZME95qbS3vLW5usG+ubWqjFkuFhAaJiUkIx0qS04+NSQhMTMhFhxHiKSvubS4urq5ubGOVScTFBUhJR8hJyMrSUpEPDAqLjEqGxITT42rsre7u7bEv5VSHg8VFxoeICAhIiMvS0tEPjUtLC4sIhcNG0N9qLOysrGwkFIgEA8MHB8iIyIiIyUsTUxEPzsyKiswKh0bDRhLh6mztbGSXSkQEhseICIkJCIhISMpTkxCPD85LC02MCIYFhAaRX+lr4hTJhwaERYoIiMkIyAfHyApTkk9OUE/NDI5MiQYGxMKHEt7k0kiDRskGhooIiMjIiAfICIqTUY4Nj0+ODUzLSIjFAsPFR02ThsTDxMdJCIdHh8gICAhIyYsSUAwLjI0MywlHxsYCwUMDwoMFAwODg0RFhIKFRcZGhwfIyYtRz0sKCcoKCEXERMSHB4ZHikqISUbGyUkFQ0RDA4RExYaICQuQzgpIhQTISUjL0dNVWJveXx6eXp5d3FrX0w6MRsUGRcWGBUeRzUbDhYmOlRreoCVmqGpsLKysqytq6inpJmNe15KPSMQEhkeQCUMIEZpeY+st66vsLK0t7m6u7e3tbO3u7q1s52TiWhAIg8ZLxgZVYiws7C8wLi1tLOzs7S0tbS0srC0ury5vLW3ua2QVxwXJSVRkKzCv7W2uLe7vLy8vLu6uba4t7W3vL26ury5sba9llUhKDh+t7i3tLS3ubi0tbe4ubi2tbG1t7W2ubm2tsLBrq7CsHwvKy5kp6+zsbO7vbm4uLm5u7u7u7i8vbu6vby6tLzBu7e5nGkvKhQscpi1tbC3vLq9vLu6u7y/wLq+vbi2uLi1uK6vuLutfkglLh8RL2CXsLS2uLnBv7y8vr++vL28u7u8u7i2tK+1u6VvNREdNCcZEyxMZHaJnam1uLu/wcC+vcHAwcC+uLCqppF5ZEwxHxowOTAjHRodKDlMYG+FjpqlrK6vrqaloJuShHRrXk88LB0WHiw+Pjo0MiEXGRwaHiQ7Q1FbY2RnZ2VjXVZOQTIpERMYHBwdJjFC';

/**
 * Harken: two matched scales of the same glyph, both cut from its one clean instance
 * (`third-floor.jpg` x 700–716, y 221–237) — the 16 px drawing itself, and the 12 px drawing the
 * other two floors use, produced by Lanczos downscale.
 */
const HARKEN_TEMPLATE_B64_16 =
  'Hx8eHigaK26UZComIiIiIx0dHR0lHkWTsoFBJSIiIiIcGxsZHjFopr2hXyEhISAiHBkaICZIorq5r5UwIyAhJCQiISIyW62/v7eiVDgoHSAgIictUnyytrq4r4ZINiYhJjJOZn2arKOptrmxgXFZPUhigJSQoZuTnrS7xLapj26TpaGUh5CGi5Wusby7urivprWrloWKg5GQq6+6u8DEwFt2jZaYl46flK+6x8C4oX41RFhkkZelp6Ksu7qceldCJiw4QWKDtayxtr2QWUMvKh8fIyc5bL2zwL60XS8jGyEiISEkKVGguL+1kzgpIR8lICEiJCUyara2o2MmHxweIw==';
const HARKEN_TEMPLATE_B64_12 =
  'Hx4gJB1qlkcjIyIjHBwcHzeSuG8mISIhHBoeI263uqM/HyIjIyAgOIvCvLRrMSAeIC5EbaKwsbmhYEUtRGiLlKKWo7nBr5VroqyXiImImrC3vL25iaCbkIqSmLG+wb6pOVVwlJ2lobXAonVNJC05XaC1sr+TSy8mICAjMYy8vrdbJB4hISIkJVKsu4wzHh4j';

const STAIRS_TEMPLATE = decodeTemplate(STAIRS_TEMPLATE_B64, 36, 36);
const STAIR_DOOR_TEMPLATE = decodeTemplate(STAIR_DOOR_TEMPLATE_B64, 36, 36);
const HOLE_TEMPLATE = decodeTemplate(HOLE_TEMPLATE_B64, 36, 36);
const HARKEN_TEMPLATES = [
  decodeTemplate(HARKEN_TEMPLATE_B64_16, 16, 16),
  decodeTemplate(HARKEN_TEMPLATE_B64_12, 12, 12),
];
const TITLE_TEMPLATES: Readonly<Record<string, Template>> = Object.fromEntries(
  Object.entries(TITLE_TEMPLATE_B64).map(([char, base64]) => {
    const slot = TITLE_SLOTS.find((entry) => entry.char === char);
    if (!slot) throw new Error(`map title template '${char}' has no slot`);
    return [char, decodeTemplate(base64, slot.w, TITLE_ROW_H)];
  }),
);

// ---------------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------------

interface ParsedMap {
  readonly map: MapState;
  readonly confidence: number;
}

/**
 * Why the parser refused a frame: one name per measured gate, in the order the parser asks them.
 * Observability only — the gates, their order and their thresholds are unchanged by the naming.
 * The readout's interior gates are named too, because R28/R28a/R28b/R28c were all diagnosed inside
 * that reader, and a bare `readout` would send the next incident back to a bisect.
 */
export type MapRefusalGate =
  | 'unsupported-size'
  | 'uniform-frame'
  | 'decode-failed'
  | 'readout-labels'
  | 'readout-label-width'
  | 'readout-runs'
  | 'readout-digit-width'
  | 'readout-digit-unmatched'
  | 'readout-parse'
  | 'title-bar-light'
  | 'map-ink'
  | 'no-title'
  | 'no-lattice'
  | 'lattice-support'
  | 'no-chevron';

/** The parser's whole answer: the map it read, or the gate that refused the frame. */
export type MapParse =
  | ({ readonly ok: true } & ParsedMap)
  | { readonly ok: false; readonly gate: MapRefusalGate };

/**
 * Read the map out of one frame, or name the gate that refused it. This is the reader a diagnosis
 * uses: a saved live frame answers "which measured gate" in one call.
 */
export async function readMapDetailed(frame: Frame): Promise<MapParse> {
  return parse(frame);
}

/**
 * Read the map out of one frame. `null` is the answer for every refusal: the frame is another size,
 * uniform, not the map screen, or carries a readout/lattice/chevron this parser cannot trust.
 * `readMapDetailed` answers the same question with the gate's name.
 */
export async function readMap(frame: Frame): Promise<MapState | null> {
  const parsed = await parse(frame);
  return parsed.ok ? parsed.map : null;
}

/**
 * A grid target's screen point: the inverse of the transform `findIcons` places icons with, and the
 * point a pointer-mode tap is sent to (contracts §3 `origin`).
 *
 * The map canvas scrolls (measured 21, 72 and 210 px on one floor), so there is no absolute origin to
 * use instead — the chevron is the only anchor, it sits at the centre of the party's cell, and a cell
 * is 36.0 px square on both axes with y counted **upward** in the grid and downward on the screen.
 * The result is rounded because a tap is a pixel.
 */
export function tileOnScreen(map: MapState, tile: Point): Point {
  return {
    x: Math.round(map.origin.x + (tile.x - map.player.x) * TILE_PX),
    y: Math.round(map.origin.y - (tile.y - map.player.y) * TILE_PX),
  };
}

/** A `Perceiver` over the dungeon map. `unknown` (confidence 0) is its refusal. */
export class MapPerceiver implements Perceiver {
  /**
   * `ocr` is the optional escalation (operator, 2026-11-07): when the readout's digits cannot be
   * classified but the line is there, the band is handed to an OCR package and its numbers are fed
   * back into the same parse. Off is the default — it costs a process, and only a refused frame pays.
   */
  constructor(private readonly ocr?: OcrReadout) {}

  async observe(frame: Frame): Promise<Observation> {
    const parsed = await this.#parse(frame);
    if (!parsed.ok) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    return {
      screen: 'dungeonmap',
      atMs: frame.atMs,
      confidence: parsed.confidence,
      map: parsed.map,
    };
  }

  /** The parse, with the OCR escalation on a refused readout. */
  async #parse(frame: Frame): Promise<MapParse> {
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return { ok: false, gate: 'decode-failed' };
    }
    const first = parseImage(image);
    if (first.ok || this.ocr === undefined || !isReadoutGate(first.gate)) return first;
    const numbers = await readNumbersViaOcr(image, READOUT_BAND, this.ocr);
    if (numbers === null) return first;
    return parseImage(image, { readout: numbers });
  }
}

async function parse(frame: Frame): Promise<MapParse> {
  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch {
    // Failure is a value (contracts §0.6): a decode failure is "not observed", not a throw — and it
    // is its own gate, never the same answer as "this frame is not the map".
    return { ok: false, gate: 'decode-failed' };
  }
  return parseImage(image);
}

function parseImage(image: RgbaImage, options?: { readonly readout?: Point }): MapParse {
  const { data, width, height } = image;

  // 0. Size and uniformity -------------------------------------------------------------------
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT) return { ok: false, gate: 'unsupported-size' };
  if (isUniform(data, width, height)) return { ok: false, gate: 'uniform-frame' };

  // 1. G1: the coordinate readout ------------------------------------------------------------
  //    A readout the digit reader could not name may still be readable by the OCR escalation; the
  //    caller hands the numbers back in and the rest of the parse runs unchanged (2026-11-07).
  const parsedReadout = readReadout(data, width);
  const readout = parsedReadout.ok
    ? parsedReadout
    : options?.readout === undefined
      ? parsedReadout
      : { ok: true as const, x: options.readout.x, y: options.readout.y, margins: [] };
  if (!readout.ok) return readout;

  // 2. G2: the title bar's dark strip --------------------------------------------------------
  //    The panel is drawn translucent over the 3-D scene, so this strip is only dark when the
  //    camera behind it is: the 2026-10-24 captures read 30-34 mean luma, a lava-lit 第四区 frame
  //    read 64.7 (live 2026-11-01) and was refused although a human reads the same map instantly.
  //    The title's own ink is the backdrop-independent evidence, so the strip is accepted when
  //    either proof is there; a 3-D frame has neither.
  if (darkFraction(data, width) < TITLE_BAR_DARK_FRACTION && titleBarInk(image) < TITLE_BAR_INK_MIN) {
    return { ok: false, gate: 'title-bar-light' };
  }

  // 3. One scan of the map panel feeds G3, G6's profiles, and both colour blobs. ---------------
  const panel = scanPanel(data, width);
  if (panel.mapInk < MAP_INK_MIN || panel.mapInk > MAP_INK_MAX) return { ok: false, gate: 'map-ink' };

  // 4. G4 + R27: a centred Latin floor token that lands in the measured slots. ----------------
  const title = readTitle(image);
  if (!title) return { ok: false, gate: 'no-title' };

  // 5. G6: the wall lattice ----------------------------------------------------------------
  // Both axes must be *present* (a fit over ≥8 detected lines); the quality test is the X axis's
  // support — the FFXI glow that defeats a residual crosses the Y profile, not the X one.
  const latticeX = fitLattice(panel.columns, LATTICE_X);
  const latticeY = fitLattice(panel.rows, LATTICE_Y);
  if (!latticeX || !latticeY) return { ok: false, gate: 'no-lattice' };
  if (latticeX.support < LATTICE_SUPPORT_MIN) return { ok: false, gate: 'lattice-support' };

  // 6. G5: the chevron (the click origin) ----------------------------------------------------
  const chevron = findChevron(panel.yellow, width, latticeX.phase, latticeY.phase);
  if (!chevron) return { ok: false, gate: 'no-chevron' };

  // 7. Icons, enumerated on the **map's own cell grid**. -------------------------------------
  // The chevron is the anchor the *click* transform is defined from (contracts §3 `origin`), but it
  // is not the icon grid: the chevron moves with the party on a fixed map panel, so anchoring the
  // search on it leaves the glyphs of a floor between cells whenever the party's pixel is off the
  // grid. Measured 2026-11-03: the 楼梯-门 glyph sat 4.7 px from the chevron-anchored cell and the
  // ±3 px template window missed it (the chest/hole/harken glyphs happened to sit closer and read);
  // enumerating from the fitted lattice phase puts every glyph back on a cell centre. The phase can
  // be a couple px off on a translucent floor (2026-10-31 第四区: 3.1 px) — the ±3 window absorbs it.
  const icons = findIcons(data, width, panel, readout, chevron);

  const map: MapState = {
    floorTitle: title.text,
    titleKey: title.key,
    player: { x: readout.x, y: readout.y },
    // The chevron *is* the anchor the icons were placed from (toGrid): publishing it is what lets
    // a consumer invert that transform without re-measuring the canvas.
    origin: { x: chevron.x, y: chevron.y },
    icons,
  };

  let confidence = 1;
  if (Math.min(...readout.margins) < DIGIT_CONFIDENT_MARGIN) confidence = 0.85;
  if (Math.max(latticeX.rms, latticeY.rms) > LATTICE_CLEAN_RMS) confidence = Math.min(confidence, 0.8);
  if (Math.max(chevron.residualX, chevron.residualY) > 1) confidence = Math.min(confidence, 0.9);
  if (title.minNcc < 0.9) confidence = Math.min(confidence, 0.85);
  // An unnamed (non-Latin) title is a weaker gate than three matched glyphs, never a stronger one.
  if (title.text === '') confidence = Math.min(confidence, 0.85);

  return { ok: true, map, confidence };
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

function isUniform(data: Uint8Array, width: number, height: number): boolean {
  let sum = 0;
  let sumSq = 0;
  let samples = 0;
  for (let y = 0; y < height; y += UNIFORM_SAMPLE_STRIDE) {
    const row = y * width;
    for (let x = 0; x < width; x += UNIFORM_SAMPLE_STRIDE) {
      const luma = lumaAt(data, (row + x) * 4);
      sum += luma;
      sumSq += luma * luma;
      samples += 1;
    }
  }
  const mean = sum / samples;
  const variance = sumSq / samples - mean * mean;
  return Math.sqrt(Math.max(0, variance)) < UNIFORM_STD || mean < UNIFORM_MEAN;
}

function darkFraction(data: Uint8Array, width: number): number {
  let dark = 0;
  for (let y = TITLE_BAR_Y; y < TITLE_BAR_Y + TITLE_BAR_H; y += 1) {
    const row = y * width;
    for (let x = TITLE_BAR_X; x < TITLE_BAR_X + TITLE_BAR_W; x += 1) {
      if (lumaAt(data, (row + x) * 4) < TITLE_BAR_DARK_LUMA) dark += 1;
    }
  }
  return dark / (TITLE_BAR_W * TITLE_BAR_H);
}

// ---------------------------------------------------------------------------------------------
// G1 — the readout
// ---------------------------------------------------------------------------------------------

interface Readout {
  readonly x: number;
  readonly y: number;
  readonly margins: readonly number[];
}

/** The readout's own answer: the digits it read, or the gate inside G1 that refused them. */
type ReadoutParse = ({ readonly ok: true } & Readout) | { readonly ok: false; readonly gate: MapRefusalGate };

function readReadout(data: Uint8Array, width: number): ReadoutParse {
  // The map panel is drawn translucent over the 3-D scene: on a lava-lit floor the whole readout
  // band sits above the ink threshold (live 2026-11-01, 第三区: every column lit through the band,
  // so every column looked like chrome) and the absolute threshold read nothing. Shift the band
  // down by its own median when that median is bright: the dark captures measure 20-40 and are
  // untouched (shift 0), and a bright one lands the background back under the threshold with the
  // glyph's contrast intact — the same frame the raw luma refused.
  const samples: number[] = [];
  for (let y = READOUT_Y; y < READOUT_Y + READOUT_H; y += 1) {
    const row = y * width;
    for (let x = 0; x < READOUT_W; x += 1) samples.push(lumaAt(data, (row + READOUT_X + x) * 4));
  }
  samples.sort((a, b) => a - b);
  const bandMedian = samples[Math.floor(samples.length / 2)]!;
  const shift = Math.max(0, Math.round(bandMedian - 70));
  const columnInk = new Uint8Array(READOUT_W);
  for (let y = READOUT_Y; y < READOUT_Y + READOUT_H; y += 1) {
    const row = y * width;
    for (let x = 0; x < READOUT_W; x += 1) {
      if (lumaAt(data, (row + READOUT_X + x) * 4) - shift > READOUT_INK_LUMA) columnInk[x] += 1;
    }
  }

  // R28: a column lit through the whole band is UI chrome — the map panel's border scrolls into
  // this band on some frames and merges with the last digit, which used to make `X: 13 Y: 23`
  // unreadable. A glyph never fills all 16 rows; the border does.
  const lit = new Uint8Array(READOUT_W);
  for (let x = 0; x < READOUT_W; x += 1) {
    lit[x] = columnInk[x] >= READOUT_INK_ROWS_MIN && columnInk[x] < READOUT_CHROME_ROWS ? 1 : 0;
  }

  // R30 (2026-11-08): the chrome filter drops a column lit through most of the band, and a digit's
  // own column can be that bright. Live 第四区-城内2F: `X: 13 Y: 2` drew the 3's fourth column at 13
  // of 16 rows, so the filter cut the glyph in two, G1 counted three digit runs and refused with
  // `readout-runs` — 5.5 min of a legible map read as an unnamed frame. A hidden column is not a
  // separator: when it is the only column between two runs, the runs are one glyph. A real gap is
  // dark in that column (ink 0), so nothing else is stitched.
  const allRuns: Array<[number, number]> = [];
  for (const [from, to] of columnRuns(lit)) {
    const previous = allRuns[allRuns.length - 1];
    if (previous !== undefined && from - previous[1] === 2 && columnInk[from - 1]! >= READOUT_CHROME_ROWS) {
      previous[1] = to;
    } else {
      allRuns.push([from, to]);
    }
  }
  // A run touching the band's first column carries the panel's left border (R28c). On a live frame
  // the border can fuse with the X label itself — 2026-11-01, 第三区: one run 0..23 against the
  // fixture's 8..19 and 21..23 — and dropping the run dropped the label with it (`readout-labels`,
  // the farm loop's unexplained unknown). Trim the border part instead when the rest is label-sized
  // at the measured slot; a run with no such tail is the border alone and still goes.
  while (allRuns.length > 0 && allRuns[0]![0] === 0) {
    const [from, to] = allRuns[0]!;
    const labelStart = Math.max(from, READOUT_LABEL_X[0] - READOUT_X);
    const width = to - labelStart + 1;
    if (width >= READOUT_LABEL_MIN_W && width <= READOUT_LABEL_MAX_W + 5) {
      allRuns[0] = [labelStart, to];
      break;
    }
    allRuns.shift();
  }
  const runs = allRuns;
  const labelAt = (expected: number): number =>
    runs.findIndex(([from]) => Math.abs(READOUT_X + from - expected) <= READOUT_LABEL_TOLERANCE);
  const xLabel = labelAt(READOUT_LABEL_X[0]);
  const yLabel = labelAt(READOUT_LABEL_X[1]);
  if (xLabel < 0 || yLabel < 0 || yLabel <= xLabel + 1) return { ok: false, gate: 'readout-labels' };

  for (const index of [xLabel, yLabel]) {
    const [from, to] = runs[index]!;
    // A label may carry its colon when the two touch (17–18 px); anything wider is another glyph.
    if (to - from + 1 < READOUT_LABEL_MIN_W || to - from + 1 > READOUT_LABEL_MAX_W + 5) {
      return { ok: false, gate: 'readout-label-width' };
    }
  }

  // One or two digits per axis: a corridor reads `X: 7`, a side corridor `X: 13`. The colon is the
  // narrow run right after each label and is not a digit; when it touches the label it is already
  // part of that run (R28a, R28c).
  const colonAfter = (label: number, limit: number): boolean => {
    const run = runs[label + 1];
    if (run === undefined || label + 1 >= limit) return false;
    return run[0] - runs[label]![1] <= 6 && run[1] - run[0] + 1 <= 4;
  };
  const xFrom = xLabel + (colonAfter(xLabel, yLabel) ? 2 : 1);
  const yFrom = yLabel + (colonAfter(yLabel, runs.length) ? 2 : 1);
  const xRuns = runs.slice(xFrom, yLabel);
  const yRuns = runs.slice(yFrom);
  if (xRuns.length < 1 || xRuns.length > 2 || yRuns.length < 1 || yRuns.length > 2) {
    return { ok: false, gate: 'readout-runs' };
  }

  const digits: string[] = [];
  const margins: number[] = [];
  for (const [from, to] of [...xRuns, ...yRuns]) {
    if (to - from + 1 < READOUT_DIGIT_MIN_W || to - from + 1 > READOUT_DIGIT_MAX_W) {
      return { ok: false, gate: 'readout-digit-width' };
    }
    const match = readDigit(data, width, from, to, shift);
    if (!match) return { ok: false, gate: 'readout-digit-unmatched' };
    digits.push(match.digit);
    margins.push(match.margin);
  }

  const x = Number(digits.slice(0, xRuns.length).join(''));
  const y = Number(digits.slice(xRuns.length).join(''));
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, gate: 'readout-parse' };
  return { ok: true, x, y, margins };
}

/**
 * One digit, with the panel's glow at the band's right edge tolerated (R28b). The map panel draws a
 * scrollbar whose left edge bleeds into the band and lengthens the last glyph; a digit that does not
 * match over its full span is retried with up to five columns trimmed from its right edge, and the
 * first match wins. A glyph trimmed past its own ink is refused like any other.
 */
function readDigit(
  data: Uint8Array,
  width: number,
  from: number,
  to: number,
  shift: number,
): { digit: string; margin: number } | null {
  for (let trim = 0; trim <= 5; trim += 1) {
    const end = to - trim;
    if (end - from + 1 < READOUT_DIGIT_MIN_W) return null;
    const feature = glyphFeature(data, width, READOUT_X + from, READOUT_X + end, shift);
    if (!feature) continue;
    const match = matchDigit(feature);
    if (match) return match;
  }
  return null;
}

/**
 * Runs of lit columns over the readout band; a run narrower than two columns is noise.
 *
 * The research prose says "gaps ≤ 1 col merged", but its segmentation code merges only segments
 * that are already adjacent — a no-op for every measured glyph. Merging the one empty column
 * between two digits would collapse the eight-run structure this gate depends on, so the runs stay
 * as measured: `X`, `:`, digit, digit, `Y`, `:`, digit, digit.
 */
function columnRuns(columnInk: Uint8Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < columnInk.length; x += 1) {
    if (columnInk[x] > 0) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start >= 2) runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0 && columnInk.length - start >= 2) runs.push([start, columnInk.length - 1]);
  return runs;
}

/**
 * The 8×12 digit feature: the 12 ink rows in the run, `(L−70)/170` clamped, bilinear-resized to
 * 8×12, byte-quantised and normalised. Mirrors the extraction script exactly.
 */
function glyphFeature(
  data: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  shift: number,
): Float64Array | null {
  const sourceW = x1 - x0 + 1;
  const source = new Float64Array(READOUT_H * sourceW);
  for (let y = 0; y < READOUT_H; y += 1) {
    const row = (READOUT_Y + y) * width;
    for (let x = 0; x < sourceW; x += 1) {
      const luma = lumaAt(data, (row + x0 + x) * 4) - shift;
      const scaled = ((luma - 70) / 170) * 255;
      source[y * sourceW + x] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
    }
  }

  const targetW = 8;
  const targetH = 12;
  const values = new Float64Array(targetW * targetH);
  for (let ty = 0; ty < targetH; ty += 1) {
    const sy = ((ty + 0.5) * READOUT_H) / targetH - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const y1 = Math.min(READOUT_H - 1, Math.max(0, y0 + 1));
    const yc = Math.min(READOUT_H - 1, Math.max(0, y0));
    for (let tx = 0; tx < targetW; tx += 1) {
      const sx = ((tx + 0.5) * sourceW) / targetW - 0.5;
      const x0f = Math.floor(sx);
      const fx = sx - x0f;
      const xa = Math.min(sourceW - 1, Math.max(0, x0f));
      const xb = Math.min(sourceW - 1, Math.max(0, x0f + 1));
      const top = source[yc * sourceW + xa] * (1 - fx) + source[yc * sourceW + xb] * fx;
      const bottom = source[y1 * sourceW + xa] * (1 - fx) + source[y1 * sourceW + xb] * fx;
      const value = top * (1 - fy) + bottom * fy;
      values[ty * targetW + tx] = Math.trunc(value);
    }
  }

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  const mean = sum / values.length;
  let normSq = 0;
  for (let i = 0; i < values.length; i += 1) {
    values[i] -= mean;
    normSq += values[i] * values[i];
  }
  const norm = Math.sqrt(normSq);
  if (norm === 0) return null;
  for (let i = 0; i < values.length; i += 1) values[i] /= norm;
  return values;
}

/**
 * Match one 8×12 glyph against the seven observed digit templates. `null` means the atlas cannot
 * identify it — 5, 6 and 8 have no template, and the floors are what make an unseen digit refuse
 * instead of snapping to the nearest plausible number.
 */
function matchDigit(feature: Float64Array): { digit: string; margin: number } | null {
  let best = -Infinity;
  let second = -Infinity;
  let digit = '';
  for (const entry of DIGIT_TEMPLATES) {
    const { values } = entry.template;
    let dot = 0;
    for (let i = 0; i < values.length; i += 1) dot += feature[i] * values[i];
    if (dot > best) {
      second = best;
      best = dot;
      digit = entry.digit;
    } else if (dot > second) {
      second = dot;
    }
  }
  if (best < DIGIT_NCC_FLOOR || best - second < DIGIT_MARGIN_FLOOR) return null;
  return { digit, margin: best - second };
}

// ---------------------------------------------------------------------------------------------
// G4 + R27 — the title
// ---------------------------------------------------------------------------------------------

interface Title {
  readonly text: string;
  readonly minNcc: number;
  readonly key: string;
}

/**
 * The floor's title fingerprint (R27a). The Latin token is only one kind of floor name: the FFXI
 * collab floors print a Chinese title in the same bar, and `readMap` refused every one of them
 * because the three Latin slots never matched (measured 2026-10-24 on `第四区-城内2F深处-`).
 *
 * The fingerprint is a 32×4 ink profile of the same 400×40 region, binarised against its own mean:
 * stable across frames of one floor (four captures, identical), different between floors, and all
 * zeros for a HUD. It identifies a floor without reading a glyph, so a locator can gate on it.
 */
const TITLE_KEY_COLS = 32;
const TITLE_KEY_ROWS = 4;

function titleKeyOf(data: Uint8Array, width: number, cells: Float64Array): string {
  let total = 0;
  for (const cell of cells) total += cell;
  const mean = total / cells.length;
  let bits = '';
  for (const cell of cells) bits += cell > mean ? '1' : '0';
  let hex = '';
  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4), 2).toString(16);
  }
  return hex;
}

function readTitle(image: RgbaImage): Title | null {
  const { data, width } = image;
  // The ink floor is the gate that refuses a HUD (0 lit px); the Latin slots are an extra check,
  // never the only one, so a title of another script still yields a map.
  if (titleBarInk(image) < TITLE_BAR_INK_MIN) return null;
  const cells = new Float64Array(TITLE_KEY_COLS * TITLE_KEY_ROWS);
  for (let y = TITLE_INK_Y; y < TITLE_INK_Y + TITLE_INK_H; y += 1) {
    const row = y * width;
    const cellY = Math.min(TITLE_KEY_ROWS - 1, Math.floor(((y - TITLE_INK_Y) * TITLE_KEY_ROWS) / TITLE_INK_H));
    for (let x = TITLE_INK_X; x < TITLE_INK_X + TITLE_INK_W; x += 1) {
      if (lumaAt(data, (row + x) * 4) > TITLE_INK_LUMA) {
        const cellX = Math.min(TITLE_KEY_COLS - 1, Math.floor(((x - TITLE_INK_X) * TITLE_KEY_COLS) / TITLE_INK_W));
        cells[cellY * TITLE_KEY_COLS + cellX] += 1;
      }
    }
  }
  const key = titleKeyOf(data, width, cells);

  let text = '';
  let minNcc = Infinity;
  for (const slot of TITLE_SLOTS) {
    const ncc = cropNcc(data, width, slot.x, TITLE_ROW_Y, TITLE_TEMPLATES[slot.char]);
    if (ncc === null || ncc < TITLE_SLOT_NCC_FLOOR) return { text: '', minNcc: 0.85, key };
    text += slot.char;
    minNcc = Math.min(minNcc, ncc);
  }
  return { text, minNcc, key };
}

// ---------------------------------------------------------------------------------------------
// One panel scan: G3, lattice profiles, yellow and red pixels
// ---------------------------------------------------------------------------------------------

interface Panel {
  readonly mapInk: number;
  readonly columns: Float64Array;
  readonly rows: Float64Array;
  /** Frame pixel indices of the chevron's colour rule. */
  readonly yellow: readonly number[];
  /** Frame pixel indices of the hazard's colour rule. */
  readonly red: readonly number[];
  /** Frame pixel indices of the teleport ring's colour rule. */
  readonly orchid: readonly number[];
}

const PANEL_SCAN_X0 = LATTICE_X;
const PANEL_SCAN_X1 = MAP_INK_X + MAP_INK_W;
const PANEL_SCAN_Y0 = MAP_INK_Y;
const PANEL_SCAN_Y1 = CHEVRON_SCAN_BOTTOM;

function scanPanel(data: Uint8Array, width: number): Panel {
  const columns = new Float64Array(LATTICE_W);
  const rows = new Float64Array(LATTICE_H);
  const yellow: number[] = [];
  const red: number[] = [];
  const orchid: number[] = [];
  let mapInk = 0;

  for (let y = PANEL_SCAN_Y0; y < PANEL_SCAN_Y1; y += 1) {
    const row = y * width;
    for (let x = PANEL_SCAN_X0; x < PANEL_SCAN_X1; x += 1) {
      const offset = (row + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      if (isPanelInk(r, g, b)) {
        if (x >= MAP_INK_X && x < MAP_INK_X + MAP_INK_W && y < MAP_INK_Y + MAP_INK_H) {
          mapInk += 1;
        }
        if (x < LATTICE_X + LATTICE_W && y >= LATTICE_Y && y < LATTICE_Y + LATTICE_H) {
          columns[x - LATTICE_X] += 1;
          rows[y - LATTICE_Y] += 1;
        }
      }

      if (
        x < LATTICE_X + LATTICE_W &&
        y >= LATTICE_Y &&
        r > CHEVRON_R_MIN &&
        g > CHEVRON_G_MIN &&
        b < CHEVRON_B_MAX &&
        r - b > CHEVRON_RB_MIN &&
        g - b > CHEVRON_GB_MIN
      ) {
        yellow.push(row + x);
      }

      if (
        x < LATTICE_X + LATTICE_W &&
        y < HAZARD_SCAN_BOTTOM &&
        r - b >= HAZARD_RB_MIN &&
        r - g >= HAZARD_RG_MIN &&
        r >= HAZARD_R_MIN &&
        r <= HAZARD_R_MAX &&
        g < HAZARD_G_MAX &&
        b < HAZARD_B_MAX
      ) {
        red.push(row + x);
      }

      if (
        r >= TELEPORT_R_MIN &&
        g <= TELEPORT_G_MAX &&
        b >= TELEPORT_B_MIN &&
        b <= TELEPORT_B_MAX &&
        b - r >= TELEPORT_BR_MIN
      ) {
        orchid.push(row + x);
      }
    }
  }

  return { mapInk, columns, rows, yellow, red, orchid };
}

// ---------------------------------------------------------------------------------------------
// G6 — the 36.0-px lattice
// ---------------------------------------------------------------------------------------------

interface LatticeFit {
  readonly pitch: number;
  readonly phase: number;
  readonly rms: number;
  /** Lines the fitted grid explains, within `LATTICE_SUPPORT_TOLERANCE` px. */
  readonly support: number;
}

/** Column/row centres of long lines, i.e. runs above `LATTICE_LINE_MIN_INK` merged over ≤2 px. */
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
 * The 36.0-px grid this profile admits, and how many of its lines the grid explains.
 *
 * The grid itself is still the one with the tightest residual: the phase validates the chevron's
 * own cell (the glyph cells are placed from the chevron, not from this phase), and a count cannot
 * resolve a phase better than 2 px. `support` is counted on that grid, and it is what G6's quality
 * test reads — so the geometry every other gate depends on is unchanged, while a lit band that
 * drags the residual no longer decides whether the map is a map.
 */
function fitLattice(profile: Float64Array, origin: number): LatticeFit | null {
  const centres = lineCentres(profile, origin);
  if (centres.length < LATTICE_MIN_LINES) return null;

  let best: LatticeFit | null = null;
  const pitchSteps = Math.round((PITCH_MAX - PITCH_MIN) / PITCH_STEP);
  for (let step = 0; step <= pitchSteps; step += 1) {
    const pitch = PITCH_MIN + step * PITCH_STEP;
    const phaseSteps = Math.floor(pitch / PHASE_STEP);
    for (let phaseStep = 0; phaseStep <= phaseSteps; phaseStep += 1) {
      const phase = phaseStep * PHASE_STEP;
      let sumSq = 0;
      let support = 0;
      for (const centre of centres) {
        const residual = centre - (phase + Math.round((centre - phase) / pitch) * pitch);
        sumSq += residual * residual;
        if (Math.abs(residual) <= LATTICE_SUPPORT_TOLERANCE) support += 1;
      }
      const rms = Math.sqrt(sumSq / centres.length);
      if (!best || rms < best.rms) best = { pitch, phase, rms, support };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// G5 — the chevron
// ---------------------------------------------------------------------------------------------

interface Chevron {
  readonly x: number;
  readonly y: number;
  readonly residualX: number;
  readonly residualY: number;
}

function findChevron(
  pixels: readonly number[],
  width: number,
  linePhaseX: number,
  linePhaseY: number,
): Chevron | null {
  const cellPhaseX = linePhaseX + TILE_PX / 2;
  const cellPhaseY = linePhaseY + TILE_PX / 2;
  let best: { residual: number; chevron: Chevron } | null = null;

  for (const blob of blobs(pixels, width, REFERENCE_HEIGHT)) {
    const w = blob.maxX - blob.minX + 1;
    const h = blob.maxY - blob.minY + 1;
    if (blob.area < CHEVRON_AREA_MIN || blob.area > CHEVRON_AREA_MAX) continue;
    if (w < CHEVRON_W_MIN || w > CHEVRON_W_MAX || h < CHEVRON_H_MIN || h > CHEVRON_H_MAX) continue;

    const x = blob.sumX / blob.area;
    const y = blob.sumY / blob.area;
    const residualX = cellResidual(x, cellPhaseX);
    const residualY = cellResidual(y, cellPhaseY);
    const residual = Math.max(residualX, residualY);
    if (!best || residual < best.residual) best = { residual, chevron: { x, y, residualX, residualY } };
  }

  if (!best || best.residual > CHEVRON_CELL_TOLERANCE) return null;
  return best.chevron;
}

/** Distance from `value` to the nearest cell centre of a `TILE_PX` lattice with `phase`. */
function cellResidual(value: number, cellPhase: number): number {
  const offset = value - cellPhase;
  return Math.abs(offset - Math.round(offset / TILE_PX) * TILE_PX);
}

// ---------------------------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------------------------

function findIcons(
  data: Uint8Array,
  width: number,
  panel: Panel,
  readout: Readout,
  chevron: Chevron,
): MapIcon[] {
  const icons: MapIcon[] = [];
  const seen = new Set<string>();
  // The chevron is the party's cell centre — the one screen point this floor's click transform is
  // anchored at — so the cell lattice the glyphs sit on is enumerated from it. It rides with the party,
  // so a glyph can fall between cells (measured 2026-11-03: the 楼梯-门 sat 4.7 px from the nearest
  // cell, outside the ±3 template window); the stair-door therefore gets a wider *refined* search —
  // its coarse score at the cell centre says whether a glyph is near before the expensive sweep.
  const cellPhaseX = chevron.x;
  const cellPhaseY = chevron.y;

  const toGrid = (x: number, y: number): Point => ({
    x: readout.x + Math.round((x - chevron.x) / TILE_PX),
    y: readout.y - Math.round((y - chevron.y) / TILE_PX),
  });
  const push = (kind: MapIcon['kind'], at: Point): void => {
    const key = `${kind}:${at.x},${at.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    icons.push({ kind, at });
  };

  const firstX = Math.ceil((ICON_X_MIN - cellPhaseX) / TILE_PX);
  const lastX = Math.floor((ICON_X_MAX - cellPhaseX) / TILE_PX);
  const firstY = Math.ceil((ICON_Y_MIN - cellPhaseY) / TILE_PX);
  const lastY = Math.floor((ICON_Y_MAX - cellPhaseY) / TILE_PX);

  for (let ky = firstY; ky <= lastY; ky += 1) {
    const cy = cellPhaseY + ky * TILE_PX;
    for (let kx = firstX; kx <= lastX; kx += 1) {
      const cx = cellPhaseX + kx * TILE_PX;

      // 楼梯-门 before the bright-ink prefilter: the door glyph's cell is mostly *dark* (a black door on
      // a bright frame), and that prefilter — sized to notice a chest — can drop it. Measured
      // 2026-11-03: the glyph matched 1.000 offline on a frame the live run read as "no stair-door",
      // 4.7 px from the chevron-anchored cell — a coarse score there decides whether to sweep wider.
      let coarseDoor = -1;
      for (const seed of STAIR_DOOR_SEEDS) {
        const score = templateNcc(data, width, STAIR_DOOR_TEMPLATE, cx + seed[0], cy + seed[1]);
        if (score > coarseDoor) coarseDoor = score;
      }
      if (coarseDoor >= STAIR_DOOR_COARSE_FLOOR) {
        const stairDoor = bestNcc(data, width, STAIR_DOOR_TEMPLATE, cx, cy, STAIR_DOOR_OFFSET);
        if (stairDoor.score >= STAIR_DOOR_NCC_FLOOR) {
          push('stair-door', toGrid(cx + stairDoor.dx, cy + stairDoor.dy));
        }
      }

      const bright = brightCount(data, width, cx, cy);
      if (bright < ICON_BRIGHT_MIN) continue;

      const chest = bestNcc(data, width, CHEST_TEMPLATE, cx, cy);
      if (chest.score >= CHEST_NCC_FLOOR) push('chest', toGrid(cx + chest.dx, cy + chest.dy));

      const stairs = bestNcc(data, width, STAIRS_TEMPLATE, cx, cy);
      if (stairs.score >= STAIRS_NCC_FLOOR) push('stairs', toGrid(cx + stairs.dx, cy + stairs.dy));

      const hole = bestNcc(data, width, HOLE_TEMPLATE, cx, cy);
      if (hole.score >= HOLE_NCC_FLOOR) push('hole', toGrid(cx + hole.dx, cy + hole.dy));


      // The harken is cell-centred on every instance and drawn at two sizes, so both scales are
      // matched at the cell centre and the better one decides.
      if (bright >= HARKEN_INK_MIN && bright <= HARKEN_INK_MAX) {
        let harken: NccResult = { score: -1, dx: 0, dy: 0 };
        for (const template of HARKEN_TEMPLATES) {
          const match = bestNcc(data, width, template, cx, cy);
          if (match.score > harken.score) harken = match;
        }
        if (harken.score >= HARKEN_NCC_FLOOR) push('harken', toGrid(cx + harken.dx, cy + harken.dy));
      }
    }
  }

  for (const blob of blobs(panel.red, width, REFERENCE_HEIGHT)) {
    const w = blob.maxX - blob.minX + 1;
    const h = blob.maxY - blob.minY + 1;
    if (w < HAZARD_WIDTH_MIN || h < HAZARD_HEIGHT_MIN) continue;
    push('hazard', toGrid(blob.sumX / blob.area, blob.sumY / blob.area));
  }

  // The orchid ring is a colour rule, not a template: its core is saturated and nothing else on the
  // map is, so the area gate is all the precision it needs.
  for (const blob of blobs(panel.orchid, width, REFERENCE_HEIGHT)) {
    if (blob.area < TELEPORT_AREA_MIN) continue;
    push('teleport', toGrid(blob.sumX / blob.area, blob.sumY / blob.area));
  }

  return icons;
}

/** Lit low-saturation pixels in the template-sized box at a cell centre; a cheap prefilter. */
function brightCount(data: Uint8Array, width: number, cx: number, cy: number): number {
  const x0 = Math.round(cx - CHEST_TEMPLATE.w / 2);
  const y0 = Math.round(cy - CHEST_TEMPLATE.h / 2);
  if (x0 < 0 || y0 < 0 || x0 + CHEST_TEMPLATE.w > width) return 0;
  if (y0 + CHEST_TEMPLATE.h > REFERENCE_HEIGHT) return 0;
  let count = 0;
  for (let y = 0; y < CHEST_TEMPLATE.h; y += 1) {
    const row = (y0 + y) * width;
    for (let x = 0; x < CHEST_TEMPLATE.w; x += 1) {
      const offset = (row + x0 + x) * 4;
      if (lumaAt(data, offset) > ICON_BRIGHT_LUMA && saturationAt(data, offset) < ICON_BRIGHT_SAT) {
        count += 1;
      }
    }
  }
  return count;
}

interface NccResult {
  readonly score: number;
  readonly dx: number;
  readonly dy: number;
}

function bestNcc(
  data: Uint8Array,
  width: number,
  template: Template,
  cx: number,
  cy: number,
  /** The search radius around the cell centre; the icons' own window unless a caller says otherwise. */
  radius: number = ICON_OFFSET,
): NccResult {
  let best: NccResult = { score: -1, dx: 0, dy: 0 };
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const score = templateNcc(data, width, template, cx + dx, cy + dy);
      if (score > best.score) best = { score, dx, dy };
    }
  }
  return best;
}

/**
 * Normalised cross-correlation of a template against the frame at a centre, using the one-pass
 * sums form: the template is mean-subtracted and unit-norm, so
 * `NCC = (Σ I·T) / (sqrt(n·var(I)) · ||T||)` and `||T|| = 1`.
 */
function templateNcc(
  data: Uint8Array,
  width: number,
  template: Template,
  cx: number,
  cy: number,
): number {
  const x0 = Math.round(cx - template.w / 2);
  const y0 = Math.round(cy - template.h / 2);
  if (x0 < 0 || y0 < 0 || x0 + template.w > width) return -1;
  if (y0 + template.h > REFERENCE_HEIGHT) return -1;

  let sum = 0;
  let sumSq = 0;
  let dot = 0;
  let index = 0;
  for (let y = 0; y < template.h; y += 1) {
    const row = (y0 + y) * width;
    for (let x = 0; x < template.w; x += 1) {
      const luma = lumaAt(data, (row + x0 + x) * 4);
      sum += luma;
      sumSq += luma * luma;
      dot += luma * template.values[index];
      index += 1;
    }
  }
  const n = template.w * template.h;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  // Research's ncc() ignores flat patches (std < 6): noise must not become a match.
  if (variance < 36) return -1;
  return (dot - mean * template.sum) / Math.sqrt(n * variance);
}

/** NCC of a fixed crop (the title slots) against a template of the same size. */
function cropNcc(
  data: Uint8Array,
  width: number,
  x: number,
  y: number,
  template: Template,
): number | null {
  if (x < 0 || y < 0 || x + template.w > width || y + template.h > REFERENCE_HEIGHT) return null;
  let sum = 0;
  let sumSq = 0;
  let dot = 0;
  let index = 0;
  for (let ty = 0; ty < template.h; ty += 1) {
    const row = (y + ty) * width;
    for (let tx = 0; tx < template.w; tx += 1) {
      const luma = lumaAt(data, (row + x + tx) * 4);
      sum += luma;
      sumSq += luma * luma;
      dot += luma * template.values[index];
      index += 1;
    }
  }
  const n = template.w * template.h;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  if (variance < 1) return null;
  return (dot - mean * template.sum) / Math.sqrt(n * variance);
}

// ---------------------------------------------------------------------------------------------
// Connected components over a sparse colour mask
// ---------------------------------------------------------------------------------------------

interface Blob {
  readonly area: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly sumX: number;
  readonly sumY: number;
}

/** 8-connected components of frame pixel indices (`y * width + x`), four/side and diagonal joined. */
function blobs(pixels: readonly number[], width: number, height: number): Blob[] {
  if (pixels.length === 0) return [];
  const pending = new Set(pixels);
  const found: Blob[] = [];

  for (const start of pixels) {
    if (!pending.delete(start)) continue;
    const stack = [start];
    let area = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sumX = 0;
    let sumY = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const y = (index / width) | 0;
      const x = index - y * width;
      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbour = ny * width + nx;
          if (pending.delete(neighbour)) stack.push(neighbour);
        }
      }
    }

    found.push({ area, minX, maxX, minY, maxY, sumX, sumY });
  }
  return found;
}
