/**
 * The numerals regression corpus (readers plan, Task 5; spec "Durability").
 *
 * `testdata/readers/trap-numbers/` holds the twelve 陷阱 fields of the opener fixture `panel-00.jpg`
 * — six cards × 陷阱发现 / 陷阱解除 — as the exact crop the opener hands its reader (the numeral band
 * ∪ its label), in **both** forms: the decoded fixture's crop and the sharpened proxy's crop
 * (`img + amount·(img − boxBlur)`, amount 1; plan ruling R3 — the raw-capture stand-in until the
 * game is launched). This file runs **every tier over every crop**:
 *
 * 1. the **template tier** reads all twelve decoded crops' measured values — the form the fast loop
 *    answers — and on the sharpened proxy either names the measured value or refuses, never a
 *    different number;
 * 2. the **OCR tier**, when this host has its runtime, runs both forms against the measured values:
 *    the raw-form proof the live failure needed (a context-free band reads nothing; the crop carries
 *    its label as the tier's context). Its two box-split refusals and its 77-as-177 misread on the
 *    sharpened proxy are **recorded** below, not hidden;
 * 3. the **rule tier**'s known 4-vs-3 misname is **recorded**, not hidden: `number.ts` names this
 *    font's 4 as a 3 (board card `t-mw65nlh4-lfoik7`), and the pinned answers below are that defect —
 *    fixing it turns this file red on purpose, and it is then re-recorded from the fixed reader. The
 *    corpus also measured the tier's other defeats on this font (2 as 3, 7 as 3, 0 as 4, 6 as 5) and
 *    its refusals; they are pinned beside it, not hidden, because the corpus runs every tier over
 *    every crop;
 * 4. no tier ever answers a number outside the field's plausible range (1–999): a value the field
 *    cannot carry is a refusal, never an answer.
 *
 * A capture-pipeline change breaks a test here instead of a night run. The corpus is recorded by
 * `scripts/record-readers-corpus.ts`; its README and manifest state each crop and its expected
 * value. Do not edit a crop by hand.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { TRAP_DIGIT_TEMPLATES } from '../src/perception/opener.ts';
import type { Numerals, NumeralsReader, Region } from '../src/perception/readers/contract.ts';
import { ocrReader } from '../src/perception/readers/ocr.ts';
import { ruleReader } from '../src/perception/readers/rule.ts';
import { createTemplateReader } from '../src/perception/readers/template.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS = new URL('../testdata/readers/trap-numbers/', import.meta.url);
const MANIFEST = new URL('manifest.json', CORPUS);
const MEASUREMENTS = new URL('../testdata/chest/2026-10-24-opener/measurements.json', import.meta.url);

/** The operator's venv and the readout script; env wins, the repo-local pair is the fallback. */
const PYTHON = process.env.WVD_OCR_PYTHON || join(ROOT, '.tmp', 'ocr-venv', 'Scripts', 'python.exe');
const SCRIPT = process.env.WVD_OCR_SCRIPT || join(ROOT, 'scripts', 'ocr-readout.py');
/** Is there a runtime to measure? Gates the OCR half, so a host without it skips and does not fail. */
const OCR_AVAILABLE = existsSync(PYTHON) && existsSync(SCRIPT);

/** One crop: the field it carries, the reader's region and the hint's label inside it. */
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

interface Manifest {
  readonly source: string;
  readonly sharpened: { readonly amount: number };
  readonly range: { readonly min: number; readonly max: number };
  readonly fields: readonly CorpusField[];
}

interface MeasuredMember {
  readonly name: string;
  readonly detect: number;
  readonly disarm: number;
}

let loaded: Promise<Manifest> | null = null;
function manifest(): Promise<Manifest> {
  loaded ??= readFile(MANIFEST, 'utf8').then((text) => JSON.parse(text) as Manifest);
  return loaded;
}

/** The crops decoded once each: a PPM is small, but a test file runs every tier over all of them. */
const imageCache = new Map<string, Promise<RgbaImage>>();

function cropImage(entry: CorpusField): Promise<RgbaImage> {
  let image = imageCache.get(entry.file);
  if (!image) {
    image = readFile(new URL(entry.file, CORPUS)).then((bytes) => decodePpm(bytes, entry.file));
    imageCache.set(entry.file, image);
  }
  return image;
}

/**
 * One binary PPM (P6) as an image. The corpus is PPM, not JPEG, on purpose: a corpus that re-encodes
 * its own pixels would measure the encoder, and Node has no PNG codec here.
 */
function decodePpm(bytes: Buffer, name: string): RgbaImage {
  const text = (from: number, to: number): string => bytes.subarray(from, to).toString('latin1');
  if (text(0, 2) !== 'P6') throw new Error(name + ': not a binary PPM');
  let index = 2;
  const token = (): number => {
    while (index < bytes.length && /\s/.test(String.fromCharCode(bytes[index]!))) index += 1;
    const start = index;
    while (index < bytes.length && !/\s/.test(String.fromCharCode(bytes[index]!))) index += 1;
    return Number(text(start, index));
  };
  const width = token();
  const height = token();
  const max = token();
  index += 1; // the one whitespace byte between the max value and the pixels
  if (max !== 255) throw new Error(name + ': max value ' + max + ', not 255');
  if (bytes.length - index !== width * height * 3) {
    throw new Error(name + ': ' + (bytes.length - index) + ' pixel bytes for a ' + width + ' x ' + height + ' crop');
  }
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = bytes[index + pixel * 3]!;
    data[pixel * 4 + 1] = bytes[index + pixel * 3 + 1]!;
    data[pixel * 4 + 2] = bytes[index + pixel * 3 + 2]!;
    data[pixel * 4 + 3] = 255;
  }
  return { data, width, height };
}

/** The template tier exactly as the opener builds it (R4: the atlas is handed in, the reader built here). */
const templateReader: NumeralsReader = createTemplateReader({
  templates: TRAP_DIGIT_TEMPLATES,
  matchFloor: 0.7,
  marginFloor: 0.1,
});

/**
 * The rule tier's answers over the corpus that are **not** the measured value, and its refusals:
 * recorded from the reader on 2026-11-07, not expected of it. The known 4-vs-3 misname
 * (board card `t-mw65nlh4-lfoik7` — the opener font draws its 4 like a 3) is the first row; the
 * corpus also measured the tier's other defeats on this font (2 as 3, 7 as 3, 0 as 4, and 6 as 5 on
 * the proxy) and four refusals, and they are pinned here because the corpus runs every tier over
 * every crop. The template tier reads the same crops' measured values (proved below), so these are
 * the rule tier's defeats, not the corpus's.
 */
const RULE_MISREADS: ReadonlyMap<string, number> = new Map([
  // The known 4-vs-3 (board card t-mw65nlh4-lfoik7): this font's 4 is a 3 to number.ts.
  ['card-1-disarm-decoded.ppm', 39],
  // The rest of the tier's measured defeats on this font, recorded rather than hidden: a 2 named 3,
  // a 7 named 3, a 0 named 4 — and on the sharpened proxy a 6 named 5. None is the corpus's doing:
  // the template tier reads every one of these crops' measured values (proved above).
  ['card-2-detect-decoded.ppm', 38],
  ['card-2-detect-sharp.ppm', 38],
  ['card-2-disarm-decoded.ppm', 54],
  ['card-4-detect-decoded.ppm', 93],
  ['card-4-detect-sharp.ppm', 93],
  ['card-5-detect-decoded.ppm', 63],
  ['card-5-detect-sharp.ppm', 53],
  ['card-6-detect-sharp.ppm', 33],
  ['card-6-disarm-decoded.ppm', 39],
  ['card-6-disarm-sharp.ppm', 39],
]);

/** The rule tier's refusals over the corpus (measured 2026-11-07): recorded, like the misreads. */
const RULE_REFUSALS: ReadonlySet<string> = new Set([
  'card-2-disarm-sharp.ppm',
  'card-4-disarm-decoded.ppm',
  'card-4-disarm-sharp.ppm',
  'card-6-detect-decoded.ppm',
]);

const MIN_VALUE = 1;
const MAX_VALUE = 999;

/** A read that is not `null` must be a number the field can carry. */
function plausible(read: Numerals | null, where: string): void {
  if (read === null) return;
  const why = where + ' answered ' + read.value + ', outside the plausible ' + MIN_VALUE + '-' + MAX_VALUE;
  expect(read.value, why).toBeGreaterThanOrEqual(MIN_VALUE);
  expect(read.value, why).toBeLessThanOrEqual(MAX_VALUE);
}

const hintOf = (entry: CorpusField): { label: Region } => ({ label: entry.label });

// ---------------------------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------------------------

describe('the numerals corpus', () => {
  it("commits the fixture's twelve 陷阱 fields in both forms, with its measured values", async () => {
    const corpus = await manifest();
    const measured = (JSON.parse(await readFile(MEASUREMENTS, 'utf8')) as { members: MeasuredMember[] }).members;

    expect(corpus.source).toBe('testdata/chest/2026-10-24-opener/panel-00.jpg');
    expect(corpus.sharpened.amount).toBe(1);
    expect(corpus.range).toEqual({ min: MIN_VALUE, max: MAX_VALUE });
    expect(corpus.fields).toHaveLength(24);
    expect(new Set(corpus.fields.map((entry) => entry.file)).size).toBe(24);

    for (const slot of [0, 1, 2, 3, 4, 5]) {
      for (const field of ['detect', 'disarm'] as const) {
        for (const form of ['decoded', 'sharp'] as const) {
          const entry = corpus.fields.find(
            (candidate) => candidate.slot === slot && candidate.field === field && candidate.form === form,
          );
          expect(entry, 'card ' + (slot + 1) + ' ' + field + ' ' + form).toBeDefined();
          expect(entry!.expected).toBe(measured[slot]![field]);
          expect(entry!.card).toBe(slot + 1);
          const image = await cropImage(entry!);
          expect([image.width, image.height], entry!.file).toEqual([entry!.width, entry!.height]);
          // The reader region and the hint's label must sit inside the crop they are recorded in.
          for (const region of [entry!.region, entry!.label]) {
            expect(region.x).toBeGreaterThanOrEqual(0);
            expect(region.y).toBeGreaterThanOrEqual(0);
            expect(region.x + region.width).toBeLessThanOrEqual(image.width);
            expect(region.y + region.height).toBeLessThanOrEqual(image.height);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The template tier: the fast loop's reader, on the form it answers
// ---------------------------------------------------------------------------------------------

/**
 * The template tier refuses exactly one of the twelve sharpened proxy crops: card 1's 陷阱解除 (49),
 * the one field the live panel escalated (`readers-opener.test.ts`). Pinned **by field name**, not as
 * a count: a tier that starts answering that crop or refusing a different one is a re-record, and a
 * count cannot tell a swap from a steady eleven.
 */
const TEMPLATE_PROXY_REFUSALS: ReadonlySet<string> = new Set(['card-1-disarm-sharp.ppm']);

describe('the template tier over the corpus', () => {
  it('reads every decoded crop as the measured value', async () => {
    const corpus = await manifest();
    for (const entry of corpus.fields.filter((candidate) => candidate.form === 'decoded')) {
      const read = await templateReader.read(await cropImage(entry), entry.region, hintOf(entry));
      expect(read, entry.file).not.toBeNull();
      expect(read!.value, entry.file).toBe(entry.expected);
      expect(read!.tier, entry.file).toBe('template');
      plausible(read, 'the template tier on ' + entry.file);
    }
  });

  it('names the measured value or refuses on the sharpened proxy — never a different number', async () => {
    // The proxy is the raw capture's stand-in (R3): the atlas may stop matching it (that is the live
    // failure), but a fall-through is a refusal, never a plausible-looking wrong number.
    const corpus = await manifest();
    const sharp = corpus.fields.filter((candidate) => candidate.form === 'sharp');
    const answered: string[] = [];
    for (const entry of sharp) {
      const read = await templateReader.read(await cropImage(entry), entry.region, hintOf(entry));
      plausible(read, 'the template tier on ' + entry.file);
      if (read === null) {
        expect(TEMPLATE_PROXY_REFUSALS.has(entry.file), entry.file + ' refused; record it in TEMPLATE_PROXY_REFUSALS').toBe(true);
        continue;
      }
      answered.push(entry.file);
      expect(read.value, entry.file).toBe(entry.expected);
      expect(read.tier, entry.file).toBe('template');
    }
    // Both directions are pinned **by field name**: exactly one proxy crop is the refusal, and every
    // other proxy crop is an answer. A swap — card 1's 49 starting to answer while another crop starts
    // refusing — was invisible to an `answers === 11` count; it fails here, because the answered set
    // would name a crop the refusal set does not, and vice versa.
    const expectedAnswers = sharp.map((entry) => entry.file)
      .filter((file) => !TEMPLATE_PROXY_REFUSALS.has(file));
    expect(answered).toEqual(expectedAnswers);
  });
});
// ---------------------------------------------------------------------------------------------
// The rule tier: its defect is recorded, not hidden
// ---------------------------------------------------------------------------------------------

describe('the rule tier over the corpus', () => {
  it('records the known 4-vs-3 misname (board card t-mw65nlh4-lfoik7) — fixing number.ts turns this red', async () => {
    // The pinned answers ARE the defect, a deliberately xfail-shaped record: the opener font's 4 and
    // 3 share a shape and `number.ts` names it 3, so the decoded 49 reads 39. The same run also
    // measured the tier's other defeats on this font (2 as 3, 7 as 3, 0 as 4, and 6 as 5 on the
    // proxy) and four refusals — all pinned above, none hidden. The template tier reads every one of
    // these crops' measured values, and the opener's chain keeps the rule tier out (R4/R9). Every
    // answer, every refusal and the measured value are asserted side by side, so a fix is a
    // deliberate re-record, not a silent pass.
    const corpus = await manifest();
    for (const entry of corpus.fields) {
      const read = await ruleReader.read(await cropImage(entry), entry.region, hintOf(entry));
      plausible(read, 'the rule tier on ' + entry.file);
      if (read === null) {
        expect(RULE_REFUSALS.has(entry.file), entry.file + ' refused; record it in RULE_REFUSALS').toBe(true);
        continue;
      }
      expect(read.tier, entry.file).toBe('rule');
      expect(read.value, entry.file).toBe(RULE_MISREADS.get(entry.file) ?? entry.expected);
    }
    // The board-pinned misname, side by side with the screen: the decoded card 1's 陷阱解除 is 49 and
    // this tier names it 39. The sharpened crop of the same field names 49 correctly, which is why
    // the whole table is pinned — the defect is glyph- and form-specific.
    expect(corpus.fields.find((entry) => entry.file === 'card-1-disarm-decoded.ppm')!.expected).toBe(49);
    expect(RULE_MISREADS.get('card-1-disarm-decoded.ppm')).toBe(39);
  });
});

// ---------------------------------------------------------------------------------------------
// The OCR tier: both forms, when this host has the runtime
// ---------------------------------------------------------------------------------------------

/**
 * The OCR tier's measured defeats over the corpus (2026-11-07, this host's RapidOCR), recorded
 * rather than hidden — the corpus exposed them; fixing the reader is a different task.
 *
 * - **Two refusals**, both an answer the tier splits into two boxes: `["陷阱解除1", "105"]` on the
 *   decoded card 4's 陷阱解除 and `["陷阱发现9", "92"]` on its sharpened 陷阱发现. `numeralOf` refuses
 *   two runs on purpose (an ambiguous answer is not a concatenation), so the field is unread.
 * - **One misread**: the sharpened card 6's 陷阱发现 77 comes back `["陷阱发现", "177"]` and is named
 *   177 — inside the plausible range, so no range check can catch it; only the per-field pin can.
 */
const OCR_REFUSALS: ReadonlySet<string> = new Set([
  'card-4-disarm-decoded.ppm',
  'card-4-detect-sharp.ppm',
]);

const OCR_MISREADS: ReadonlyMap<string, number> = new Map([
  ['card-6-detect-sharp.ppm', 177],
]);

describe.skipIf(!OCR_AVAILABLE)('the OCR tier over the corpus', () => {
  beforeEach(() => {
    vi.stubEnv('WVD_OCR_PYTHON', PYTHON);
    vi.stubEnv('WVD_OCR_SCRIPT', SCRIPT);
    // R7's bound is the test's to set: the committed default (8 s) is a production bound and this
    // host's OCR needs the wider one under the suite's real reads. Stubbed here, so `pnpm test`
    // (plain vitest) is green with no hand-set environment.
    vi.stubEnv('WVD_OCR_TIMEOUT_MS', '20000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function readForm(form: 'decoded' | 'sharp'): Promise<void> {
    const corpus = await manifest();
    const crops = corpus.fields.filter((candidate) => candidate.form === form);
    const answered: string[] = [];
    for (const entry of crops) {
      const read = await ocrReader.read(await cropImage(entry), entry.region, hintOf(entry));
      plausible(read, 'the OCR tier on ' + entry.file);
      if (read === null) {
        expect(OCR_REFUSALS.has(entry.file), entry.file + ' refused; record it in OCR_REFUSALS').toBe(true);
        continue;
      }
      answered.push(entry.file);
      expect(read.tier, entry.file).toBe('ocr');
      expect(read.value, entry.file).toBe(OCR_MISREADS.get(entry.file) ?? entry.expected);
    }
    // The same both-directions pin as the template tier: the refusals and the answers are each named,
    // so a crop that starts answering or starts refusing is a re-record, never a silent pass.
    const expectedAnswers = crops.map((entry) => entry.file)
      .filter((file) => !OCR_REFUSALS.has(file));
    expect(answered).toEqual(expectedAnswers);
  }

  it('runs the decoded form against the measured twelve — one box-split refusal recorded', async () => {
    await readForm('decoded');
  }, 300_000);

  it('runs the sharpened proxy against the measured twelve — one refusal and the 77-as-177 misread recorded', async () => {
    await readForm('sharp');
  }, 300_000);
});