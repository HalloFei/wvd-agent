#!/usr/bin/env tsx
/**
 * Record the numerals regression corpus (readers plan, Task 5; spec "Durability").
 *
 * What it records, in both forms:
 *
 * - **trap-numbers/** — the twelve 陷阱 fields of the opener fixture panel-00.jpg: six cards x
 *   陷阱发现 / 陷阱解除, each as the exact crop the opener hands its reader (the numeral band plus its
 *   label);
 * - **heart/** — every card's heart field of the same fixture: the window the heart matcher reads, so
 *   the five drawn numerals *and* card 4's empty window (the main character draws no heart) are on
 *   the record (review F5: Durability says each numeric field, and R5 defers the migration, not the
 *   record).
 *
 * The two forms are:
 *
 * - **decoded** — the crop of the fixture as panel-00.jpg decodes;
 * - **sharpened** — the crop of the sharpened proxy, img + amount * (img - boxBlur) with a 4-neighbour
 *   box blur and amount 1. It is the raw-capture stand-in the 2026-11-07 diagnosis used and that plan
 *   ruling R3 keeps until the game is launched: sharpening the decoded pixels moves them off the
 *   atlases the same way raw pixels do.
 *
 * Why both: the numerals-reader seam exists because the digit atlases were means recorded through the
 * old JPEG decode, and a raw capture moves the pixels off them. One committed crop of each form means
 * a capture-pipeline change breaks a test instead of a night run (readers spec, "Durability").
 *
 * **The geometry is the parser's, not this script's** (review F4): the bands, the insets and the label
 * come from OPENER_FIELD_GEOMETRY in src/perception/opener.ts, the same object
 * tests/readers-corpus.test.ts asserts the manifest against. Moving a band in the parser therefore
 * requires a re-record, and the corpus can never be green against a geometry nobody reads.
 *
 * The crops are binary PPM (P6): lossless, the same format the OCR escalation already writes, and
 * Node has no PNG codec (the repo's rule for the map templates). View one with
 * ffmpeg -i card-1-detect-decoded.ppm card-1-detect-decoded.png.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/record-readers-corpus.ts
 *
 * Re-run it only when the fixture or the geometry changes: the crops are the record, not a build
 * artifact. Each corpus is written to a staging directory beside it and moved into place (review F8),
 * so an interrupted run cannot leave a half-deleted corpus behind.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import type { RgbaImage } from '../src/contracts.ts';
import { OPENER_FIELD_GEOMETRY, OPENER_SLOTS } from '../src/perception/opener.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'testdata/chest/2026-10-24-opener/panel-00.jpg';
const MEASUREMENTS = 'testdata/chest/2026-10-24-opener/measurements.json';
const READERS = 'testdata/readers/';

/** The opener's measured field geometry, taken from the parser itself (review F4). */
const GEOMETRY = OPENER_FIELD_GEOMETRY;

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
  readonly willpower: number | null;
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

interface HeartField {
  readonly file: string;
  readonly card: number;
  readonly slot: number;
  readonly form: 'decoded' | 'sharp';
  readonly width: number;
  readonly height: number;
  readonly region: Region;
  readonly expected: number | null;
}

interface RecordedFile {
  readonly name: string;
  readonly bytes: Buffer;
}

interface RecordedCorpus {
  /** The directory under testdata/readers/. */
  readonly directory: string;
  readonly files: ReadonlyArray<RecordedFile>;
  readonly manifest: unknown;
  readonly readme: string;
}

/** The sharpened proxy: the identical arithmetic on the same pixels as the tests' unsharp helper. */
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

/** The pixels of region, cut out of a frame (the crop the reader is handed). */
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
  const header = Buffer.from('P6\n' + image.width + ' ' + image.height + '\n255\n', 'ascii');
  const body = Buffer.alloc(image.width * image.height * 3);
  for (let index = 0; index < image.width * image.height; index += 1) {
    body[index * 3] = image.data[index * 4]!;
    body[index * 3 + 1] = image.data[index * 4 + 1]!;
    body[index * 3 + 2] = image.data[index * 4 + 2]!;
  }
  return Buffer.concat([header, body]);
}

/** The 陷阱 field inside one card: the numeral band and the label handed to a reader as context. */
function trapField(slot: number, field: 'detect' | 'disarm'): { band: Region; label: Region } {
  const { rect } = OPENER_SLOTS[slot]!;
  const band: Region = {
    x: rect.x0 + GEOMETRY.numberLeft,
    y: rect.y0 + GEOMETRY.trap[field],
    width: rect.x1 - GEOMETRY.numberRightInset - (rect.x0 + GEOMETRY.numberLeft),
    height: GEOMETRY.bandHeight,
  };
  const label: Region = {
    x: rect.x0,
    y: band.y - GEOMETRY.labelAbove,
    width: GEOMETRY.numberLeft,
    height: GEOMETRY.labelHeight,
  };
  return { band, label };
}

/**
 * The heart field inside one card: the window the heart matcher reads, widened by the right inset so
 * the crop ends at the card's right border - the column the matcher's right-alignment check measures
 * against.
 */
function heartField(slot: number): Region {
  const { rect } = OPENER_SLOTS[slot]!;
  return {
    x: rect.x1 - GEOMETRY.heartLeft,
    y: rect.y0 + GEOMETRY.heart.top,
    width: GEOMETRY.heartLeft,
    height: GEOMETRY.bandHeight,
  };
}

/**
 * Write one corpus atomically (review F8): stage every file beside the target, then swap the directory
 * into place. A run that dies half way leaves the committed corpus untouched instead of deleting its
 * crops first and then failing, and a reader never observes a directory with some of the old crops and
 * some of the new.
 */
function writeCorpus(corpus: RecordedCorpus): number {
  const target = ROOT + READERS + corpus.directory;
  const staging = ROOT + READERS + '.recording-' + corpus.directory + '-' + process.pid;
  mkdirSync(ROOT + READERS, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const file of corpus.files) writeFileSync(join(staging, file.name), file.bytes);
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(corpus.manifest, null, 2) + '\n');
    writeFileSync(join(staging, 'README.md'), corpus.readme);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return corpus.files.reduce((sum, file) => sum + file.bytes.length, 0);
}

const decoded = jpeg.decode(readFileSync(ROOT + FIXTURE), { useTArray: true });
const panel: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
const sharp = sharpened(panel, 1);
const members = (JSON.parse(readFileSync(ROOT + MEASUREMENTS, 'utf8')) as { members: MeasuredMember[] }).members;
const sources = { decoded: panel, sharp } as const;
const FORMS = ['decoded', 'sharp'] as const;

// ---------------------------------------------------------------------------------------------
// trap-numbers: the numeral band union its label, both forms
// ---------------------------------------------------------------------------------------------

const trapFiles: RecordedFile[] = [];
const trapFields: CorpusField[] = [];
for (const { index: slot } of OPENER_SLOTS) {
  for (const field of ['detect', 'disarm'] as const) {
    const { band, label } = trapField(slot, field);
    // The read covers region union label: the numeral band and the CJK label the OCR tier needs as
    // context (a context-free band reads nothing, measured 2026-11-07).
    const x = Math.min(band.x, label.x);
    const y = Math.min(band.y, label.y);
    const width = Math.max(band.x + band.width, label.x + label.width) - x;
    const height = Math.max(band.y + band.height, label.y + label.height) - y;
    const union: Region = { x, y, width, height };
    for (const form of FORMS) {
      const file = 'card-' + (slot + 1) + '-' + field + '-' + form + '.ppm';
      trapFiles.push({ name: file, bytes: ppmOf(crop(sources[form], union)) });
      trapFields.push({
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

const trapManifest = {
  generatedBy: 'scripts/record-readers-corpus.ts',
  source: FIXTURE,
  measurements: MEASUREMENTS,
  note:
    'One committed crop per 陷阱 field (numeral band union label) in both forms: the decoded fixture and '
    + 'the sharpened raw-pixel proxy (img + 1 * (img - 4-neighbour box blur), clamped). The crops are '
    + 'binary PPM (P6), not JPEG: a corpus that re-encodes its own pixels would measure the encoder. '
    + 'The geometry is OPENER_FIELD_GEOMETRY in src/perception/opener.ts; the corpus test asserts this '
    + 'manifest against it.',
  geometry: GEOMETRY,
  sharpened: {
    amount: 1,
    kernel: '4-neighbour box blur, weights centre 2 / each neighbour 1 over 6, img + amount * (img - blur), clamped',
  },
  range: { min: MIN_VALUE, max: MAX_VALUE },
  fields: trapFields,
};

const trapRows = trapFields
  .map((entry) => '| `' + entry.file + '` | ' + entry.card + ' | ' + (entry.field === 'detect' ? '陷阱发现' : '陷阱解除')
    + ' | ' + entry.form + ' | ' + entry.expected + ' |')
  .join('\n');

const trapReadme = '# The 陷阱 numerals corpus (2026-11-07)\n\n'
  + 'Recorded by `scripts/record-readers-corpus.ts` from\n'
  + '`testdata/chest/2026-10-24-opener/panel-00.jpg` (the 由谁打开? opener panel); the expected values\n'
  + 'are that fixture\'s `measurements.json`. There are twelve 陷阱 fields - six cards x 陷阱发现 /\n'
  + '陷阱解除 - and each is committed in **both** forms, so 24 crops.\n\n'
  + '## What each crop is\n\n'
  + 'Each crop is the exact rectangle the opener hands its reader: the numeral band union its label. The\n'
  + 'label is the OCR tier\'s context - a context-free 87 x 16 band of this panel reads nothing while the\n'
  + 'crop that carries 陷阱发现 reads `陷阱发现38` (measured 2026-11-07) - and the fast tiers ignore it\n'
  + 'except for the containment check.\n\n'
  + 'The crop geometry is not written here by hand: `OPENER_FIELD_GEOMETRY` in\n'
  + '`src/perception/opener.ts` is the parser\'s own, and `tests/readers-corpus.test.ts` asserts this\n'
  + 'manifest against it (review F4). A band that moves in the parser makes the corpus red until it is\n'
  + 're-recorded.\n\n'
  + '- `*-decoded.ppm` - the fixture as `panel-00.jpg` decodes. This is the form the fast tiers answer.\n'
  + '- `*-sharp.ppm` - the **sharpened proxy**: `img + amount * (img - boxBlur)`, a 4-neighbour box blur,\n'
  + '  amount 1, clamped. It is the unsharp helper the tests use and the raw-capture stand-in plan ruling\n'
  + '  R3 keeps until the game is launched: sharpening the decoded pixels moves them off the digit atlases\n'
  + '  the same way a raw capture does.\n\n'
  + 'The crops are binary PPM (P6: header `P6\\n<width> <height>\\n255\\n` then RGB), not JPEG - a\n'
  + 'corpus that re-encodes its own pixels would measure the encoder. Node has no PNG codec here; view one\n'
  + 'with `ffmpeg -i card-1-detect-decoded.ppm card-1-detect-decoded.png`.\n\n'
  + '## The expected values\n\n'
  + '| crop | card | field | form | expected |\n'
  + '| --- | --- | --- | --- | --- |\n'
  + trapRows + '\n\n'
  + '`manifest.json` is the machine-readable record: each crop\'s card slot, field, form, size, the\n'
  + 'reader region and hint label inside the crop, and the expected value. The plausible range is\n'
  + '**1-999** - a 陷阱 bonus is a positive number of at most three digits (the widest numeral field the\n'
  + 'seam names) - and no tier may answer outside it.\n\n'
  + '## How it is used\n\n'
  + '`tests/readers-corpus.test.ts` runs the rule, template and OCR tiers over every crop: the\n'
  + 'template tier reads the decoded values, the OCR tier (when this host has its runtime) reads both\n'
  + 'forms, and each tier\'s measured defeats are **recorded** rather than hidden. The rule tier\'s known\n'
  + '4-vs-3 misname (board card `t-mw65nlh4-lfoik7`) and its other misreads on this font are pinned\n'
  + 'beside the measured values, and so are the OCR tier\'s two box-split refusals and its 77-as-177\n'
  + 'misread on the sharpened crops. A fix turns the test red on purpose; the corpus is then re-recorded.\n\n'
  + 'Do not edit a crop or the manifest by hand: re-run the script.\n';

// ---------------------------------------------------------------------------------------------
// heart: the window the heart matcher reads, both forms
// ---------------------------------------------------------------------------------------------

const heartFiles: RecordedFile[] = [];
const heartFields: HeartField[] = [];
for (const { index: slot } of OPENER_SLOTS) {
  const source = heartField(slot);
  const region: Region = { x: 0, y: 0, width: source.width, height: source.height };
  for (const form of FORMS) {
    const file = 'card-' + (slot + 1) + '-heart-' + form + '.ppm';
    heartFiles.push({ name: file, bytes: ppmOf(crop(sources[form], source)) });
    heartFields.push({
      file,
      card: slot + 1,
      slot,
      form,
      width: region.width,
      height: region.height,
      region,
      expected: members[slot]!.willpower,
    });
  }
}

const heartManifest = {
  generatedBy: 'scripts/record-readers-corpus.ts',
  source: FIXTURE,
  measurements: MEASUREMENTS,
  note:
    'One committed crop per card\'s heart window (the card\'s right OPENER_FIELD_GEOMETRY.heartLeft px, '
    + 'bandHeight rows, ending at the card\'s right border) in both forms: the decoded fixture and the '
    + 'sharpened raw-pixel proxy. Card 4 draws no heart; its window is committed too, so the absence is '
    + 'proved by the matcher rather than asserted from the measurement file. expected is the '
    + 'measurements.json willpower column: null = no heart drawn.',
  geometry: { heartLeft: GEOMETRY.heartLeft, bandHeight: GEOMETRY.bandHeight, rightInset: GEOMETRY.numberRightInset },
  sharpened: {
    amount: 1,
    kernel: '4-neighbour box blur, weights centre 2 / each neighbour 1 over 6, img + amount * (img - blur), clamped',
  },
  fields: heartFields,
};

const heartRows = heartFields
  .map((entry) => '| `' + entry.file + '` | ' + entry.card + ' | ' + entry.form + ' | '
    + (entry.expected === null ? 'absent' : entry.expected) + ' |')
  .join('\n');

const heartReadme = '# The heart numerals corpus (2026-11-07)\n\n'
  + 'Recorded by `scripts/record-readers-corpus.ts` from the same opener fixture as the 陷阱 corpus,\n'
  + '`testdata/chest/2026-10-24-opener/panel-00.jpg`. The heart field is the second numeric field of\n'
  + 'the panel (the reader\'s spec says each numeric field, so it is on the record even though R5 keeps\n'
  + 'it on its own matcher).\n\n'
  + '## What each crop is\n\n'
  + 'The card\'s right `heartLeft` px (70) at the heart band\'s rows (1..16 below the card\'s top border),\n'
  + 'i.e. the parser\'s heart window plus the three columns of the right inset, so the crop ends at the\n'
  + 'card\'s right border - the column the matcher\'s right-alignment check measures against. Every card\n'
  + 'is committed, including card 4, which draws no heart: its empty window is how `absent` is proved.\n\n'
  + 'Both forms are the same pair as the 陷阱 corpus: `*-decoded.ppm` is the fixture as it decodes, and\n'
  + '`*-sharp.ppm` is the sharpened raw-pixel proxy (R3).\n\n'
  + '## What it measured (2026-11-07)\n\n'
  + 'The committed crops, read by the opener\'s own heart matcher (`readHeartCrop` in\n'
  + '`src/perception/opener.ts` - the same function the panel uses, not a copy):\n\n'
  + '- decoded: 100, 100, 100, absent (card 4), 90, 100 - every drawn numeral reads;\n'
  + '- sharpened proxy: 100, unreadable (the second card), 100, absent (card 4), 90, 100 - that\n'
  + '  card\'s 100 (it is a 100) falls to 0.871 against the 0.95 identity floor.\n\n'
  + 'That is R5\'s stated second clause, recorded - with one correction: R5\'s prose says "card 1", and\n'
  + 'the refused numeral is the **second** card (index 1). The value and the score are R5\'s numbers;\n'
  + 'the attribution is this corpus\'s, measured (review F5). R5\'s "3 of 5 hearts refuse" is the\n'
  + '**template tier\'s** answer on a numeral-tight crop, not this matcher\'s on the field window, so the\n'
  + 'record and the ruling do not conflict: the heart stays on its matcher (R5), and its values are\n'
  + 'pinned here.\n\n'
  + 'answer on a numeral-tight crop, not this matcher\'s on the field window, so the record and the ruling\n'
  + 'do not conflict: the heart stays on its matcher (R5), and its values are pinned here.\n\n'
  + '## The expected values\n\n'
  + '| crop | card | form | expected |\n'
  + '| --- | --- | --- | --- |\n'
  + heartRows + '\n\n'
  + 'The values are what the matcher returns on the committed crop, not a guess: `tests/readers-corpus.test.ts`\n'
  + 'runs `readHeartCrop` over every one and pins the list above by card. A different answer is a\n'
  + 'deliberate re-record.\n\n'
  + 'Do not edit a crop or the manifest by hand: re-run the script.\n';

// ---------------------------------------------------------------------------------------------
// Write both corpora, atomically
// ---------------------------------------------------------------------------------------------

const trapBytes = writeCorpus({
  directory: 'trap-numbers',
  files: trapFiles,
  manifest: trapManifest,
  readme: trapReadme,
});
const heartBytes = writeCorpus({
  directory: 'heart',
  files: heartFiles,
  manifest: heartManifest,
  readme: heartReadme,
});

console.log(JSON.stringify({
  trap: { recorded: trapFields.length, files: trapFiles.map((file) => file.name), bytes: trapBytes },
  heart: { recorded: heartFields.length, files: heartFiles.map((file) => file.name), bytes: heartBytes },
}));
