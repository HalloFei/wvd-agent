/**
 * The opener's numerals through the numerals-reader seam (Task 3).
 *
 * The failure this exists for: the 由谁打开? panel was **recognised and then refused by its own
 * reader** live on 2026-11-07, because a 陷阱 numeral's atlas match fell under its floor on the
 * vision module's raw pixels. The atlases are means of glyphs recorded through the old JPEG decode,
 * so perception was encoding a property of the capture pipeline (readers spec 2026-11-07).
 *
 * What this file pins:
 *
 * 1. panel-00.jpg reads measurements.json's 陷阱发现 / 陷阱解除 and 心 values — the same measurement
 *    tests/opener.test.ts asserts, loaded from the JSON rather than re-typed.
 * 2. The **sharpened** panel — img + 1.0 * (img - boxBlur), the raw-pixel proxy the diagnosis used —
 *    reads the same 陷阱 values, the template tier answering where it can and the **OCR tier**
 *    answering where it refuses. That is the live failure reproduced: the old opener refuses this
 *    frame outright (unreadable).
 * 3. The negatives still refuse: the QTE bar and the 3-D view are not the panel.
 * 4. The **escalation is the OCR tier directly** (ruling R9): on the amount-2 proxy the rule tier
 *    would name a refused field 93 where the screen says 92, so the config-built reader is never
 *    the opener's escalation.
 *
 * The heart's absent / unreadable distinction is covered where it lives, by the existing
 * tests/opener.test.ts cases (a card that draws no heart is null; a drawn numeral the atlas cannot
 * identify is NaN and costs its own card only).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import {
  createOcrBudget,
  parseOpener,
  parseOpenerDetailed,
  parseOpenerImage,
  TRAP_DIGIT_TEMPLATES,
  type OpenerTierSummary,
} from '../src/perception/opener.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { WVD_DEFAULTS } from '../src/config.ts';
import { createNumeralsReaderFromConfig } from '../src/main.ts';
import { createNumeralsReader, ocrReader, type NumeralsReader } from '../src/perception/readers/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const MEASUREMENTS = new URL('measurements.json', FIXTURES);
/** The QTE bar (2026-10-24 01:41): a real frame with no panel on it. */
const QTE_FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
/** The 3-D view: HUD and map, no modal panel. */
const NAV_FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

/** The operator's venv and the readout script; env wins, the repo-local pair is the fallback. */
const PYTHON = process.env.WVD_OCR_PYTHON || ROOT + '/.tmp/ocr-venv/Scripts/python.exe';
const SCRIPT = process.env.WVD_OCR_SCRIPT || ROOT + '/scripts/ocr-readout.py';
/** Is there a runtime to measure? Gates the sharpened panel, so a host without it skips, not fails. */
const OCR_AVAILABLE = existsSync(PYTHON) && existsSync(SCRIPT);

/**
 * The host's OCR environment must not decide what the fast tier answers (review I5). Every test
 * starts with the runtime **unset**, so a field the template tier should answer can never be
 * answered by a host venv in the background; the sharpened describe stubs the real pair back in,
 * because there the escalation is the thing under test.
 */
beforeEach(() => {
  vi.stubEnv('WVD_OCR_PYTHON', '');
  vi.stubEnv('WVD_OCR_SCRIPT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** Decoded once per fixture: jpeg-js spends ~150 ms on a 1080p frame and the tests share them. */
const imageCache = new Map<string, Promise<RgbaImage>>();

function jpegImage(name: string, dir = FIXTURES): Promise<RgbaImage> {
  const key = dir.href + name;
  let image = imageCache.get(key);
  if (!image) {
    image = readFile(new URL(name, dir)).then((bytes) => {
      const decoded = jpeg.decode(bytes, { useTArray: true });
      return { data: decoded.data, width: decoded.width, height: decoded.height };
    });
    imageCache.set(key, image);
  }
  return image;
}

function frameOf(image: RgbaImage, atMs = 1_000): Frame {
  return { atMs, width: image.width, height: image.height, toRgba: async () => image };
}

/**
 * The sharpened panel: img + amount * (img - boxBlur) with a 4-neighbour box blur, exactly the
 * helper the 2026-11-07 diagnosis used (settled: .tmp/opener-sharpen.ts). It is the committed
 * stand-in for a raw capture until the game is launched (plan ruling R3): sharpening the decoded
 * pixels moves them off the atlas the same way raw pixels do.
 */
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

/** What measurements.json says the six cards carry. willpower: null = the card draws no heart. */
interface MeasuredMember {
  readonly name: string;
  readonly detect: number;
  readonly disarm: number;
  readonly willpower: number | null;
}

let measuredMembers: Promise<readonly MeasuredMember[]> | null = null;
function measured(): Promise<readonly MeasuredMember[]> {
  measuredMembers ??= readFile(MEASUREMENTS, 'utf8').then(
    (text) => (JSON.parse(text) as { members: MeasuredMember[] }).members,
  );
  return measuredMembers;
}

/** The JSON's willpower column as the parser records it: null = no heart drawn, a number = read. */
function expectedWillpower(members: readonly MeasuredMember[]): Array<number | null> {
  return members.map((member) => member.willpower);
}

// ---------------------------------------------------------------------------------------------
// The seam, on the fixture
// ---------------------------------------------------------------------------------------------

describe('the opener reads its numerals through the seam', () => {
  it("reads the fixture's 陷阱 and heart values from panel-00", async () => {
    const expected = await measured();
    const panel = await parseOpener(frameOf(await jpegImage('panel-00.jpg'), 7_654));

    expect(panel).not.toBeNull();
    expect(panel!.members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
    expect(panel!.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
    expect(panel!.members.map((member) => member.willpower)).toEqual(expectedWillpower(expected));
  });

  it('reads the decoded fixture without asking the OCR tier at all', async () => {
    // The decoded fixture is the fast tier's job (review I5): an escalation stubbed to throw proves
    // it. Without this, a host that has the venv would let a slow process answer a field the template
    // tier should have answered, and "the fast tier answers" would stay unasserted.
    const expected = await measured();
    let calls = 0;
    const trapReader: NumeralsReader = {
      read: async () => {
        calls += 1;
        throw new Error('the decoded fixture must not reach the OCR tier');
      },
    };

    const parsed = await parseOpenerImage(await jpegImage('panel-00.jpg'), { trapReader });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.panel.members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
    expect(parsed.panel.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
    expect(calls).toBe(0);
  });

  it('reports the tier that answered every field, once per panel (Task 4)', async () => {
    // The health metric the log exists for: six cards x two 陷阱 fields, and on this decoded panel the
    // template tier answers all twelve — no glyph is handed to OCR. Once, not once per glyph.
    const summaries: OpenerTierSummary[] = [];
    const parsed = await parseOpenerImage(await jpegImage('panel-00.jpg'), {
      onTiers: (summary) => summaries.push(summary),
    });

    expect(parsed.ok).toBe(true);
    expect(summaries).toEqual([{ template: 12, ocr: 0 }]);
  });

  it("names the number and the tier that answered a field's atlas read", async () => {
    // The 陷阱 atlas through the seam's own factory: the fast tier answers the fixture, the tier
    // travels with the number (the health metric Task 4 logs), and the bands are the opener's.
    const reader = createNumeralsReader({
      strategy: 'template',
      templates: TRAP_DIGIT_TEMPLATES,
      matchFloor: 0.7,
      marginFloor: 0.1,
    });
    const image = await jpegImage('panel-00.jpg');
    // Card 1's 陷阱发现 band, and its label as the read's context (the crop OCR needs).
    const band = { x: 778, y: 793, width: 87, height: 16 };
    const label = { x: 704, y: 785, width: 74, height: 30 };

    const read = await reader.read(image, band, { label });
    expect(read?.value).toBe(38);
    expect(read?.tier).toBe('template');
  });
});

// ---------------------------------------------------------------------------------------------
// The sharpened panel — the raw-pixel proxy of the live failure
// ---------------------------------------------------------------------------------------------

describe.skipIf(!OCR_AVAILABLE)('the sharpened panel (the raw-pixel proxy)', () => {
  beforeEach(() => {
    vi.stubEnv('WVD_OCR_PYTHON', PYTHON);
    vi.stubEnv('WVD_OCR_SCRIPT', SCRIPT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the same 陷阱 values, the OCR tier answering where the template refuses', async () => {
    // The old opener refuses this frame outright (unreadable): the 陷阱 atlas scores fell under the
    // floor, which is the live failure. Through the seam the template tier answers eleven of the
    // twelve fields and the OCR tier answers the one it refuses — and the answer is the measured one.
    const expected = await measured();
    const image = sharpened(await jpegImage('panel-00.jpg'), 1);
    const parsed = await parseOpenerDetailed(frameOf(image));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.panel.members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
    expect(parsed.panel.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
  }, 20_000);

  it('refuses the same frame when the OCR runtime is absent — the escalation is what answers it', async () => {
    // Not a loosened floor and not a second atlas: with no runtime named, the field the template tier
    // refuses stays refused, and a refused 陷阱 field refuses the panel. This is the premise of the
    // test above, asserted.
    vi.stubEnv('WVD_OCR_PYTHON', '');
    vi.stubEnv('WVD_OCR_SCRIPT', '');
    const image = sharpened(await jpegImage('panel-00.jpg'), 1);

    expect(await parseOpenerDetailed(frameOf(image))).toEqual({ ok: false, reason: 'unreadable' });
  }, 20_000);

  it('keeps the heart semantics on the sharpened proxy: one unread numeral costs its own card', async () => {
    // The heart field is the one numeral whose atlas the template tier cannot reproduce: the heart
    // atlas was recorded from a chroma-segmented crop normalised against that crop's own median, and
    // the tier's luma-median ink splits the numeral differently (measured 2026-11-07; see the task
    // report). So readHeartNumber keeps the opener's matcher, and this proxy — not the tier — decides
    // which hearts survive it. Card 1's 100 falls to 0.871 against the identity floor of 0.95 and is
    // unreadable (NaN), which must never be recorded as absent (null): the card still stands, the
    // other five cards still rank, and the panel is not refused.
    const image = sharpened(await jpegImage('panel-00.jpg'), 1);
    const parsed = await parseOpenerDetailed(frameOf(image));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const willpower = parsed.panel.members.map((member) =>
      member.willpower === null ? 'absent' : Number.isNaN(member.willpower) ? 'unread' : member.willpower);
    expect(willpower).toEqual([100, 'unread', 100, 'absent', 90, 100]);
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// The escalation is the OCR tier, never the rule chain (ruling R9)
// ---------------------------------------------------------------------------------------------

/**
 * R9: a template-refused 陷阱 field escalates to the **OCR tier**, never to the config-built reader.
 * Measured 2026-11-07 on `sharpened(panel, 2)`: the atlas refuses two fields, the rule tier names
 * them 93 and 49, and OCR reads 92 and 49. So the config's default `auto` escalation would let the
 * rules name card 4's 陷阱发现 93 where the screen says 92 — a wrong number rather than a refusal,
 * which the opener's length check cannot see (both are two digits).
 */
describe('the escalation is the OCR tier, never the rule chain (R9)', () => {
  let sharpenedTwo: Promise<RgbaImage> | null = null;
  function sharpenedTwoPanel(): Promise<RgbaImage> {
    sharpenedTwo ??= jpegImage('panel-00.jpg').then((base) => sharpened(base, 2));
    return sharpenedTwo;
  }

  it('the config-built chain answers the amount-2 refusals from the rules — the hazard R9 removes', async () => {
    // What the pre-R9 wiring passed as the escalation (the factory, default 'auto'). The OCR runtime
    // is unset here, so this is the rule tier alone: card 4's 陷阱发现 comes back 93, not the measured
    // 92. If `number.ts`'s 4/3 fix (board card t-mw65nlh4-lfoik7) lands, this expectation is the one
    // to revisit — it pins the misname R9 keeps out of the panel's ranking.
    const expected = await measured();
    const observation = await new ChestPerceiver({ trapReader: createNumeralsReaderFromConfig(WVD_DEFAULTS) })
      .observe(frameOf(await sharpenedTwoPanel()));

    expect(observation.screen).toBe('chest-open');
    if (observation.screen !== 'chest-open') return;
    expect(observation.opener.members.map((member) => member.detect)).toEqual(
      expected.map((member, index) => (index === 3 ? 93 : member.detect)),
    );
  });

  it('the OCR tier is the escalation: with no OCR runtime the same panel refuses, no rule answers', async () => {
    // The escalation main.ts passes: the package's OCR tier. The runtime is unset, so the tier is a
    // null rather than an answer, and the refused field refuses the panel — nothing fills in with a
    // fast tier's guess.
    const observation = await new ChestPerceiver({ trapReader: ocrReader })
      .observe(frameOf(await sharpenedTwoPanel()));

    expect(observation).toMatchObject({ screen: 'unknown', confidence: 0.3 });
  });

  describe.skipIf(!OCR_AVAILABLE)('with the OCR runtime', () => {
    beforeEach(() => {
      vi.stubEnv('WVD_OCR_PYTHON', PYTHON);
      vi.stubEnv('WVD_OCR_SCRIPT', SCRIPT);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads the amount-2 panel as measured (92) on the production budget — this host's OCR starts the second call inside the 10 s window", async () => {
      // Two fields escalate on this proxy. R10 raised the production window (R6: two calls, none
      // starting more than OCR_CALL_WINDOW_MS after the first) from 2 s to 10 s, because this host's
      // OCR takes ~2.5–5 s per call (Task 4 report): the second escalation now starts inside it, so
      // the panel reads the measured twelve instead of refusing. No budget is injected — what the
      // composition root builds is what the panel is read under, and the 2-call cap is unchanged. On
      // a host whose OCR starts the second call past 10 s the panel refuses at the second take() (the
      // safe R9 outcome, never a rule's 93); that is the only host on which this expectation changes.
      const expected = await measured();
      const parsed = await parseOpenerImage(await sharpenedTwoPanel(), { trapReader: ocrReader });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const members = parsed.panel.members;
      expect(members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
      expect(members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
      // The measured value of the field the rule chain names 93.
      expect(members[3]!.detect).toBe(92);
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------------------------
// The OCR escalation's per-parse budget (review I6, ruling R6)
// ---------------------------------------------------------------------------------------------

/**
 * `sharpened(panel, 3)` is the proxy where the template tier refuses **three** fields and no
 * structural check refuses any (measured 2026-11-07): card 3's 陷阱发现, card 4's 陷阱发现 and card
 * 5's 陷阱解除. The fake escalation answers `11` — two digits, the width the opener measured for
 * all three fields — so nothing but the budget can refuse the third escalation.
 */
describe('the OCR escalation is budgeted per parse', () => {
  let sharpenedThree: Promise<RgbaImage> | null = null;
  function sharpenedThreePanel(): Promise<RgbaImage> {
    sharpenedThree ??= jpegImage('panel-00.jpg').then((base) => sharpened(base, 3));
    return sharpenedThree;
  }

  function countingEscalation(onCall?: () => void): { reader: NumeralsReader; state: { calls: number } } {
    const state = { calls: 0 };
    const reader: NumeralsReader = {
      read: async () => {
        state.calls += 1;
        onCall?.();
        return { value: 11, confidence: 0.9, tier: 'ocr' };
      },
    };
    return { reader, state };
  }

  it('escalates at most twice: the third field the template refuses is refused', async () => {
    const fake = countingEscalation();
    const parsed = await parseOpenerImage(await sharpenedThreePanel(), { trapReader: fake.reader });

    expect(parsed).toEqual({ ok: false, reason: 'unreadable' });
    expect(fake.state.calls).toBe(2);
  });

  it('answers the same frame when the budget is three — the third refusal is the budget', async () => {
    // Not a frame on which the escalation cannot answer: hand it a budget of three and the same
    // reader answers all three fields, which is what makes the refusal above the cap's doing.
    const expected = await measured();
    const fake = countingEscalation();
    const summaries: OpenerTierSummary[] = [];
    const parsed = await parseOpenerImage(await sharpenedThreePanel(), {
      trapReader: fake.reader,
      ocrBudget: createOcrBudget({ maxCalls: 3 }),
      onTiers: (summary) => summaries.push(summary),
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(fake.state.calls).toBe(3);
    // Nine fields the atlas read, three the escalation answered — the mix of one panel, once.
    expect(summaries).toEqual([{ template: 9, ocr: 3 }]);
    // The three escalated fields carry the fake's answer; the other nine are the measured values.
    expect(parsed.panel.members.map((member) => member.detect))
      .toEqual(expected.map((member, index) => (index === 2 || index === 3 ? 11 : member.detect)));
    expect(parsed.panel.members.map((member) => member.disarm))
      .toEqual(expected.map((member, index) => (index === 4 ? 11 : member.disarm)));
  });

  it('counts an escalation answered by another tier as escalated — the two counts add up', async () => {
    // The escalation is the caller's chain, not necessarily the OCR tier: 'auto' tries the rules
    // first (R8), and a field that chain names is still a field the template tier refused. Counting
    // only `tier: 'ocr'` would report nine template fields and leave three unaccounted for.
    const ruleAnswering: NumeralsReader = {
      read: async () => ({ value: 11, confidence: 0.8, tier: 'rule' }),
    };
    const summaries: OpenerTierSummary[] = [];
    const parsed = await parseOpenerImage(await sharpenedThreePanel(), {
      trapReader: ruleAnswering,
      ocrBudget: createOcrBudget({ maxCalls: 3 }),
      onTiers: (summary) => summaries.push(summary),
    });

    expect(parsed.ok).toBe(true);
    expect(summaries).toEqual([{ template: 9, ocr: 3 }]);
  });

  it('stops escalating when the first call consumes the 10 s deadline', async () => {
    // A first escalation slower than the window spends the budget by construction: the clock is the
    // budget's own, advanced by the reader's first answer (R6's deadline, asserted deterministically
    // at R10's production default — +10 001 ms, one past the window).
    let clock = 10_000;
    const fake = countingEscalation(() => {
      clock += 10_001;
    });
    const parsed = await parseOpenerImage(await sharpenedThreePanel(), {
      trapReader: fake.reader,
      ocrBudget: createOcrBudget({ now: () => clock }),
    });

    expect(parsed).toEqual({ ok: false, reason: 'unreadable' });
    expect(fake.state.calls).toBe(1);
  });

  it('carries the reader and the tier log through ChestPerceiver, the composition root\'s own entry', async () => {
    // main.ts builds the reader from `worlds.wvd.readers.numerals` and hands it to ChestPerceiver,
    // which must pass it to the parse as the escalation and the tier log up as the callback (R8, R6).
    const fake = countingEscalation();
    const summaries: OpenerTierSummary[] = [];
    const observation = await new ChestPerceiver({
      trapReader: fake.reader,
      onOpenerTiers: (summary) => summaries.push(summary),
    }).observe(frameOf(await sharpenedThreePanel(), 4_321));

    // The default budget is two calls, so the third field the template refuses stays refused and the
    // panel is the recognised-but-unreadable answer; the ceiling is still the opener's, not the seam's.
    expect(observation).toMatchObject({ screen: 'unknown', confidence: 0.3 });
    expect(fake.state.calls).toBe(2);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ ocr: 2 });
  });

  it('counts the call cap and the time window separately', () => {
    const cap = createOcrBudget({ now: () => 0 });
    expect([cap.take(), cap.take(), cap.take()]).toEqual([true, true, false]);

    // The default window is the production one (R10: 10 s, the measured OCR latency), so the
    // boundary follows it: a second call starting at +10 000 ms is inside, +10 001 is not.
    let clock = 0;
    const window = createOcrBudget({ maxCalls: 5, now: () => clock });
    expect(window.take()).toBe(true);
    clock = 10_000;
    expect(window.take()).toBe(true);
    clock = 10_001;
    expect(window.take()).toBe(false);

    // An explicit window is still honoured: the default moved, the parameter did not.
    let explicitClock = 0;
    const explicit = createOcrBudget({ maxCalls: 5, windowMs: 2_000, now: () => explicitClock });
    expect(explicit.take()).toBe(true);
    explicitClock = 2_000;
    expect(explicit.take()).toBe(true);
    explicitClock = 2_001;
    expect(explicit.take()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The negatives
// ---------------------------------------------------------------------------------------------

describe('frames that are not the opener panel still refuse', () => {
  it('refuses the QTE bar and the 3-D view as not-panel, without reading a numeral', async () => {
    const qte = await jpegImage('frame-3.jpg', QTE_FIXTURES);
    const nav = await jpegImage('minimap-and-hud.jpg', NAV_FIXTURES);

    expect(await parseOpenerDetailed(frameOf(qte))).toEqual({ ok: false, reason: 'not-panel' });
    expect(await parseOpenerDetailed(frameOf(nav))).toEqual({ ok: false, reason: 'not-panel' });
    expect(await parseOpener(frameOf(qte))).toBeNull();
    expect(await parseOpener(frameOf(nav))).toBeNull();
  });
});
