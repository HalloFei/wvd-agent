# The heart numerals corpus (2026-11-07)

Recorded by `scripts/record-readers-corpus.ts` from the same opener fixture as the 陷阱 corpus,
`testdata/chest/2026-10-24-opener/panel-00.jpg`. The heart field is the second numeric field of
the panel (the reader's spec says each numeric field, so it is on the record even though R5 keeps
it on its own matcher).

## What each crop is

The card's right `heartLeft` px (70) at the heart band's rows (1..16 below the card's top border),
i.e. the parser's heart window plus the three columns of the right inset, so the crop ends at the
card's right border - the column the matcher's right-alignment check measures against. Every card
is committed, including card 4, which draws no heart: its empty window is how `absent` is proved.

Both forms are the same pair as the 陷阱 corpus: `*-decoded.ppm` is the fixture as it decodes, and
`*-sharp.ppm` is the sharpened raw-pixel proxy (R3).

## What it measured (2026-11-07)

The committed crops, read by the opener's own heart matcher (`readHeartCrop` in
`src/perception/opener.ts` - the same function the panel uses, not a copy):

- decoded: 100, 100, 100, absent (card 4), 90, 100 - every drawn numeral reads;
- sharpened proxy: 100, unreadable (the second card), 100, absent (card 4), 90, 100 - that
  card's 100 (it is a 100) falls to 0.871 against the 0.95 identity floor.

That is R5's stated second clause, recorded - with one correction: R5's prose says "card 1", and
the refused numeral is the **second** card (index 1). The value and the score are R5's numbers;
the attribution is this corpus's, measured (review F5). R5's "3 of 5 hearts refuse" is the
**template tier's** answer on a numeral-tight crop, not this matcher's on the field window, so the
record and the ruling do not conflict: the heart stays on its matcher (R5), and its values are
pinned here.

answer on a numeral-tight crop, not this matcher's on the field window, so the record and the ruling
do not conflict: the heart stays on its matcher (R5), and its values are pinned here.

## The expected values

| crop | card | form | expected |
| --- | --- | --- | --- |
| `card-1-heart-decoded.ppm` | 1 | decoded | 100 |
| `card-1-heart-sharp.ppm` | 1 | sharp | 100 |
| `card-2-heart-decoded.ppm` | 2 | decoded | 100 |
| `card-2-heart-sharp.ppm` | 2 | sharp | 100 |
| `card-3-heart-decoded.ppm` | 3 | decoded | 100 |
| `card-3-heart-sharp.ppm` | 3 | sharp | 100 |
| `card-4-heart-decoded.ppm` | 4 | decoded | absent |
| `card-4-heart-sharp.ppm` | 4 | sharp | absent |
| `card-5-heart-decoded.ppm` | 5 | decoded | 90 |
| `card-5-heart-sharp.ppm` | 5 | sharp | 90 |
| `card-6-heart-decoded.ppm` | 6 | decoded | 100 |
| `card-6-heart-sharp.ppm` | 6 | sharp | 100 |

The values are what the matcher returns on the committed crop, not a guess: `tests/readers-corpus.test.ts`
runs `readHeartCrop` over every one and pins the list above by card. A different answer is a
deliberate re-record.

Do not edit a crop or the manifest by hand: re-run the script.
