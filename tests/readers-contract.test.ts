/**
 * The numerals-reader seam's fast tiers and its selector (Task 2).
 *
 * The rule tier reads the **shape** of a numeral (`number.ts`) out of the pixels; the template tier
 * matches the same glyph geometry against an atlas the caller hands in (R1: the opener is not
 * imported, its atlases are), and `auto` orders the tiers and reports **which one answered**.
 *
 * The selector is exercised with fake tiers, so it needs no OCR runtime: a `fast` read must never
 * spawn one, and an `ocr` read must never touch the fast tiers. What is proved here is the seam's
 * behaviour; the real atlases are proved by the opener's own tests (Task 3).
 *
 * The template tier is probed two ways: an atlas recorded from the very frame it reads (a 1.0
 * self-match, enough for the digit and the floor), and an **observed-instance** atlas — two captures
 * of one digit plus a near-tie rival — read from a third, unseen capture. The second is what
 * exercises the per-digit grouping and the runner-up margin.
 *
 * The synthetic strips are drawn at the game's glyph scale (12 px tall, 2 px strokes, 3–4 px gaps)
 * because both fast tiers were measured on that scale: three columns is the narrowest digit and
 * twelve the widest (opener's `MIN_GLYPH_COLUMNS` / `MAX_GLYPH_COLUMNS`).
 */
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import type { Numerals, NumeralsReader, Region } from '../src/perception/readers/contract.ts';
import { createAutoReader } from '../src/perception/readers/auto.ts';
import { createNumeralsReader } from '../src/perception/readers/index.ts';
import { ruleReader } from '../src/perception/readers/rule.ts';
import {
  createTemplateReader,
  templateFeatureOf,
  TEMPLATE_MARGIN_FLOOR,
  TEMPLATE_MATCH_FLOOR,
  type DigitTemplate,
} from '../src/perception/readers/template.ts';

/*
 * ---------------------------------------------------------------------------------------------
 * A synthetic frame: one luma value for the fill, one for the numeral ink, no anti-aliasing.
 * ---------------------------------------------------------------------------------------------
 */
const FILL_LUMA = 20;
const INK_LUMA = 220;

type Bitmap = readonly string[];

/** A frame of uniform fill, opaque. */
function blank(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(FILL_LUMA);
  for (let index = 0; index < width * height; index += 1) data[index * 4 + 3] = 255;
  return { data, width, height };
}

/** Paint a bitmap's '#' cells as ink at (atX, atY); '.' cells are left alone. */
function stamp(image: RgbaImage, rows: Bitmap, atX: number, atY: number): void {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== '#') continue;
      const offset = ((atY + y) * image.width + atX + x) * 4;
      image.data[offset] = INK_LUMA;
      image.data[offset + 1] = INK_LUMA;
      image.data[offset + 2] = INK_LUMA;
      image.data[offset + 3] = 255;
    }
  });
}

/**
 * A `1` the rules can name: a three-column stem with a flag, so the glyph's box is not solid (a
 * full box is `number.ts`'s "not a glyph" refusal). Bounding box 3 x 12, no counter.
 */
const ONE: Bitmap = [
  '..#.',
  '.##.',
  '###.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
  '.##.',
];

/**
 * A `6` the rules can name: one counter low in the glyph (`holeY >= 0.55`), and the right edge
 * stops short of a stem so the `4`/`9` branches cannot claim it. Bounding box 5 x 12.
 */
const SIX: Bitmap = [
  '.##...',
  '.##...',
  '.##...',
  '.##...',
  '.##...',
  '.###..',
  '.#####',
  '.##..#',
  '.##..#',
  '.##..#',
  '.#####',
  '.###..',
];

/**
 * A second observation of that same `6`: the same bounding box, a slightly different stroke pattern
 * — the observed-instance atlas a field hands in (the heart's), not a mean. On the frame read below
 * its feature is 0.926 against the winning `6`'s 0.974, i.e. **inside** the 0.1 margin floor of the
 * digit it shares: a per-template runner-up would mistake it for a rival.
 */
const SIX_INSTANCE_B: Bitmap = [
  '.##...',
  '.###..',
  '.###..',
  '.##...',
  '.##...',
  '.###..',
  '.#####',
  '.##..#',
  '.##..#',
  '.##..#',
  '.#####',
  '.###..',
];

/**
 * A third observation of that `6`, and the frame the atlas reads: it is **not** one of the atlas's
 * entries, so no score is the 1.0 a self-match would give. Its nearest entry is the `6` at 0.974;
 * the atlas's `8` is the true runner-up at 0.842, a near-tie 0.132 behind — just outside the 0.1
 * floor, so the read is an answer, and a raised floor makes it a refusal.
 */
const SIX_FRAME: Bitmap = [
  '.##...',
  '.##...',
  '.##...',
  '.##...',
  '.##...',
  '.##...',
  '.#####',
  '.##..#',
  '.##..#',
  '.##..#',
  '.#####',
  '.###..',
];

/**
 * The one other digit in that atlas: an `8` with a full second bowl, the shape a `6` is nearest to.
 * It is the near-tie the margin floor exists for.
 */
const EIGHT: Bitmap = [
  '.###..',
  '.##..#',
  '.##..#',
  '.##..#',
  '.#####',
  '.##..#',
  '.##..#',
  '.##..#',
  '.##..#',
  '.##..#',
  '.#####',
  '.###..',
];

/** A solid 6 x 12 box: `number.ts` refuses a full glyph ("total >= width * height * 0.9"). */
const BLOCK: Bitmap = Array.from({ length: 12 }, () => '######');

/** A 12 x 2 bar: shorter than the six rows `number.ts` needs, and unlike any template. */
const BAR: Bitmap = ['############', '############'];

/**
 * The opener font's weak `4` as `number.ts` names it: two right bowls, no hole, a bottom bar — its
 * own `3`. The measured opener `4` is this shape (Task 2 report: the rule reads `49` as `39`), and
 * an atlas recorded from the same glyph calls it `4`, so the two fast tiers disagree on one frame.
 */
const RULE_THREE: Bitmap = [
  '#######',
  '.....#.',
  '.....#.',
  '.....#.',
  '..####.',
  '.....#.',
  '.....#.',
  '.....#.',
  '.....#.',
  '.....#.',
  '.....#.',
  '#######',
];

/** The read's rectangle: the same box for every synthetic frame (a 20 x 16 frame's left 16 px). */
const REGION: Region = { x: 0, y: 0, width: 16, height: 16 };

const STRIP = blank(20, 16);
stamp(STRIP, ONE, 2, 2);
stamp(STRIP, SIX, 8, 2);

const BLOCK_IMAGE = blank(20, 16);
stamp(BLOCK_IMAGE, BLOCK, 4, 2);

const BAR_IMAGE = blank(20, 16);
stamp(BAR_IMAGE, BAR, 4, 7);

const ONE_IMAGE = blank(20, 16);
stamp(ONE_IMAGE, ONE, 2, 2);

const SIX_IMAGE = blank(20, 16);
stamp(SIX_IMAGE, SIX, 8, 2);

const SIX_INSTANCE_B_IMAGE = blank(20, 16);
stamp(SIX_INSTANCE_B_IMAGE, SIX_INSTANCE_B, 2, 2);

const SIX_FRAME_IMAGE = blank(20, 16);
stamp(SIX_FRAME_IMAGE, SIX_FRAME, 2, 2);

const EIGHT_IMAGE = blank(20, 16);
stamp(EIGHT_IMAGE, EIGHT, 2, 2);

/** An atlas records a digit by the tier's own feature — the caller's job (R1), not the reader's. */
function templateOf(digit: string, image: RgbaImage): DigitTemplate {
  const values = templateFeatureOf(image, REGION);
  expect(values, 'the synthetic frame must carry exactly one glyph').not.toBeNull();
  return { digit, values: values! };
}

const BLOCK_TEMPLATE = templateOf('8', BLOCK_IMAGE);
const ONE_TEMPLATE = templateOf('1', ONE_IMAGE);
const SIX_TEMPLATE = templateOf('6', SIX_IMAGE);
const STRIP_ATLAS = [ONE_TEMPLATE, SIX_TEMPLATE];
const SIX_INSTANCE_B_TEMPLATE = templateOf('6', SIX_INSTANCE_B_IMAGE);
const EIGHT_TEMPLATE = templateOf('8', EIGHT_IMAGE);

/** The NCC one frame's single glyph scores against one template: the tier's arithmetic, for premises. */
function scoreOf(image: RgbaImage, template: DigitTemplate): number {
  const values = templateFeatureOf(image, REGION);
  expect(values, 'the synthetic frame must carry exactly one glyph').not.toBeNull();
  let score = 0;
  for (let index = 0; index < values!.length; index += 1) score += values![index]! * template.values[index]!;
  return score;
}

const RULE_THREE_IMAGE = blank(20, 16);
stamp(RULE_THREE_IMAGE, RULE_THREE, 2, 2);

/** The same shape, recorded by the caller as the `4` it is — the rule tier's known misread. */
const THREE_AS_FOUR = templateOf('4', RULE_THREE_IMAGE);

/*
 * ---------------------------------------------------------------------------------------------
 * Fake tiers for the selector: they prove which tier was asked, without an OCR runtime.
 * ---------------------------------------------------------------------------------------------
 */

/** A tier that must never be called: calling it fails the test, rather than returning a value. */
function failingReader(name: string): NumeralsReader {
  return {
    read: async () => {
      throw new Error(`the ${name} tier must not be asked`);
    },
  };
}

/** A tier that answers a fixed read (`null` when it refuses). */
function fixedReader(read: Numerals | null): NumeralsReader {
  return { read: async () => read };
}

describe('the numerals-reader seam, the rule tier', () => {
  it('reads a plain numeral strip out of the pixels', async () => {
    const read = await ruleReader.read(STRIP, REGION);
    expect(read?.value).toBe(16);
    expect(read?.tier).toBe('rule');
    expect(read!.confidence).toBeGreaterThan(0);
    expect(read!.confidence).toBeLessThanOrEqual(1);
  });

  it('applies the hint: the expected length and the sanity bounds', async () => {
    await expect(ruleReader.read(STRIP, REGION, { digits: 2 })).resolves.not.toBeNull();
    await expect(ruleReader.read(STRIP, REGION, { digits: 1 })).resolves.toBeNull();
    await expect(ruleReader.read(STRIP, REGION, { max: 15 })).resolves.toBeNull();
    await expect(ruleReader.read(STRIP, REGION, { min: 16, max: 16 })).resolves.not.toBeNull();
  });

  it('refuses a flat band, a region outside the frame and a clip through the label', async () => {
    await expect(ruleReader.read(blank(16, 16), { x: 0, y: 0, width: 16, height: 16 })).resolves.toBeNull();
    await expect(ruleReader.read(STRIP, { x: 10, y: 0, width: 20, height: 16 })).resolves.toBeNull();
    await expect(ruleReader.read(STRIP, REGION, { label: { x: -4, y: 0, width: 10, height: 10 } })).resolves.toBeNull();
  });
});

describe('the numerals-reader seam, the template tier', () => {
  it('names a shape the rule cannot, when its atlas carries it', async () => {
    // The premise: the box is a full glyph, which `number.ts` refuses by design.
    await expect(ruleReader.read(BLOCK_IMAGE, REGION)).resolves.toBeNull();
    const read = await createTemplateReader({ templates: [BLOCK_TEMPLATE] }).read(BLOCK_IMAGE, REGION);
    expect(read?.value).toBe(8);
    expect(read?.tier).toBe('template');
    expect(read!.confidence).toBeGreaterThan(0.99);
  });

  it('refuses a glyph below its match floor, and an atlas with no templates', async () => {
    await expect(createTemplateReader({ templates: STRIP_ATLAS }).read(BAR_IMAGE, REGION)).resolves.toBeNull();
    await expect(createTemplateReader({ templates: [] }).read(BLOCK_IMAGE, REGION)).resolves.toBeNull();
  });

  it('rejects an atlas whose feature is not the tier geometry', () => {
    expect(() => createTemplateReader({ templates: [{ digit: '8', values: new Float64Array(12) }] }))
      .toThrow(TypeError);
  });
});

describe('the numerals-reader seam, the atlas instances and the runner-up margin', () => {
  /*
   * An observed-instance atlas: two captures of its `6` and one `8`. The frame is a third capture of
   * the `6`, so it is not a self-match, and the two entries that are not the answer sit on opposite
   * sides of the 0.1 margin floor — the second `6` is 0.049 behind (inside it) and the `8` is 0.132
   * behind (outside it). The grouping has to ignore the instance and measure the `8`; the margin has
   * to be able to refuse a near-tie.
   */
  const INSTANCE_ATLAS: DigitTemplate[] = [SIX_TEMPLATE, SIX_INSTANCE_B_TEMPLATE, EIGHT_TEMPLATE];

  it('groups a digit\'s instances before the runner-up margin, and still refuses a near-tie', async () => {
    const best = scoreOf(SIX_FRAME_IMAGE, SIX_TEMPLATE);
    const instance = scoreOf(SIX_FRAME_IMAGE, SIX_INSTANCE_B_TEMPLATE);
    const other = scoreOf(SIX_FRAME_IMAGE, EIGHT_TEMPLATE);
    // The premise: a third observation (no self-match), with the second-best entry an instance of the
    // winning digit and the third the other digit the read is a near-tie against.
    expect(best).toBeGreaterThan(TEMPLATE_MATCH_FLOOR);
    expect(best).toBeGreaterThan(0.95);
    expect(best).toBeLessThan(0.999);
    expect(best - instance).toBeLessThan(TEMPLATE_MARGIN_FLOOR);
    expect(best - other).toBeGreaterThan(TEMPLATE_MARGIN_FLOOR);
    expect(best - other).toBeLessThan(0.2);

    // The grouping: the runner-up is the `8` (0.132 back), not the second `6` (0.049 back). A reader
    // that took the runner-up per template would refuse this read; the frame is well above the match
    // floor, so only the margin can turn it away.
    const read = await createTemplateReader({ templates: INSTANCE_ATLAS }).read(SIX_FRAME_IMAGE, REGION);
    expect(read?.value).toBe(6);
    expect(read?.tier).toBe('template');
    expect(read!.confidence).toBeCloseTo(best, 5);

    // The margin: the same frame under a floor above its grouped margin is a refusal. A reader that
    // dropped the margin check would answer `6` here.
    const strict = createTemplateReader({ templates: INSTANCE_ATLAS, marginFloor: 0.25 });
    await expect(strict.read(SIX_FRAME_IMAGE, REGION)).resolves.toBeNull();
  });
});

describe('the numerals-reader seam, the selector', () => {
  it('answers from the rule tier when the region is a plain numeral strip', async () => {
    const reader = createAutoReader({
      // A template tier that could answer too: the rule tier has to answer first.
      template: createTemplateReader({ templates: STRIP_ATLAS }),
      ocr: failingReader('ocr'),
    });
    const read = await reader.read(STRIP, REGION);
    expect(read?.value).toBe(16);
    expect(read?.tier).toBe('rule');
  });

  it('falls to the template tier when the rule refuses a shape the atlas carries', async () => {
    const reader = createAutoReader({
      template: createTemplateReader({ templates: [BLOCK_TEMPLATE] }),
      ocr: failingReader('ocr'),
    });
    const read = await reader.read(BLOCK_IMAGE, REGION);
    expect(read?.value).toBe(8);
    expect(read?.tier).toBe('template');
  });

  it('falls to OCR when both fast tiers refuse the glyph', async () => {
    // The premise is the refusals, not just the OCR answer.
    await expect(ruleReader.read(BAR_IMAGE, REGION)).resolves.toBeNull();
    await expect(createTemplateReader({ templates: STRIP_ATLAS }).read(BAR_IMAGE, REGION)).resolves.toBeNull();
    const reader = createAutoReader({
      template: createTemplateReader({ templates: STRIP_ATLAS }),
      ocr: fixedReader({ value: 5, confidence: 0.9, tier: 'ocr' }),
    });
    const read = await reader.read(BAR_IMAGE, REGION);
    expect(read).toEqual({ value: 5, confidence: 0.9, tier: 'ocr' });
  });

  it('fast never calls the OCR tier', async () => {
    const fast = createAutoReader({ strategy: 'fast', ocr: failingReader('ocr') });
    const read = await fast.read(STRIP, REGION);
    expect(read?.tier).toBe('rule');
    // Both fast tiers refuse: the read is a refusal, not an escalation.
    await expect(fast.read(BAR_IMAGE, REGION)).resolves.toBeNull();
  });

  it('fast never calls the OCR tier with a template atlas in the chain', async () => {
    // The atlas makes the chain rule -> template; a mutant chain that kept OCR (rule -> template ->
    // ocr) would call this throwing fake on a frame both fast tiers refuse.
    const fast = createAutoReader({
      strategy: 'fast',
      template: createTemplateReader({ templates: STRIP_ATLAS }),
      ocr: failingReader('ocr'),
    });
    // The premise: both fast tiers refuse the bar, so only OCR could answer it.
    await expect(ruleReader.read(BAR_IMAGE, REGION)).resolves.toBeNull();
    await expect(createTemplateReader({ templates: STRIP_ATLAS }).read(BAR_IMAGE, REGION)).resolves.toBeNull();
    await expect(fast.read(BAR_IMAGE, REGION)).resolves.toBeNull();
  });

  it('ocr skips the fast tiers', async () => {
    const reader = createAutoReader({
      strategy: 'ocr',
      rule: failingReader('rule'),
      template: failingReader('template'),
      ocr: fixedReader({ value: 38, confidence: 0.9, tier: 'ocr' }),
    });
    expect(await reader.read(STRIP, REGION)).toEqual({ value: 38, confidence: 0.9, tier: 'ocr' });
    // An OCR refusal is the read's refusal; the fast tiers are not tried after it.
    const refusing = createAutoReader({
      strategy: 'ocr',
      rule: failingReader('rule'),
      template: failingReader('template'),
      ocr: fixedReader(null),
    });
    await expect(refusing.read(STRIP, REGION)).resolves.toBeNull();
  });
});

describe('the numerals-reader seam, the template-first strategy (ruling R4)', () => {
  it('answers from the template tier even when the rule would name the glyph differently (the opener 4-as-3 shape)', async () => {
    // The premise: the rule tier's answer here is the wrong digit — `number.ts`'s known weakness.
    const viaRules = await ruleReader.read(RULE_THREE_IMAGE, REGION);
    expect(viaRules?.value).toBe(3);
    expect(viaRules?.tier).toBe('rule');
    // `auto` keeps the rule first, so the same frame answers the misread.
    const auto = createAutoReader({
      template: createTemplateReader({ templates: [THREE_AS_FOUR] }),
      ocr: failingReader('ocr'),
    });
    expect((await auto.read(RULE_THREE_IMAGE, REGION))?.value).toBe(3);
    // `template` asks the atlas first and carries the atlas's digit.
    const templateFirst = createAutoReader({
      strategy: 'template',
      template: createTemplateReader({ templates: [THREE_AS_FOUR] }),
      ocr: failingReader('ocr'),
    });
    const read = await templateFirst.read(RULE_THREE_IMAGE, REGION);
    expect(read?.value).toBe(4);
    expect(read?.tier).toBe('template');
    expect(read!.confidence).toBeGreaterThan(0.99);
  });

  it('falls to OCR when the atlas refuses, and never calls the rule tier', async () => {
    // The premise: this bar is a crop the atlas tier refuses (a 12 x 2 bar, below its floor).
    await expect(createTemplateReader({ templates: STRIP_ATLAS }).read(BAR_IMAGE, REGION)).resolves.toBeNull();
    let ocrCalls = 0;
    const ocr: NumeralsReader = {
      read: async () => {
        ocrCalls += 1;
        return { value: 5, confidence: 0.9, tier: 'ocr' };
      },
    };
    const reader = createAutoReader({
      strategy: 'template',
      // A rule tier that would throw if asked: the strategy must not consult it at all.
      rule: failingReader('rule'),
      template: createTemplateReader({ templates: STRIP_ATLAS }),
      ocr,
    });
    expect(await reader.read(BAR_IMAGE, REGION)).toEqual({ value: 5, confidence: 0.9, tier: 'ocr' });
    expect(ocrCalls).toBe(1);
  });

  it('template without an atlas is an OCR-only read', async () => {
    // Templates are optional data, not a precondition: the template tier is absent, so the strategy
    // is OCR alone — not `auto`, which would let the rule tier (16) answer before OCR (8).
    const reader = createNumeralsReader({
      strategy: 'template',
      ocr: fixedReader({ value: 8, confidence: 0.9, tier: 'ocr' }),
    });
    expect(await reader.read(STRIP, REGION)).toEqual({ value: 8, confidence: 0.9, tier: 'ocr' });
  });
});

describe('the numerals-reader factory', () => {
  it('builds the selector from the strategy and the templates it is handed', async () => {
    const auto = createNumeralsReader({ templates: [BLOCK_TEMPLATE], ocr: failingReader('ocr') });
    expect((await auto.read(STRIP, REGION))?.tier).toBe('rule');
    expect((await auto.read(BLOCK_IMAGE, REGION))?.tier).toBe('template');

    const fast = createNumeralsReader({ strategy: 'fast', ocr: failingReader('ocr') });
    await expect(fast.read(BLOCK_IMAGE, REGION)).resolves.toBeNull();

    // With an atlas the fast chain carries the template tier too, and still no OCR.
    const fastAtlas = createNumeralsReader({
      strategy: 'fast',
      templates: STRIP_ATLAS,
      ocr: failingReader('ocr'),
    });
    await expect(fastAtlas.read(BAR_IMAGE, REGION)).resolves.toBeNull();

    const ocr = createNumeralsReader({
      strategy: 'ocr',
      ocr: fixedReader({ value: 38, confidence: 0.9, tier: 'ocr' }),
    });
    expect(await ocr.read(STRIP, REGION)).toEqual({ value: 38, confidence: 0.9, tier: 'ocr' });
  });

  it('has no template tier when no templates are handed in', async () => {
    const reader = createNumeralsReader({
      ocr: fixedReader({ value: 8, confidence: 0.9, tier: 'ocr' }),
    });
    expect(await reader.read(BLOCK_IMAGE, REGION)).toEqual({ value: 8, confidence: 0.9, tier: 'ocr' });
  });
});
