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
 * - Refusal is a first-class answer. A frame that fails any measured gate is `null` — observe()
 *   reports `unknown` with confidence 0 — because a confident wrong map is worse than no map.
 *
 * Geometry: 1920×1080 device pixels. A frame of another size is unsupported (contracts §0.5: refuse,
 * do not mis-scale the fixed rects). The digits are 12 px at a fixed rect and only seven of the ten
 * glyphs have ever been seen; a glyph below the match/margin floor makes the whole readout `null`.
 * `haken` is not identifiable in any fixture, so it is never emitted.
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

/** G3 — white map ink in the panel: 15 000 … 200 000 (research §1). */
const MAP_INK_X = 480;
const MAP_INK_Y = 150;
const MAP_INK_W = 1220;
const MAP_INK_H = 750;
const MAP_INK_MIN = 15_000;
const MAP_INK_MAX = 200_000;
const MAP_INK_LUMA = 185;
const MAP_INK_SAT = 60;

/**
 * G4 — a centred 28-px white title string is present (research §2). `map.png` 768, `popup.png` 770,
 * HUD 0; the floor is far below the sample and above the HUD.
 */
const TITLE_INK_X = 800;
const TITLE_INK_Y = 40;
const TITLE_INK_W = 400;
const TITLE_INK_H = 40;
const TITLE_INK_LUMA = 170;
const TITLE_INK_MIN = 400;

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
/** Best 36.0-px fit must be tighter than this, or the frame is not the lattice being read. */
const LATTICE_RMS_MAX = 3.5;
/**
 * R29: the FFXI collab draws its map translucent over the 3D view, so a lit background (the harken's
 * glow) adds ink the clean fixtures never had and the fit residual rises to ~5.8. The lattice is one
 * of five gates and the only one that is a *quality* test rather than a presence test — the readout,
 * the dark title bar, the map ink and the title string all still have to pass — so the ceiling is
 * raised for the translucent style rather than spending the residual's discrimination on it.
 */
const LATTICE_RMS_MAX_TRANSLUCENT = 6.5;
/** Confidence 1.0 needs rms ≤ 2 px (research §9). */
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
 * the 12-px ink row run, `(L−70)/170` clamped to [0,1], resize to 8×12). The set is incomplete on
 * purpose: the corpus only contains `20/14`, `19/21`, `22/17` and `23/13`, so **0, 1, 2, 3, 4, 7, 9**
 * exist and **5, 6, 8 do not**. A glyph that falls below the match/margin floor returns `null`.
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
const STAIRS_TEMPLATE = decodeTemplate(STAIRS_TEMPLATE_B64, 36, 36);
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
 * Read the map out of one frame. `null` is the answer for every refusal: the frame is another size,
 * uniform, not the map screen, or carries a readout/lattice/chevron this parser cannot trust.
 */
export async function readMap(frame: Frame): Promise<MapState | null> {
  const parsed = await parse(frame);
  return parsed?.map ?? null;
}

/** A `Perceiver` over the dungeon map. `unknown` (confidence 0) is its refusal. */
export class MapPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const parsed = await parse(frame);
    if (!parsed) return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    return {
      screen: 'dungeonmap',
      atMs: frame.atMs,
      confidence: parsed.confidence,
      map: parsed.map,
    };
  }
}

async function parse(frame: Frame): Promise<ParsedMap | null> {
  try {
    const image = await frame.toRgba();
    return parseImage(image);
  } catch {
    // Failure is a value (contracts §0.6): a decode failure is "not observed", not a throw.
    return null;
  }
}

function parseImage(image: RgbaImage): ParsedMap | null {
  const { data, width, height } = image;

  // 0. Size and uniformity -------------------------------------------------------------------
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT) return null;
  if (isUniform(data, width, height)) return null;

  // 1. G1: the coordinate readout ------------------------------------------------------------
  const readout = readReadout(data, width);
  if (!readout) return null;

  // 2. G2: the title bar's dark strip --------------------------------------------------------
  if (darkFraction(data, width) < TITLE_BAR_DARK_FRACTION) return null;

  // 3. One scan of the map panel feeds G3, G6's profiles, and both colour blobs. ---------------
  const panel = scanPanel(data, width);
  if (panel.mapInk < MAP_INK_MIN || panel.mapInk > MAP_INK_MAX) return null;

  // 4. G4 + R27: a centred Latin floor token that lands in the measured slots. ----------------
  const title = readTitle(data, width);
  if (!title) return null;

  // 5. G6: the wall lattice ----------------------------------------------------------------
  const latticeX = fitLattice(panel.columns, LATTICE_X);
  const latticeY = fitLattice(panel.rows, LATTICE_Y);
  if (!latticeX || !latticeY) return null;
  if (latticeX.rms > LATTICE_RMS_MAX_TRANSLUCENT || latticeY.rms > LATTICE_RMS_MAX_TRANSLUCENT) return null;

  // 6. G5: the chevron (the click origin) ----------------------------------------------------
  const chevron = findChevron(panel.yellow, width, latticeX.phase, latticeY.phase);
  if (!chevron) return null;

  // 7. Icons, all positioned relative to the chevron. ---------------------------------------
  const icons = findIcons(data, width, panel, readout, chevron, latticeX.phase, latticeY.phase);

  const map: MapState = {
    floorTitle: title.text,
    titleKey: title.key,
    player: { x: readout.x, y: readout.y },
    icons,
  };

  let confidence = 1;
  if (Math.min(...readout.margins) < DIGIT_CONFIDENT_MARGIN) confidence = 0.85;
  if (Math.max(latticeX.rms, latticeY.rms) > LATTICE_CLEAN_RMS) confidence = Math.min(confidence, 0.8);
  if (Math.max(chevron.residualX, chevron.residualY) > 1) confidence = Math.min(confidence, 0.9);
  if (title.minNcc < 0.9) confidence = Math.min(confidence, 0.85);
  // An unnamed (non-Latin) title is a weaker gate than three matched glyphs, never a stronger one.
  if (title.text === '') confidence = Math.min(confidence, 0.85);

  return { map, confidence };
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

function readReadout(data: Uint8Array, width: number): Readout | null {
  const columnInk = new Uint8Array(READOUT_W);
  for (let y = READOUT_Y; y < READOUT_Y + READOUT_H; y += 1) {
    const row = y * width;
    for (let x = 0; x < READOUT_W; x += 1) {
      if (lumaAt(data, (row + READOUT_X + x) * 4) > READOUT_INK_LUMA) columnInk[x] += 1;
    }
  }

  // R28: a column lit through the whole band is UI chrome — the map panel's border scrolls into
  // this band on some frames and merges with the last digit, which used to make `X: 13 Y: 23`
  // unreadable. A glyph never fills all 16 rows; the border does.
  const lit = new Uint8Array(READOUT_W);
  for (let x = 0; x < READOUT_W; x += 1) {
    lit[x] = columnInk[x] >= READOUT_INK_ROWS_MIN && columnInk[x] < READOUT_CHROME_ROWS ? 1 : 0;
  }

  const allRuns = columnRuns(lit);
  // A run touching the band's first column is the panel's left border, never a label (R28c).
  while (allRuns.length > 0 && allRuns[0]![0] === 0) allRuns.shift();
  const runs = allRuns;
  const labelAt = (expected: number): number =>
    runs.findIndex(([from]) => Math.abs(READOUT_X + from - expected) <= READOUT_LABEL_TOLERANCE);
  const xLabel = labelAt(READOUT_LABEL_X[0]);
  const yLabel = labelAt(READOUT_LABEL_X[1]);
  if (xLabel < 0 || yLabel < 0 || yLabel <= xLabel + 1) return null;

  for (const index of [xLabel, yLabel]) {
    const [from, to] = runs[index]!;
    // A label may carry its colon when the two touch (17–18 px); anything wider is another glyph.
    if (to - from + 1 < READOUT_LABEL_MIN_W || to - from + 1 > READOUT_LABEL_MAX_W + 5) return null;
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
  if (xRuns.length < 1 || xRuns.length > 2 || yRuns.length < 1 || yRuns.length > 2) return null;

  const digits: string[] = [];
  const margins: number[] = [];
  for (const [from, to] of [...xRuns, ...yRuns]) {
    if (to - from + 1 < READOUT_DIGIT_MIN_W || to - from + 1 > READOUT_DIGIT_MAX_W) return null;
    const match = readDigit(data, width, from, to);
    if (!match) return null;
    digits.push(match.digit);
    margins.push(match.margin);
  }

  const x = Number(digits.slice(0, xRuns.length).join(''));
  const y = Number(digits.slice(xRuns.length).join(''));
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y, margins };
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
): { digit: string; margin: number } | null {
  for (let trim = 0; trim <= 5; trim += 1) {
    const end = to - trim;
    if (end - from + 1 < READOUT_DIGIT_MIN_W) return null;
    const feature = glyphFeature(data, width, READOUT_X + from, READOUT_X + end);
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
): Float64Array | null {
  const sourceW = x1 - x0 + 1;
  const source = new Float64Array(READOUT_H * sourceW);
  for (let y = 0; y < READOUT_H; y += 1) {
    const row = (READOUT_Y + y) * width;
    for (let x = 0; x < sourceW; x += 1) {
      const luma = lumaAt(data, (row + x0 + x) * 4);
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

function readTitle(data: Uint8Array, width: number): Title | null {
  const cells = new Float64Array(TITLE_KEY_COLS * TITLE_KEY_ROWS);
  let ink = 0;
  for (let y = TITLE_INK_Y; y < TITLE_INK_Y + TITLE_INK_H; y += 1) {
    const row = y * width;
    const cellY = Math.min(TITLE_KEY_ROWS - 1, Math.floor(((y - TITLE_INK_Y) * TITLE_KEY_ROWS) / TITLE_INK_H));
    for (let x = TITLE_INK_X; x < TITLE_INK_X + TITLE_INK_W; x += 1) {
      if (lumaAt(data, (row + x) * 4) > TITLE_INK_LUMA) {
        ink += 1;
        const cellX = Math.min(TITLE_KEY_COLS - 1, Math.floor(((x - TITLE_INK_X) * TITLE_KEY_COLS) / TITLE_INK_W));
        cells[cellY * TITLE_KEY_COLS + cellX] += 1;
      }
    }
  }
  // The ink floor is the gate that refuses a HUD (0 lit px); the Latin slots are an extra check,
  // never the only one, so a title of another script still yields a map.
  if (ink < TITLE_INK_MIN) return null;
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
  let mapInk = 0;

  for (let y = PANEL_SCAN_Y0; y < PANEL_SCAN_Y1; y += 1) {
    const row = y * width;
    for (let x = PANEL_SCAN_X0; x < PANEL_SCAN_X1; x += 1) {
      const offset = (row + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const luma = ((r * 299 + g * 587 + b * 114) / 1000) | 0;

      if (luma > MAP_INK_LUMA) {
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        const min = r < g ? (r < b ? r : b) : g < b ? g : b;
        if (max - min < MAP_INK_SAT) {
          if (x >= MAP_INK_X && x < MAP_INK_X + MAP_INK_W && y < MAP_INK_Y + MAP_INK_H) {
            mapInk += 1;
          }
          if (x < LATTICE_X + LATTICE_W && y >= LATTICE_Y && y < LATTICE_Y + LATTICE_H) {
            columns[x - LATTICE_X] += 1;
            rows[y - LATTICE_Y] += 1;
          }
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
    }
  }

  return { mapInk, columns, rows, yellow, red };
}

// ---------------------------------------------------------------------------------------------
// G6 — the 36.0-px lattice
// ---------------------------------------------------------------------------------------------

interface LatticeFit {
  readonly pitch: number;
  readonly phase: number;
  readonly rms: number;
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
      for (const centre of centres) {
        const residual = centre - (phase + Math.round((centre - phase) / pitch) * pitch);
        sumSq += residual * residual;
      }
      const rms = Math.sqrt(sumSq / centres.length);
      if (!best || rms < best.rms) best = { pitch, phase, rms };
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
  linePhaseX: number,
  linePhaseY: number,
): MapIcon[] {
  const icons: MapIcon[] = [];
  const seen = new Set<string>();
  const cellPhaseX = linePhaseX + TILE_PX / 2;
  const cellPhaseY = linePhaseY + TILE_PX / 2;

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

      const bright = brightCount(data, width, cx, cy);
      if (bright < ICON_BRIGHT_MIN) continue;

      const chest = bestNcc(data, width, CHEST_TEMPLATE, cx, cy);
      if (chest.score >= CHEST_NCC_FLOOR) push('chest', toGrid(cx + chest.dx, cy + chest.dy));

      const stairs = bestNcc(data, width, STAIRS_TEMPLATE, cx, cy);
      if (stairs.score >= STAIRS_NCC_FLOOR) push('stairs', toGrid(cx + stairs.dx, cy + stairs.dy));
    }
  }

  for (const blob of blobs(panel.red, width, REFERENCE_HEIGHT)) {
    const w = blob.maxX - blob.minX + 1;
    const h = blob.maxY - blob.minY + 1;
    if (w < HAZARD_WIDTH_MIN || h < HAZARD_HEIGHT_MIN) continue;
    push('hazard', toGrid(blob.sumX / blob.area, blob.sumY / blob.area));
  }

  // `haken` is never pushed: nothing in the fixtures can label one (research §6, §9).

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
): NccResult {
  let best: NccResult = { score: -1, dx: 0, dy: 0 };
  for (let dy = -ICON_OFFSET; dy <= ICON_OFFSET; dy += 1) {
    for (let dx = -ICON_OFFSET; dx <= ICON_OFFSET; dx += 1) {
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
