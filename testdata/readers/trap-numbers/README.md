# The 陷阱 numerals corpus (2026-11-07)

Recorded by `scripts/record-readers-corpus.ts` from
`testdata/chest/2026-10-24-opener/panel-00.jpg` (the 由谁打开? opener panel); the expected values
are that fixture's `measurements.json`. There are twelve 陷阱 fields - six cards x 陷阱发现 /
陷阱解除 - and each is committed in **both** forms, so 24 crops.

## What each crop is

Each crop is the exact rectangle the opener hands its reader: the numeral band union its label. The
label is the OCR tier's context - a context-free 87 x 16 band of this panel reads nothing while the
crop that carries 陷阱发现 reads `陷阱发现38` (measured 2026-11-07) - and the fast tiers ignore it
except for the containment check.

The crop geometry is not written here by hand: `OPENER_FIELD_GEOMETRY` in
`src/perception/opener.ts` is the parser's own, and `tests/readers-corpus.test.ts` asserts this
manifest against it (review F4). A band that moves in the parser makes the corpus red until it is
re-recorded.

- `*-decoded.ppm` - the fixture as `panel-00.jpg` decodes. This is the form the fast tiers answer.
- `*-sharp.ppm` - the **sharpened proxy**: `img + amount * (img - boxBlur)`, a 4-neighbour box blur,
  amount 1, clamped. It is the unsharp helper the tests use and the raw-capture stand-in plan ruling
  R3 keeps until the game is launched: sharpening the decoded pixels moves them off the digit atlases
  the same way a raw capture does.

The crops are binary PPM (P6: header `P6\n<width> <height>\n255\n` then RGB), not JPEG - a
corpus that re-encodes its own pixels would measure the encoder. Node has no PNG codec here; view one
with `ffmpeg -i card-1-detect-decoded.ppm card-1-detect-decoded.png`.

## The expected values

| crop | card | field | form | expected |
| --- | --- | --- | --- | --- |
| `card-1-detect-decoded.ppm` | 1 | 陷阱发现 | decoded | 38 |
| `card-1-detect-sharp.ppm` | 1 | 陷阱发现 | sharp | 38 |
| `card-1-disarm-decoded.ppm` | 1 | 陷阱解除 | decoded | 49 |
| `card-1-disarm-sharp.ppm` | 1 | 陷阱解除 | sharp | 49 |
| `card-2-detect-decoded.ppm` | 2 | 陷阱发现 | decoded | 28 |
| `card-2-detect-sharp.ppm` | 2 | 陷阱发现 | sharp | 28 |
| `card-2-disarm-decoded.ppm` | 2 | 陷阱解除 | decoded | 50 |
| `card-2-disarm-sharp.ppm` | 2 | 陷阱解除 | sharp | 50 |
| `card-3-detect-decoded.ppm` | 3 | 陷阱发现 | decoded | 34 |
| `card-3-detect-sharp.ppm` | 3 | 陷阱发现 | sharp | 34 |
| `card-3-disarm-decoded.ppm` | 3 | 陷阱解除 | decoded | 38 |
| `card-3-disarm-sharp.ppm` | 3 | 陷阱解除 | sharp | 38 |
| `card-4-detect-decoded.ppm` | 4 | 陷阱发现 | decoded | 92 |
| `card-4-detect-sharp.ppm` | 4 | 陷阱发现 | sharp | 92 |
| `card-4-disarm-decoded.ppm` | 4 | 陷阱解除 | decoded | 105 |
| `card-4-disarm-sharp.ppm` | 4 | 陷阱解除 | sharp | 105 |
| `card-5-detect-decoded.ppm` | 5 | 陷阱发现 | decoded | 62 |
| `card-5-detect-sharp.ppm` | 5 | 陷阱发现 | sharp | 62 |
| `card-5-disarm-decoded.ppm` | 5 | 陷阱解除 | decoded | 43 |
| `card-5-disarm-sharp.ppm` | 5 | 陷阱解除 | sharp | 43 |
| `card-6-detect-decoded.ppm` | 6 | 陷阱发现 | decoded | 77 |
| `card-6-detect-sharp.ppm` | 6 | 陷阱发现 | sharp | 77 |
| `card-6-disarm-decoded.ppm` | 6 | 陷阱解除 | decoded | 79 |
| `card-6-disarm-sharp.ppm` | 6 | 陷阱解除 | sharp | 79 |

`manifest.json` is the machine-readable record: each crop's card slot, field, form, size, the
reader region and hint label inside the crop, and the expected value. The plausible range is
**1-999** - a 陷阱 bonus is a positive number of at most three digits (the widest numeral field the
seam names) - and no tier may answer outside it.

## How it is used

`tests/readers-corpus.test.ts` runs the rule, template and OCR tiers over every crop: the
template tier reads the decoded values, the OCR tier (when this host has its runtime) reads both
forms, and each tier's measured defeats are **recorded** rather than hidden. The rule tier's known
4-vs-3 misname (board card `t-mw65nlh4-lfoik7`) and its other misreads on this font are pinned
beside the measured values, and so are the OCR tier's two box-split refusals and its 77-as-177
misread on the sharpened crops. A fix turns the test red on purpose; the corpus is then re-recorded.

Do not edit a crop or the manifest by hand: re-run the script.
