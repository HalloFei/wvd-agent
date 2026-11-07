#!/usr/bin/env tsx
/**
 * Record the numerals regression corpus (readers plan, Task 5).
 *
 * What it records: the twelve 陷阱 fields of the opener fixture `panel-00.jpg` — six cards x
 * 陷阱发现 / 陷阱解除 — each as the exact crop the opener hands its reader (the numeral band ∪ its
 * label), in two forms:
 *
 * - **decoded** — the crop of the fixture as `panel-00.jpg` decodes;
 * - **sharpened** — the crop of the sharpened proxy, `img + amount * (img - boxBlur)` with a
 *   4-neighbour box blur and amount 1. It is the raw-capture stand-in the 2026-11-07 diagnosis used
 *   and that plan ruling R3 keeps until the game is launched; sharpening the decoded pixels moves
 *   them off the atlases the same way raw pixels do.
 *
 * Why both: the numerals-reader seam exists because the digit atlases were means recorded through
 * the old JPEG decode, and a raw capture moves the pixels off them. One committed crop of each form
 * means a capture-pipeline change breaks a test instead of a night run (readers spec, "Durability").
 *
 * The crops are binary PPM (P6): lossless, the same format the OCR escalation already writes, and
 * Node has no PNG codec (the repo's rule for the map templates). View one with
 * `ffmpeg -i card-1-detect-decoded.ppm card-1-detect-decoded.png`.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/record-readers-corpus.ts
 *
 * Re-run it only when the fixture changes: the crops are the record, not a build artifact.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { RgbaImage } from '../src/contracts.ts';
import { OPENER_SLOTS } from '../src/perception/opener.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'testdata/chest/2026-10-24-opener/panel-00.jpg';
const MEASUREMENTS = 'testdata/chest/2026-10-24-opener/measurements.json';
const CORPUS = 'testdata/readers/trap-numbers';

/*
 * The opener's measured field geometry (opener.ts's private TRAP_DETECT_BAND / TRAP_DISARM_BAND,
 * TRAP_NUMBER_LEFT, NUMBER_RIGHT_INSET, TRAP_LABEL_ABOVE and TRAP_LABEL_HEIGHT). Duplicated here on
 * purpose: a recording script must not reach into the parser's private geometry, and the corpus is a
 * snapshot of the field as the parser reads it — if the parser moves a band, re-record this corpus.
 */
const BAND_TOP = { detect: 64, disarm: 85 } as const;
const BAND_HEIGHT = 16;
const TRAP_NUMBER_LEFT = 74;
const NUMBER_RIGHT_INSET = 3;
const TRAP_LABEL_ABOVE = 8;
const TRAP_LABEL_HEIGHT = 30;

/**
 * The field's plausible range: a 陷阱 bonus is a positive number the card can show in at most three
 * digits (opener.ts's MAX_GLYPH_DIGITS). Zero and four-digit values are not a value the field can
 * carry, so a tier naming one has gone wrong.
 */
const MIN_VALUE = 1;
const MAX_VALUE = 999;

interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface MeasuredMember {
  readonly name: string;
  readonly detect: number;
  readonly disarm: number;
}

interface CorpusField {
  readonly file: string;
  readonly card: number;
  readonly slot: number;
  readonly field: 'detect' | 'disarm';
  readonly form: 'decoded' | 'sharp';
  readonly width: number;
  readonly height: number;
  readonly region: Region;
  readonly label: Region;
  readonly expected: number;
}

/** The sharpened proxy: the identical arithmetic on the same pixels as `sharpened` in the tests. */
function sharpened(image: RgbaImage, amount: number): RgbaImage {
  const { data, width, height } = image;
  const out = new Uint8Array(data.length);
  const at = (x: number, y: number): number[] => {
    const offset = (y * width + x) * 4;
    return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  };
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const centre = at(x, y);
      const neighbours = [
        at(Math.max(0, x - 1), y),
        at(Math.min(width - 1, x + 1), y),
        at(x, Math.max(0, y - 1)),
        at(x, Math.min(height - 1, y + 1)),
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const blur = (centre[channel]! * 2 + neighbours.reduce((sum, n) => sum + n[channel]!, 0)) / 6;
        out[offset + channel] = clamp(centre[channel]! + amount * (centre[channel]! - blur));
      }
      out[offset + 3] = data[offset + 3]!;
    }
  }
  return { data: out, width, height };
}

/** The pixels of `region`, cut out of a frame (the crop the reader is handed). */
function crop(image: RgbaImage, region: Region): RgbaImage {
  const data = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y += 1) {
    const from = ((region.y + y) * image.width + region.x) * 4;
    data.set(image.data.subarray(from, from + region.width * 4), y * region.width * 4);
  }
  return { data, width: region.width, height: region.height };
}

/** The crop as a binary PPM (P6): the lossless format the OCR escalation already writes. */
function ppmOf(image: RgbaImage): Buffer {
  const header = Buffer.from(`P6\n${image.width} ${image.height}\n255\n`, 'ascii');
  const body = Buffer.alloc(image.width * image.height * 3);
  for (let index = 0; index < image.width * image.height; index += 1) {
    body[index * 3] = image.data[index * 4]!;
    body[index * 3 + 1] = image.data[index * 4 + 1]!;
    body[index * 3 + 2] = image.data[index * 4 + 2]!;
  }
  return Buffer.concat([header, body]);
}

const decoded = jpeg.decode(readFileSync(ROOT + FIXTURE), { useTArray: true });
const panel: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
const sharp = sharpened(panel, 1);
const members = (JSON.parse(readFileSync(ROOT + MEASUREMENTS, 'utf8')) as { members: MeasuredMember[] }).members;

// A re-record owns the directory's crops: a crop the current manifest no longer names (a renamed
// field, or debris from an interrupted run) must not linger as a stale fixture.
mkdirSync(ROOT + CORPUS, { recursive: true });
for (const entry of readdirSync(ROOT + CORPUS)) {
  if (entry.endsWith('.ppm')) rmSync(ROOT + CORPUS + '/' + entry);
}

const fields: CorpusField[] = [];
for (const { index: slot, rect } of OPENER_SLOTS) {
  for (const field of ['detect', 'disarm'] as const) {
    const band: Region = {
      x: rect.x0 + TRAP_NUMBER_LEFT,
      y: rect.y0 + BAND_TOP[field],
      width: rect.x1 - NUMBER_RIGHT_INSET - (rect.x0 + TRAP_NUMBER_LEFT),
      height: BAND_HEIGHT,
    };
    const label: Region = {
      x: rect.x0,
      y: band.y - TRAP_LABEL_ABOVE,
      width: TRAP_NUMBER_LEFT,
      height: TRAP_LABEL_HEIGHT,
    };
    // The read covers region ∪ label: the numeral band and the CJK label the OCR tier needs as
    // context (a context-free band reads nothing, measured 2026-11-07).
    const x = Math.min(band.x, label.x);
    const y = Math.min(band.y, label.y);
    const width = Math.max(band.x + band.width, label.x + label.width) - x;
    const height = Math.max(band.y + band.height, label.y + label.height) - y;
    const union: Region = { x, y, width, height };
    for (const form of ['decoded', 'sharp'] as const) {
      const file = `card-${slot + 1}-${field}-${form}.ppm`;
      const source = form === 'decoded' ? panel : sharp;
      writeFileSync(ROOT + CORPUS + '/' + file, ppmOf(crop(source, union)));
      fields.push({
        file,
        card: slot + 1,
        slot,
        field,
        form,
        width,
        height,
        region: { x: band.x - x, y: band.y - y, width: band.width, height: band.height },
        label: { x: label.x - x, y: label.y - y, width: label.width, height: label.height },
        expected: field === 'detect' ? members[slot]!.detect : members[slot]!.disarm,
      });
    }
  }
}

const manifest = {
  generatedBy: 'scripts/record-readers-corpus.ts',
  source: FIXTURE,
  measurements: MEASUREMENTS,
  note:
    'One committed crop per 陷阱 field (numeral band ∪ label) in both forms: the decoded fixture and '
    + 'the sharpened raw-pixel proxy (img + 1 * (img - 4-neighbour box blur), clamped). The crops are '
    + 'binary PPM (P6), not JPEG: a corpus that re-encodes its own pixels would measure the encoder.',
  sharpened: {
    amount: 1,
    kernel: '4-neighbour box blur, weights centre 2 / each neighbour 1 over 6, img + amount * (img - blur), clamped',
  },
  range: { min: MIN_VALUE, max: MAX_VALUE },
  fields,
};

writeFileSync(ROOT + CORPUS + '/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const rows = fields
  .map((entry) =>
    `| \`${entry.file}\` | ${entry.card} | ${entry.field === 'detect' ? '陷阱发现' : '陷阱解除'} | ${entry.form} | ${entry.expected} |`)
  .join('\n');

const readme = `# The 陷阱 numerals corpus (2026-11-07)

Recorded by \`scripts/record-readers-corpus.ts\` from
\`testdata/chest/2026-10-24-opener/panel-00.jpg\` (the 由谁打开? opener panel); the expected values
are that fixture's \`measurements.json\`. There are twelve 陷阱 fields — six cards × 陷阱发现 /
陷阱解除 — and each is committed in **both** forms, so 24 crops.

## What each crop is

Each crop is the exact rectangle the opener hands its reader: the numeral band ∪ its label. The
label is the OCR tier's context — a context-free 87 × 16 band of this panel reads nothing while the
crop that carries 陷阱发现 reads \`陷阱发现38\` (measured 2026-11-07) — and the fast tiers ignore it
except for the containment check.

- \`*-decoded.ppm\` — the fixture as \`panel-00.jpg\` decodes. This is the form the fast tiers answer.
- \`*-sharp.ppm\` — the **sharpened proxy**: \`img + amount·(img − boxBlur)\`, a 4-neighbour box blur,
  amount 1, clamped. It is the unsharp helper the tests use and the raw-capture stand-in plan ruling
  R3 keeps until the game is launched: sharpening the decoded pixels moves them off the digit atlases
  the same way a raw capture does.

The crops are binary PPM (P6: header \`P6\\n<width> <height>\\n255\\n\` then RGB), not JPEG — a
corpus that re-encodes its own pixels would measure the encoder. Node has no PNG codec here; view one
with \`ffmpeg -i card-1-detect-decoded.ppm card-1-detect-decoded.png\`.

## The expected values

| crop | card | field | form | expected |
| --- | --- | --- | --- | --- |
${rows}

\`manifest.json\` is the machine-readable record: each crop's card slot, field, form, size, the
reader region and hint label inside the crop, and the expected value. The plausible range is
**1–999** — a 陷阱 bonus is a positive number of at most three digits (the widest numeral field the
seam names) — and no tier may answer outside it.

## How it is used

\`tests/readers-corpus.test.ts\` runs the rule, template and OCR tiers over every crop: the
template tier reads the decoded values, the OCR tier (when this host has its runtime) reads both
forms, and each tier's measured defeats are **recorded** rather than hidden. The rule tier's known
4-vs-3 misname (board card \`t-mw65nlh4-lfoik7\`) and its other misreads on this font are pinned
beside the measured values, and so are the OCR tier's two box-split refusals and its 77-as-177
misread on the sharpened crops. A fix turns the test red on purpose; the corpus is then re-recorded.

Do not edit a crop or the manifest by hand: re-run the script.
`;

writeFileSync(ROOT + CORPUS + '/README.md', readme);

const bytes = fields.reduce((sum, entry) => sum + readFileSync(ROOT + CORPUS + '/' + entry.file).length, 0);
console.log(JSON.stringify({ recorded: fields.length, files: fields.map((entry) => entry.file), bytes }));
