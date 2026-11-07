/**
 * The `由谁打开?` opener panel, and the fixed grid that makes its choice clickable.
 *
 * **The panel is a fixed 2×3 grid.** Its six cards do not move: the same boxes in `panel-00/01/02`
 * (three captures of one screen) and in the live FFXI capture (`panel-ffxi.jpg`). The upstream
 * autoscript learned this first — it keeps a `WHO_WILL_OPEN_IT` slot (左上, 中上, 右上, 左下, 中下,
 * 右下) and clicks `[258 + (slot % 3)·258, 1161 + ⌊slot / 3⌋·184]` without looking at the card again.
 * So a member is addressed here by the **slot** it sits on: `OPENER_SLOTS` carries each slot's measured
 * box and centre, and `openerCardCentre` answers the click point without detecting anything. Reading a
 * card never has to find the card; the policy's choice is a slot index.
 *
 * Per slot the parser reads 陷阱发现, 陷阱解除 and the heart numeral (willpower). Names are CJK and
 * cannot be read, so members are named `#1` … `#6` by slot.
 *
 * **Two kinds of field, two kinds of failure.** A 陷阱 numeral ranks *every* card, so a numeral that
 * cannot be read refuses the whole panel — the ranking would otherwise be a guess. The heart numeral
 * only ever disqualifies *its own* card (the policy skips an unread willpower), so an unreadable heart
 * is recorded as `NaN`: that card is ineligible and the other cards still stand. A card that draws
 * **no heart at all** is a third case — the main character, whose willpower the game does not display
 * — and is recorded as `null`, which the gate accepts. This distinction is what makes the live panel
 * openable:
 * through GDI+ its 爱丽丝 card (90) renders below the heart atlas's identity floor, and refusing the
 * whole panel would block a chest whose other five cards are fully readable.
 *
 * The digits come from the committed atlases extracted by `scripts/extract-opener-digits.mjs`. The
 * fixture's twelve 陷阱 values are `38 49 28 50 34 38 92 105 62 43 77 79`, which contain **every**
 * digit 0–9 — that atlas is complete and its templates are means. The heart numerals are drawn one
 * pixel taller, so they get their own atlas, and **that atlas is partial**: the five hearts show only
 * `100 100 100 90 100`, i.e. the digits 0, 1 and 9. Their templates are every observed instance rather
 * than a mean, and a heart glyph must match one near-exactly (0.95), because nearest-neighbour among
 * three shapes would snap an unseen `6` onto a `0` or `9`. A digit below that floor is unread, never
 * rounded to a plausible number; more captures extend the atlas.
 *
 * **The numerals read through the numerals-reader seam** (2026-11-07). The 陷阱 fields go through
 * `createNumeralsReader`: their atlas is the template tier, the field's label is the read's context,
 * and the opener's floors are passed in. A field whose atlas a capture-pipeline change has
 * invalidated therefore escalates to OCR instead of refusing the panel — the live failure of
 * 2026-11-07 was exactly that refusal. What stays the opener's is everything the reader cannot name:
 * the band, the floors, the structural refusals, `unreadable`, and the heart's `absent` /
 * `unreadable` distinction (contracts §0.6).
 *
 * **The escalation is budgeted per panel** (ruling R6, 2026-11-07; window R10, 2026-11-07; the
 * per-observation leak fixed in review F1): at most two OCR calls, and none starting more than 10 s
 * after the first — twelve fields each waiting out the tier's 8 s bound would hold a panel for ~96 s
 * inside `parseOpenerDetailed`, which `chest.ts` awaits. The parse takes the budget from its caller
 * (`OpenerParseOptions.ocrBudget`); `ChestPerceiver` holds one per panel and resets it when the
 * screen stops being the panel, because it observes a frame every tick and a fresh budget per call
 * spent the whole allowance on each tick. The **cap is the budget**; the window only stops an
 * unbounded panel, and it is 10 s because
 * this host's OCR measures ~2.5–5 s per call (Task 4 report) — at 2 s the second escalation of a panel
 * that needed two could never start, so a two-refusal panel could never read. A panel with two
 * escalating fields can therefore spend up to ~16 s, once per chest, each call still bounded by the
 * OCR tier's own 8 s bound. Past the budget a field refuses, which refuses the panel as any unreadable
 * 陷阱 field does.
 *
 * **The tier mix is reported once per panel** (Task 4): `onTiers` carries how many 陷阱 fields the
 * template tier named and how many escalated, and the composition root logs that one line. The mix
 * is the health metric, so a run that starts falling to the escalation is visible before it dies.
 *
 * The **heart** field is the seam's measured exception: its atlas was recorded from a
 * chroma-segmented crop normalised against that crop's own median (chroma is what separates the
 * yellow numeral from the grey heart glyph beside it), while the template tier segments by luma
 * against the region's median. On a numeral-tight crop those disagree — measured 2026-11-07, three of
 * the five hearts refuse — so the heart keeps its own matcher until the atlas is re-recorded in the
 * tier's geometry or the tier takes an ink mode (task-3 report).
 *
 * The parser sits behind `ChestPerceiver`, which tries this panel before the QTE bar: a chest with no
 * trap goes from the panel straight to loot, so the loop must act while the bar may never exist.
 * Geometry: 1920×1080 device pixels; another size is unsupported, not re-scaled (contracts §0.5).
 */
import type { Frame, OpenerMember, OpenerPanel, Point, RgbaImage } from '../contracts.ts';
import {
  createNumeralsReader,
  ocrReader,
  type DigitTemplate,
  type Numerals,
  type NumeralsReader,
  type Region,
} from './readers/index.ts';

/** The only frame size the anchors were measured at (contracts §0.5). */
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

// ---------------------------------------------------------------------------------------------
// The panel gate
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
 * The card grid: three columns and two rows of 165 × 110 px cards. The second row starts at 853: its
 * content rows are the first row's + 124, and both rows' bottom borders sit at top + 110. A smaller
 * party fills the same grid row-major and stops — a hole in the prefix is refused, not renumbered.
 *
 * The boxes are the measured borders (inclusive) from `measurements.json`, so a slot's centre is the
 * midpoint of its box. The ids are the legacy script's positions: the agent only has to click the
 * slot the policy chose, never find the card.
 */
export type OpenerSlotId =
  | 'top-left'
  | 'top-middle'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-middle'
  | 'bottom-right';

export interface OpenerSlot {
  /** 0-based and row-major: the index `OpenerPanel.members` and `chooseOpener` use. */
  readonly index: number;
  readonly id: OpenerSlotId;
  /** The measured card border box, inclusive. */
  readonly rect: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** The point the loop taps to choose this card. */
  readonly centre: Point;
}

const CARD_COLUMNS: ReadonlyArray<readonly [number, number]> = [[704, 868], [879, 1046], [1057, 1220]];
const CARD_ROW_TOPS: readonly number[] = [729, 853];
const CARD_HEIGHT = 110;
const CARD_SLOT_IDS: readonly OpenerSlotId[] = [
  'top-left', 'top-middle', 'top-right',
  'bottom-left', 'bottom-middle', 'bottom-right',
];

/** The fixed panel: six slots, row-major, each with the box it was measured at and the point it is clicked at. */
export const OPENER_SLOTS: readonly OpenerSlot[] = CARD_ROW_TOPS.flatMap((top, row) =>
  CARD_COLUMNS.map(([x0, x1], column) => {
    const index = row * CARD_COLUMNS.length + column;
    return {
      index,
      id: CARD_SLOT_IDS[index]!,
      rect: { x0, y0: top, x1, y1: top + CARD_HEIGHT },
      centre: { x: Math.round((x0 + x1) / 2), y: top + Math.round(CARD_HEIGHT / 2) },
    } satisfies OpenerSlot;
  }),
);

const CARD_SLOTS = OPENER_SLOTS.length;

/** The slot member `index` sits on, or null for an index no card sits at. */
export function openerSlot(index: number): OpenerSlot | null {
  if (!Number.isInteger(index) || index < 0 || index >= CARD_SLOTS) return null;
  return OPENER_SLOTS[index]!;
}

/** Where the loop clicks to choose member `index`: the centre of its fixed card slot. */
export function openerCardCentre(index: number): Point | null {
  return openerSlot(index)?.centre ?? null;
}

const CARD_BORDER_INSET = 2;
const CARD_BORDER_LUMA = 65;
const CARD_BORDER_MIN_COLUMNS = 120;

/**
 * The measured field geometry — **exported because a recorded corpus must be cut by the same numbers
 * the parser reads with** (review F4). `scripts/record-readers-corpus.ts` cuts its crops from this
 * object and `tests/readers-corpus.test.ts` asserts the committed manifest against it, so moving a
 * band, an inset or the label's height turns the corpus red and forces a re-record instead of leaving
 * the fixture green against a geometry nobody reads any more.
 *
 * - `bandHeight` — a field's band is `[top, top + bandHeight)` rows below the card's top border;
 * - `trap.detect` / `trap.disarm` — those rows for 陷阱发现 / 陷阱解除;
 * - `heart.top` — the heart numeral's row;
 * - `numberLeft` / `numberRightInset` — the numeral window inside the card: `x0 + numberLeft` to
 *   `x1 - numberRightInset`. The 陷阱 labels end at card x0 + 71 and their numerals start at x0 + 76,
 *   so 74 clears the CJK;
 * - `heartLeft` — the heart window starts at `x1 - heartLeft`. The heart numeral is right-aligned in
 *   the card's right 70 px and the grey heart glyph sits just left of it; the heart numerals are
 *   yellow, which is what keeps the two apart;
 * - `labelAbove` / `labelHeight` — the label crop handed to a reader as context, 30 rows tall because
 *   a 16-row crop clips the CJK. Measured 2026-11-07 (readers spec, R2): the union of this label and
 *   the numeral band reads 陷阱发现38, while the numeral band alone reads nothing.
 */
export const OPENER_FIELD_GEOMETRY = {
  bandHeight: 16,
  trap: { detect: 64, disarm: 85 },
  heart: { top: 1 },
  numberLeft: 74,
  numberRightInset: 3,
  heartLeft: 70,
  labelAbove: 8,
  labelHeight: 30,
} as const;

const GEOMETRY = OPENER_FIELD_GEOMETRY;

/** Field bands, as y offsets from a card's top border (exclusive end). */
const TRAP_DETECT_BAND: readonly [number, number] = [GEOMETRY.trap.detect, GEOMETRY.trap.detect + GEOMETRY.bandHeight];
const TRAP_DISARM_BAND: readonly [number, number] = [GEOMETRY.trap.disarm, GEOMETRY.trap.disarm + GEOMETRY.bandHeight];
const HEART_BAND: readonly [number, number] = [GEOMETRY.heart.top, GEOMETRY.heart.top + GEOMETRY.bandHeight];

/** The numbers' x windows (see `OPENER_FIELD_GEOMETRY`). */
const TRAP_NUMBER_LEFT = GEOMETRY.numberLeft;
const NUMBER_RIGHT_INSET = GEOMETRY.numberRightInset;
const HEART_LEFT = GEOMETRY.heartLeft;

/** The 陷阱 label's crop, handed to the reader as the hint's label so an escalation has context. */
const TRAP_LABEL_ABOVE = GEOMETRY.labelAbove;
const TRAP_LABEL_HEIGHT = GEOMETRY.labelHeight;

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
 * heart is 18 px).
 *
 * **Three columns is a digit, not antialiasing.** `1` is the narrowest glyph, and its anti-aliased
 * flag can fall under the ink threshold while its stem survives. On the live 2026-10-31 panel the
 * middle `1` of `111` measured exactly 3 lit columns — its flags at 52 and 54 luma above a fill of
 * 46, against `INK_LUMA_DELTA` 55 — so a 4-column floor discarded it, the surviving atoms started
 * 18 px apart, and `readNumber` refused the numeral as truncated (`MAX_DIGIT_START_GAP` 13). One
 * unread 陷阱 numeral refuses the whole panel, because that numeral ranks every card. Two real glyphs
 * are separated by a 1–2 px gap, so a 3-column *run* between them cannot be a halo: it is a stem.
 */
const MIN_GLYPH_COLUMNS = 3;
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
 * Match floors. Both are NCC, and both refuse the whole panel rather than round: a wrong opener
 * choice spends the chest (chest §5).
 *
 * - The **陷阱 atlas** is complete (all ten digits) and its templates are means: the lowest true
 *   score on the two captures is 0.921 with a 0.133 runner-up margin, so 0.70 / 0.10 is a wide,
 *   measured floor.
 * - The **heart atlas** is partial (0, 1 and 9 only) and its templates are the observed instances
 *   themselves, so the guard is identity, not nearest-neighbour: matches must reach 0.95. The two
 *   captures' true heart reads are 0.996–1.000 (the same rendering, two JPEG encodes), and every one
 *   of the ten 陷阱 digits — the only unseen shapes the fixture contains, used as negative controls —
 *   tops out at 0.884 against this atlas as a *wrong* digit. An unseen heart numeral, e.g. one
 *   containing 6, is therefore below the floor and refuses the panel instead of snapping to 0, 1 or 9.
 */
const DIGIT_MATCH_MIN = 0.7;
const DIGIT_MARGIN_MIN = 0.1;
const HEART_MATCH_MIN = 0.95;
const HEART_MARGIN_MIN = 0.1;

/**
 * The two digit atlases, extracted by `scripts/extract-opener-digits.mjs` from `panel-00.jpg`:
 *
 * - `TRAP_DIGITS`, from the twelve 陷阱 values in `measurements.json` (all ten digits), is the
 *   **mean** of every instance, an 8 × 10 grid of 0–255 intensities, mean-centred and normalised at
 *   load.
 * - `HEART_DIGITS`, from the five heart numerals that frame shows (cards 1–3, 5, 6: 100 100 100 90
 *   100 — card 4, DragonSlayer, draws no heart), keeps **every observed instance separately**: 9
 *   zeros, 4 ones and 1 nine. **This atlas is partial on purpose.** The heart font's other seven
 *   digits were never captured; keeping the instances (rather than their mean) lets the parser demand
 *   a near-exact match to a numeral it has actually seen, so an unseen digit is refused rather than
 *   snapped to its nearest plausible shape. More captures — a panel with a willpower of 60 or 85 —
 *   would extend it. The 8 × 10 bytes are normalised at load like the 陷阱 ones.
 *
 * `node scripts/extract-opener-digits.mjs --verify` checks every one of these strings, and
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
const HEART_DIGITS: Readonly<Record<string, readonly string[]>> = {
  '0': [
    'ASmSuLxAAAANlJRMq5sfADzlVgBD6lYAUuNPAB/wdAZw20MAHOOLC2PaRQAd7YgJPd5NADbqUAAUwJlCm8guAAI7kqZ4QAQAAAAMGQkAAAA=',
    'AANBxrOLHQEAMqCJO6ODDA+rvxMIe7oVF82hDgBIuxcY1ZoMAD29GRfUoQ0BSrkXD6zAEwNZvBcAPc6kEamqEQABRLdweiMAAAAAEhkHAAA=',
    'Ajaa5OlkBgAOjoxOorsyACDJUQAY02oDQsZEABralg1SwTUAFL+oDzy9OgATuZgMIsFFABjSZQIQqIwLhsw4AAAmaHSMPAAAAAADEwoAAAA=',
    'AUS73LhMAgAOnJ1ajrAoAB76XwAb618AYvtdAB7wawNy7FQAGt6BCHbuVgAc6HUFKNpcAB3rVwANn6Qya94/AAAqc5NySgIAAAAFFQoAAAA=',
    'AA56ocdGBgAIcq4zer5DATbLZgQSutkYT8xCAAyd6xxcvkAACo7nHFnSSQANoOwcMcdeAxG20xcQrMIUZNODCgAliGaaWxAAAAAGGRIAAAA=',
    'ABl/v8BKBAAHbpVDorgvABO8fQYSvYkIWdRRARGyog5n1koAD6erD3DWUQEPq6oPKr1vBxO9jwoOm8YvfttHAAAheoaqWgkAAAAHGRMAAAA=',
    'AA5Kd1YtAQAIe6ZRia0lABnZWQAe8FgAH/VYABvlbgQf81QAHOmHCB7yVwAc63YFHvVdAB7zYAERtYQpZtI+AAAsn5CDXAAAAAAOFAwEAAA=',
    'AAxJbXY1BgAGcrwqhbw8ABvKYwMRsMUVRcI+AAuY5xtbzkAAC5fnG0vGPwALkd0aKMJfAw6m1hgKkMUVcc5fBAAjimSYVgsAAAAKFQ8CAAA=',
    'AAtHeH8uBAAKc5U+sLcvABa7YQQTvXcFT8BZAg+spA541k8AEbGpD2DJVwMQrZMLKb9mBhXFiQoLkKcQdNQ9AAAkd4OvVwsAAAAIFBYBAAA=',
  ],
  '1': [
    'AAAAChsKAAAAACeEyEwAAAAAIZbZQgAAAAAAW9xVAAAAAABd3VoAAAAAAGXbVAAAAAAAaNVRAAAAAABs0l4AAAAAH6vTeAAAAAAPKioaAAA=',
    'AAADHiwTAAAAACur6VgAAAAAC5HyYQAAAAAAVdBUAAAAAAA/2F4AAAAAADXUVwAAAAAANNFUAAAAAAA63mEAAAAAD3bufgAAAAAHHjAcAAA=',
    'AAAACyUPAAAAABuV0kkAAAAAAKXwWAAAAAAAbuFhAAAAAAB14WAAAAAAAHTcXQAAAAAAeuBdAAAAAAB76WcAAAAACrnxgwAAAAAFLDEdAAA=',
    'AAIlaysAAAAABYDlaQAAAAAASL9bAAAAAABMyF4AAAAAAE7LUwAAAAAATddeAAAAAABD0GAAAAAAAFXglxUAAAAHW7GQLQAAAAAGDgsCAAA=',
  ],
  '9': [
    'AAkQEwgAAAAtfHqXfgkAALanJUjrYAAA03sAANiqIwPVtSMA3b9ZCXW3q6nxt1cJAyY8uO1yGAIAAAvcxgAAAAAba3ceAAAAAA0dAwAAAAA=',
  ],
};

const ATLASES = new WeakMap<object, readonly DigitTemplate[]>();

/** One template per digit (the 陷阱 atlas's means). */
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

/** Every observed instance of every digit (the heart atlas), kept apart for near-exact matching. */
function variantAtlasOf(table: Readonly<Record<string, readonly string[]>>): readonly DigitTemplate[] {
  const cached = ATLASES.get(table);
  if (cached) return cached;
  const atlas: DigitTemplate[] = [];
  for (const [digit, variants] of Object.entries(table)) {
    for (const base64 of variants) {
      atlas.push({ digit, values: normaliseGlyph(Buffer.from(base64, 'base64')) });
    }
  }
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

/**
 * The 陷阱 atlas as the seam's templates. Exported because the template tier **takes its templates as
 * an input** (plan ruling R1): the data is the opener's, and the reader is built here from it, so the
 * readers module never imports this one.
 */
export const TRAP_DIGIT_TEMPLATES: readonly DigitTemplate[] = atlasOf(TRAP_DIGITS);

/**
 * The OCR escalation's budget (ruling R6, 2026-11-07; window R10, 2026-11-07) — one per **panel**
 * (review F1): `ChestPerceiver` creates it, hands it to every parse while the panel is up, and drops
 * it when a parse answers `not-panel`. Twelve fields each waiting out the escalation's 8 s bound would
 * hold a panel for ~96 s inside `parseOpenerDetailed`, which `chest.ts` awaits; the live failure the
 * escalation exists for is one unreadable field, not twelve. Past the budget a field refuses
 * (`null`), which refuses the panel exactly as any other unreadable 陷阱 field always has.
 *
 * At most **two calls**, and none starting more than **10 s after the first** — whichever comes first.
 * **The cap is the real budget**: OCR measures ~2.5–5 s per call on this host (Task 4 report), so the
 * window only has to stop an unbounded panel. At its former 2 s a second escalation could never start
 * after a real call returned, so a panel needing two calls could never read. At 10 s a first call is
 * cleared even at the OCR tier's own 8 s bound, and the two-call cap still bounds the panel: two
 * escalating fields can spend up to ~16 s, once per chest.
 */
export const OCR_MAX_CALLS = 2;
export const OCR_CALL_WINDOW_MS = 10_000;

/**
 * One panel's allowance of OCR escalations. `take()` answers whether one may start now and reserves
 * it; the window is measured from the first reserved call. The clock is injectable so a deadline
 * can be proved without waiting on one.
 */
export interface OcrBudget {
  take(): boolean;
}

export interface OcrBudgetOptions {
  /** The call cap; default `OCR_MAX_CALLS`. */
  readonly maxCalls?: number;
  /** The window from the first reserved call; default `OCR_CALL_WINDOW_MS`. */
  readonly windowMs?: number;
  /** The clock the window is measured on; default `Date.now`. */
  readonly now?: () => number;
}

/** A per-panel budget: at most `maxCalls`, none starting more than `windowMs` after the first. */
export function createOcrBudget(options: OcrBudgetOptions = {}): OcrBudget {
  const maxCalls = options.maxCalls ?? OCR_MAX_CALLS;
  const windowMs = options.windowMs ?? OCR_CALL_WINDOW_MS;
  const now = options.now ?? Date.now;
  let calls = 0;
  let firstAt = 0;
  return {
    take() {
      if (calls >= maxCalls) return false;
      const at = now();
      if (calls === 0) {
        firstAt = at;
        calls = 1;
        return true;
      }
      if (at - firstAt > windowMs) return false;
      calls += 1;
      return true;
    },
  };
}

/**
 * The 陷阱 fields' reader: the seam's **template** strategy over that atlas, with the opener's own
 * floors, escalating to `escalation` behind the parse's budget. 'template' is template -> ocr
 * (ruling R4, 2026-11-07): the rule tier is not in the chain because its general shapes name this
 * font's 4 as a 3, and OCR is the escalation for the day the atlas stops matching — which is
 * exactly what a raw capture does to it.
 *
 * Built per parse because the budget is per parse (R6): the template tier is the same tier every
 * time, but the escalation's allowance belongs to the panel, not to the process.
 */
function createTrapReader(escalation: NumeralsReader, budget: OcrBudget): NumeralsReader {
  return createNumeralsReader({
    strategy: 'template',
    templates: TRAP_DIGIT_TEMPLATES,
    matchFloor: DIGIT_MATCH_MIN,
    marginFloor: DIGIT_MARGIN_MIN,
    ocr: {
      async read(image, region, hint) {
        if (!budget.take()) return null;
        return escalation.read(image, region, hint);
      },
    },
  });
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

/**
 * Read a run of glyph atoms as a decimal number, or null at the first unreadable digit.
 *
 * This is the **heart field's** matcher (2026-11-07): the 陷阱 fields read through the seam, and the
 * heart keeps this one because its atlas was recorded in this function's geometry — chroma ink
 * against the numeral crop's own median — which the seam's template tier cannot reproduce (see the
 * header). The heart's identity floor, the trim search and the absent/unreadable answers around this
 * function are the opener's semantics and did not move with the other field.
 *
 * The atlas may hold several instances of one digit (the heart atlas), so scores are grouped by
 * digit before the margin is taken: the runner-up is the best *other* digit, never another instance
 * of the winner.
 */
function readNumber(
  data: Uint8Array,
  width: number,
  band: PanelBand,
  ink: InkRule,
  background: number,
  atlas: readonly DigitTemplate[],
  atoms: ReadonlyArray<readonly [number, number]>,
  matchFloor: number,
  marginFloor: number,
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
    const byDigit = new Map<string, number>();
    for (const { digit, values } of atlas) {
      let score = 0;
      for (let i = 0; i < feature.length; i += 1) score += feature[i]! * values[i]!;
      if (score > (byDigit.get(digit) ?? -2)) byDigit.set(digit, score);
    }
    let best: string | null = null;
    let bestScore = -2;
    let secondScore = -2;
    for (const [digit, score] of byDigit) {
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = digit;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    // Never a guess: an unreadable or ambiguous digit refuses the whole panel.
    if (best === null || bestScore < matchFloor || bestScore - secondScore < marginFloor) return null;
    text += best;
  }
  const value = Number(text);
  return Number.isInteger(value) ? value : null;
}

function cardBand(slot: number, offsets: readonly [number, number]): PanelBand {
  const { rect } = OPENER_SLOTS[slot]!;
  return { x0: rect.x0, x1: rect.x1, y0: rect.y0 + offsets[0], y1: rect.y0 + offsets[1] };
}

/** Is this card slot drawn? Its bottom border spans the card, and both rows carry one. */
function cardPresent(data: Uint8Array, width: number, slot: number): boolean {
  const { rect } = OPENER_SLOTS[slot]!;
  let lit = 0;
  for (let x = rect.x0 + CARD_BORDER_INSET; x <= rect.x1 - CARD_BORDER_INSET; x += 1) {
    if (pixelLuma(data, width, x, rect.y1) >= CARD_BORDER_LUMA) lit += 1;
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

/**
 * 陷阱发现 / 陷阱解除: white numerals on the card's dark fill, read through the numerals-reader seam.
 *
 * The **region**, the **floors** and the **refusal** stay the opener's: the band is the measured one,
 * the reader is built with DIGIT_MATCH_MIN / DIGIT_MARGIN_MIN, and a field with no answer is null —
 * which refuses the whole panel, because that numeral ranks every card. What moved into the reader is
 * only *which module names the digits*: the template tier first, and the OCR escalation when the
 * atlas stops matching (a raw capture does exactly that to an atlas recorded through the old JPEG
 * decode — the live failure of 2026-11-07).
 *
 * Two of the opener's own facts survive the seam:
 *
 * - **Structure before recognition**: a truncated number is still a number, and must be refused. The
 *   numerals are left-aligned and pitch-separated, so the atoms must start where numerals start and
 *   be no more than a digit's pitch apart (NUMBER_START_TOLERANCE / MAX_DIGIT_START_GAP).
 * - **The field drew one glyph per atom**: an answer of another length (an OCR answer to a field
 *   whose glyphs were overpainted, say) is a misread, not a shorter number.
 *
 * The escalation is asked at most `OCR_MAX_CALLS` times per parse (R6): past the budget a field
 * is refused without a call, so an unreadable panel cannot hold `chest.ts` for twelve 8 s bounds.
 */
async function readTrapNumber(
  image: RgbaImage,
  slot: number,
  field: 'detect' | 'disarm',
  trapReader: NumeralsReader,
): Promise<Numerals | null> {
  const { rect } = OPENER_SLOTS[slot]!;
  const card = cardBand(slot, field === 'detect' ? TRAP_DETECT_BAND : TRAP_DISARM_BAND);
  const band: PanelBand = {
    x0: rect.x0 + TRAP_NUMBER_LEFT,
    x1: rect.x1 - NUMBER_RIGHT_INSET,
    y0: card.y0,
    y1: card.y1,
  };
  const background = bandMedianLuma(image.data, image.width, band);
  const ink: InkRule = (x, y) => pixelLuma(image.data, image.width, x, y) - background >= INK_LUMA_DELTA;
  const atoms = glyphAtoms(columnRuns(image.data, image.width, band, ink));
  if (atoms.length === 0 || atoms.length > MAX_GLYPH_DIGITS) return null;
  if (atoms[0]![0] - band.x0 > NUMBER_START_TOLERANCE) return null;
  for (let index = 1; index < atoms.length; index += 1) {
    if (atoms[index]![0] - atoms[index - 1]![0] > MAX_DIGIT_START_GAP) return null;
  }

  const region: Region = { x: band.x0, y: band.y0, width: band.x1 - band.x0, height: band.y1 - band.y0 };
  const label: Region = {
    x: rect.x0,
    y: band.y0 - TRAP_LABEL_ABOVE,
    width: TRAP_NUMBER_LEFT,
    height: TRAP_LABEL_HEIGHT,
  };
  // The hint carries what the opener already knows about the field (review F6): its length, so an
  // OCR answer of another length is refused by the reader rather than by the comparison below (which
  // the escalation never sees), and its plausible range, so a `0` cannot be named for a field that
  // cannot carry one.
  const read = await trapReader.read(image, region, {
    label,
    digits: atoms.length as 1 | 2 | 3,
    min: 1,
    max: 999,
  });
  if (read === null) return null;
  return String(read.value).length === atoms.length ? read : null;
}

/**
 * The heart numeral. Its absence is a fact about the screen, not a failed read: the recorded panel
 * draws **no heart and no numeral at all** on DragonSlayer's card (Lv.48, silver gem), while the other
 * five show 100, 100, 100, 90 and 100.
 *
 * **That absence is the main character, not a failed read.** The game never displays 心 for 主人公,
 * so the card carries no heart and no numeral; `parseOpenerImage` records `null` and `chooseOpener`
 * accepts the member, because the floor cannot be checked against a number that was never on the
 * screen (operator rule 2026-10-31). It is not a claim that their willpower is at maximum: 陷阱恐惧
 * still applies to them in game, it is simply never drawn in this panel.
 *
 * **A numeral that is drawn but below the atlas's identity floor is a different fact**, and it costs
 * its own card only: `parseOpenerImage` writes `NaN` and the member stays ineligible, because the
 * numeral might have been under the floor itself. Nothing is ever substituted for either case.
 *
 * The heart is the one field whose absence does not change how the other cards rank — the 陷阱
 * numerals do, which is why those still refuse the panel — so keeping the other five readable is what
 * lets a live panel with one ineligible card be opened.
 */
export type HeartReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'read'; readonly value: number };

/**
 * The heart numeral's read over one crop of the field window (see `OPENER_FIELD_GEOMETRY`), or a
 * refusal.
 *
 * Exported for the heart corpus (review F5): the committed crops are that window, and this is the
 * matcher that reads them — the record must run through the reader that answers the field, not
 * through a copy of it. The crop must be the window itself: `heartLeft` columns (so its right edge is
 * the card's right border, the column the right-alignment check measures against) and
 * `bandHeight` rows.
 */
export function readHeartCrop(image: RgbaImage): HeartReading {
  return readHeartWindow(image.data, image.width, {
    x0: 0,
    x1: image.width - NUMBER_RIGHT_INSET,
    y0: 0,
    y1: image.height,
  }, image.width);
}

/** The heart field of one card: the window inside the frame, read by the same matcher as the corpus. */
function readHeartNumber(data: Uint8Array, width: number, slot: number): HeartReading {
  const { rect } = OPENER_SLOTS[slot]!;
  const band = cardBand(slot, HEART_BAND);
  return readHeartWindow(data, width, {
    x0: rect.x1 - HEART_LEFT,
    x1: rect.x1 - NUMBER_RIGHT_INSET,
    y0: band.y0,
    y1: band.y1,
  }, rect.x1);
}

/**
 * The heart matcher over one window: `cardRight` is the card's right border, which the right-alignment
 * check measures against (it is `window.x1` in the frame, and the crop's width in the corpus).
 */
function readHeartWindow(data: Uint8Array, width: number, window: PanelBand, cardRight: number): HeartReading {
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
  if (cardRight - located[located.length - 1]![1] > HEART_RIGHT_INSET_MAX) return { kind: 'unreadable' };
  const readExtent = (runs: ReadonlyArray<readonly [number, number]>): number | null => {
    const extent: PanelBand = {
      x0: runs[0]![0],
      x1: runs[runs.length - 1]![1] + 1,
      y0: window.y0,
      y1: window.y1,
    };
    const background = bandMedianLuma(data, width, extent);
    return readNumber(
      data, width, extent, ink, background,
      variantAtlasOf(HEART_DIGITS), glyphAtoms(runs), HEART_MATCH_MIN, HEART_MARGIN_MIN,
    );
  };
  let value = readExtent(located);
  /**
   * R30: the numeral's edges land on pixel boundaries and the two decoders disagree by one (measured:
   * GDI+ 864 vs jpeg-js 863 on the same JPEG, which made a live panel unreadable while its fixture
   * passed). A bounded edge search — zero to six columns off the left, none to two off the right — is
   * cheap (each candidate is an 8–12 px band) and the atlas still has to name every digit, so a wrong
   * trim cannot invent a number. When no trim reads, the card is `unreadable` and the panel keeps its
   * other cards (see the module header).
   */
  if (value === null) {
    for (let left = 0; left <= 6 && value === null; left += 1) {
      for (let right = 0; right <= 2 && value === null; right += 1) {
        if (left === 0 && right === 0) continue;
        const runs = located.map((run, index) => {
          const from = index === 0 ? run[0] + left : run[0];
          const to = index === located.length - 1 ? run[1] - right : run[1];
          return [from, to] as [number, number];
        });
        if (runs[0]![1] - runs[0]![0] + 1 < MIN_GLYPH_COLUMNS) break;
        value = readExtent(runs);
      }
    }
  }
  return value === null ? { kind: 'unreadable' } : { kind: 'read', value };
}

/**
 * How a panel's ranking fields were answered (readers plan 2026-11-07, Task 4): the 陷阱 fields the
 * template tier named, and the fields the template tier **refused** and the escalation answered.
 *
 * The escalation is the reader a caller named — the OCR tier in production (R9; `main.ts` passes it
 * directly), any reader in a test — and an injected chain may answer as another tier, so the second
 * slot counts *escalations*, not OCR answers specifically. That keeps the two counts adding up to the
 * fields a panel was read for, which is what the once-per-panel log reports. The heart field is not
 * on the seam (R5) and is not counted.
 */
export interface OpenerTierSummary {
  /** Fields the atlas tier named. */
  readonly template: number;
  /** Fields the atlas tier refused and the escalation answered, whichever tier of it answered. */
  readonly ocr: number;
}

/**
 * How one parse reads its 陷阱 fields. Both fields exist for the tests: the escalation is what a
 * counter counts (the budget, R6) and what a thrower refuses to be (the decoded fixture's fast-tier
 * read); the budget is what a fake clock makes deterministic.
 */
export interface OpenerParseOptions {
  /**
   * The reader the trap fields **escalate to** when the template tier refuses a field — the OCR
   * tier in production. Defaults to the readers package's `ocrReader`; the parse's budget wraps it
   * either way.
   */
  readonly trapReader?: NumeralsReader;
  /**
   * The panel's OCR budget; default a fresh `createOcrBudget()` (two calls, 10 s — R6/R10). The
   * composition root passes the same one for every observation of one panel (review F1).
   */
  readonly ocrBudget?: OcrBudget;
  /**
   * Called **once** for every panel the gates recognised — read or refused — with the tier mix of the
   * 陷阱 fields answered. A refusal reports the fields answered before it, which is what makes a
   * panel the escalation could not finish visible. The read never depends on the callback.
   */
  readonly onTiers?: (summary: OpenerTierSummary) => void;
}

/** async because the numerals are read through the seam, whose OCR tier leaves the process. */
export async function parseOpenerImage(
  image: RgbaImage,
  options: OpenerParseOptions = {},
): Promise<OpenerParse> {
  const { data, width, height } = image;
  if (width !== REFERENCE_WIDTH || height !== REFERENCE_HEIGHT) return { ok: false, reason: 'not-panel' };
  if (!isOpenerPanel(data, width)) return { ok: false, reason: 'not-panel' };

  // Segment the cards rather than assuming six: the party fills the grid row-major and stops.
  let count = 0;
  while (count < CARD_SLOTS && cardPresent(data, width, count)) count += 1;
  if (count === 0) return { ok: false, reason: 'not-panel' };
  // A drawn card after an undrawn one is a layout this parser has never seen: refuse, do not renumber.
  // The panel was recognised (the gates above) and is refused before any numeral is read, so the tier
  // log still sees it — with nothing read, both counts are zero. Once per recognised panel means once
  // per panel, not once per panel that got as far as a field: a refusal that reports nothing is
  // exactly the silence the log exists to close.
  for (let slot = count; slot < CARD_SLOTS; slot += 1) {
    if (cardPresent(data, width, slot)) {
      options.onTiers?.({ template: 0, ocr: 0 });
      return { ok: false, reason: 'unreadable' };
    }
  }

  // One reader per parse: the escalation's allowance belongs to the panel (R6).
  const trapReader = createTrapReader(options.trapReader ?? ocrReader, options.ocrBudget ?? createOcrBudget());
  const traps: Array<{ detect: number; disarm: number }> = [];
  const hearts: HeartReading[] = [];
  // The tier mix of this panel (Task 4): counted per field, reported once, whatever the outcome.
  // The escalation's own tier is not named here — production passes OCR, a test may pass any reader —
  // so anything the template tier did not answer is an escalation. The counts add up.
  const tiers: { template: number; ocr: number } = { template: 0, ocr: 0 };
  const countTier = (read: Numerals): void => {
    if (read.tier === 'template') tiers.template += 1;
    else tiers.ocr += 1;
  };
  for (let slot = 0; slot < count; slot += 1) {
    const detect = await readTrapNumber(image, slot, 'detect', trapReader);
    const disarm = await readTrapNumber(image, slot, 'disarm', trapReader);
    if (detect === null || disarm === null) {
      options.onTiers?.({ ...tiers });
      return { ok: false, reason: 'unreadable' };
    }
    countTier(detect);
    countTier(disarm);
    traps.push({ detect: detect.value, disarm: disarm.value });
    hearts.push(readHeartNumber(data, width, slot));
  }
  options.onTiers?.({ ...tiers });

  const members: OpenerMember[] = traps.map((value, index) => {
    const reading = hearts[index]!;
    return {
      // The name is CJK and cannot be read: address the member by the fixed slot it sits on (1-based).
      name: `#${index + 1}`,
      detect: value.detect,
      disarm: value.disarm,
      // Two different absences, two different answers. A numeral the atlas cannot read is `NaN`: the
      // card is ineligible, because the value might have been under the floor. A card that draws no
      // heart at all is `null`: that is the main character, whose willpower the game never displays
      // (operator rule 2026-10-31), and the floor cannot be checked against a number that is not on
      // the screen. Neither is ever substituted.
      willpower: reading.kind === 'read' ? reading.value : reading.kind === 'absent' ? null : Number.NaN,
      // 陷阱恐惧 is not rendered in this panel — the willpower floor is what protects the choice.
      feared: false,
    };
  });
  return { ok: true, panel: { members } };
}

/**
 * One opener-panel read. The panel is either read (with `NaN` standing for a heart that was not drawn
 * or could not be read) or refused with the reason the perceiver needs: `not-panel` falls through to
 * the bar, while `unreadable` is a panel the gates recognised but whose *ranking* fields could not be
 * read — its perceiver answer is `unknown` at a small positive confidence, so it escalates instead of
 * stopping the session as a blank frame would.
 */
export type OpenerParse =
  | { readonly ok: true; readonly panel: OpenerPanel }
  | { readonly ok: false; readonly reason: 'not-panel' | 'unreadable' };

/**
 * Read the `由谁打开?` opener panel out of one frame, or refuse it. Refusal is a value, not a throw
 * (contracts §0.6); `parseOpenerDetailed` keeps the reason.
 */
export async function parseOpenerDetailed(
  frame: Frame,
  options: OpenerParseOptions = {},
): Promise<OpenerParse> {
  if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) return { ok: false, reason: 'not-panel' };
  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch {
    return { ok: false, reason: 'not-panel' };
  }
  return await parseOpenerImage(image, options);
}

/** The brief's shape: the panel, or `null` for every refusal. */
export async function parseOpener(
  frame: Frame,
  options: OpenerParseOptions = {},
): Promise<OpenerPanel | null> {
  const parsed = await parseOpenerDetailed(frame, options);
  return parsed.ok ? parsed.panel : null;
}


