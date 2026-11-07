# 2026-11-07 — Readers: a seam for numerals, with an OCR tier

The opener panel `由谁打开?` failed live on 2026-11-07 04:16 for a reason no click could explain: the
panel was **recognised** and then refused by its own reader (`unreadable` → `unknown 0.3`), so the
World's `open-chest` in-flight never saw a named screen and timed out. The refusing field is a 陷阱
numeral: `readNumber`'s NCC match falls under `DIGIT_MATCH_MIN`. The atlases are **means of glyphs
recorded through the old JPEG decode**; the vision module (2026-11-07) now hands perception **raw**
pixels, which are sharper, and the match fails.

This is a class, not an incident: the same module's header already records `GDI+ 864 vs jpeg-js 863`
making "a live panel unreadable while its fixture passed", and the map's digit atlas had to be patched
for a digit nobody had met. **Perception must not encode a property of the capture pipeline.**

## The seam

```ts
// src/perception/readers/contract.ts
export interface NumeralsReader {
  read(image: RgbaImage, region: Region, hint?: ReadHint): Promise<Numerals | null>;
}
export interface ReadHint {
  readonly digits?: 1 | 2 | 3;         // the field's expected length, when known
  readonly label?: Region;             // the field's label, for a reader that needs context
  readonly min?: number; readonly max?: number;  // sanity bounds; outside is a refusal
}
export interface Numerals { readonly value: number; readonly confidence: number; readonly tier: Tier }
export type Tier = 'rule' | 'template' | 'ocr';
```

Three implementations, each `src/perception/readers/<tier>.ts`:

- **`ruleReader`** — `src/perception/number.ts`'s shape rules (fast, no data).
- **`templateReader`** — today's atlases (fast; the codec-sensitive one, kept for speed).
- **`ocrReader`** — the OCR escalation: the region is cropped, written as a PPM, read by
  `scripts/ocr-readout.py` (RapidOCR in the operator's venv), and the digits in the answer are the
  value. Bounded (timeout), `null` on absence, exactly the map readout's proven pattern
  (2026-11-07: 16/4, 13/25, 19/2, 20/14 all correct).

`autoReader` tries `rule` → `template` → `ocr` and **reports which tier answered**. The tier mix is
the health metric: when the fast tiers start falling through, that is visible before a run dies.

## What changes

- The opener's 陷阱 numerals (`readTrapNumber`) read through the seam, with the field's label as
  context (measured 2026-11-07: OCR reads `陷阱发现38` and `陷阱解除49` correctly when the crop carries
  the label; a context-free 60 px slice reads nothing). The **heart** field does not: its atlas was
  recorded with the opener's chroma ink on a numeral-tight crop and normalised against that crop's own
  median, while the tier segments by luma against the region median — 3 of 5 hearts refuse at its 0.95
  identity floor, and on the sharpened proxy even the opener's own matcher refuses card 1's 100 (0.871).
  It keeps its matcher until the atlas is re-recorded in the tier's geometry (R5).
- The semantic rules do not move into the reader: a value outside the field's range, or the heart's
  `absent` vs `unreadable` distinction, stay the opener's (contracts §0.6 — the reader names a number,
  the caller names the fact).
- **Config** (`worlds.wvd.readers`): `numerals: 'auto' | 'fast' | 'ocr'` (default `auto`). `fast` is
  `rule` → `template` with no OCR; `ocr` skips the fast tiers. The OCR runtime path is the existing
  `WVD_OCR_PYTHON`/`WVD_OCR_SCRIPT` pair; unset means the OCR tier is unavailable, not an error.

## Durability

A committed **regression corpus** of each numeric field's crop, in both the old-decoded and the raw
form (`testdata/readers/<field>/`), run through every tier by one test. A capture-pipeline change
breaks a test instead of a night run. The next field to move onto the seam is the map readout (it
already escalates to OCR); the chest card and battle panel follow when their fields are next touched.

## Non-goals

- No change to the vision module, the capture path, or the frame contract.
- No model in the loop: the OCR tier is an escalation invoked only when the fast tiers refuse a field.
- No redesign of the numeric semantics (the opener keeps its floors and its refusal answers).
- No second perception profile: raw and decoded frames are both supported by the corpus, not by a
  separate set of constants.

## Acceptance

1. The opener panel reads `measurements.json`'s values from `panel-00.jpg` **and** from a sharpened
   variant of it (the raw-pixel proxy that reproduced the live failure) — the fast tier may answer the
   first, the OCR tier the second, and the answer is the same.
2. The tier that answered is logged for every field read, and `readers.numerals` switches the strategy.
3. The full suite green, `tsc` clean.
4. Live: the farm reaches a chest, the opener panel is named, the chest is opened (needs the game
   launched by the operator).
