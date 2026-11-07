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
 *    would name a refused field 93 where the screen says 92, so an `auto` chain is never the opener's
 *    escalation. (The config row that used to build that chain was removed by R12 / review F2; the
 *    chain is still constructible, which is what the R9 case pins.)
 *
 * The heart's absent / unreadable distinction is covered where it lives, by the existing
 * tests/opener.test.ts cases (a card that draws no heart is null; a drawn numeral the atlas cannot
 * identify is NaN and costs its own card only).
 */
import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import {
  createOcrBudget,
  OPENER_SLOTS,
  parseOpener,
  parseOpenerDetailed,
  parseOpenerImage,
  TRAP_DIGIT_TEMPLATES,
  type OpenerTierSummary,
} from '../src/perception/opener.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { createNumeralsReader, ocrReader, type NumeralsReader, type ReadHint } from '../src/perception/readers/index.ts';
import { assertOcrRuntime, OCR_LIVE, OCR_PYTHON, OCR_SCRIPT } from './ocr-runtime.ts';

const FIXTURES = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const MEASUREMENTS = new URL('measurements.json', FIXTURES);
/** The QTE bar (2026-10-24 01:41): a real frame with no panel on it. */
const QTE_FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
/** The 3-D view: HUD and map, no modal panel. */
const NAV_FIXTURES = new URL('../testdata/nav-1024-0213/', import.meta.url);

/**
 * The most one OCR call may take for the two-call amount-2 read to be measurable here: the read needs
 * both calls under the bound this file stubs (20 s, ruling R7 — the committed production default is
 * 8 s) with the second starting inside the budget's 10 s window, so a single call over 5 s leaves no
 * headroom for the second (this host measures ~2.5–5 s per call; a loaded one has already taken
 * 8 070 ms, the Task 4 flake). Above it the measured read skips, with the reason (the skip is named
 * in docs/status.md, review F9); the always-run invariant beside it covers the same panel, and the 92
 * assertion itself is not weakened.
 */
const MEASURED_READ_PROBE_MAX_MS = 5_000;

/**
 * Card 1's 陷阱发现 band and its label on panel-00: the crop one OCR call reads as 38 (measured
 * 2026-11-07). It is the latency probe before the amount-2 read — one call of the same work the read
 * needs twice, so a loaded host is found before the two-call read turns into a red assertion.
 */
const PROBE_BAND = { x: 778, y: 793, width: 87, height: 16 };
const PROBE_LABEL = { x: 704, y: 785, width: 74, height: 30 };

/**
 * The host's OCR environment must not decide what the fast tier answers (review I5). Every test
 * starts with the runtime **unset**, so a field the template tier should answer can never be
 * answered by a host venv in the background; the sharpened describe stubs the real pair back in,
 * because there the escalation is the thing under test.
 */
beforeEach(() => {
  vi.stubEnv('WVD_OCR_PYTHON', '');
  vi.stubEnv('WVD_OCR_SCRIPT', '');
  // R7's bound is the test's to set: the committed 8 s default is a production bound, and the
  // sharpened-panel cases wait out a real OCR call. Stubbed, so `pnpm test` is green with no hand-set
  // environment; the describes that stub the real runtime pair inherit this one.
  vi.stubEnv('WVD_OCR_TIMEOUT_MS', '20000');
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

/**
 * The decoded panel with the given slots' bottom border erased — the one piece of evidence
 * `cardPresent` reads (its row, across the card box's x edges). Slot 4 erased and slot 5 kept is
 * "a drawn card after an undrawn one", the layout `parseOpenerImage` refuses before reading a
 * numeral; all six erased is a frame the card segmentation calls `not-panel`.
 */
function withoutCardBorders(image: RgbaImage, slots: readonly number[]): RgbaImage {
  const out: RgbaImage = { data: new Uint8Array(image.data), width: image.width, height: image.height };
  for (const slot of slots) {
    const { rect } = OPENER_SLOTS[slot]!;
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      const offset = (rect.y1 * out.width + x) * 4;
      out.data[offset] = 0;
      out.data[offset + 1] = 0;
      out.data[offset + 2] = 0;
    }
  }
  return out;
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
// The tier log on a panel refused before a numeral is read (review gap, Task 4)
// ---------------------------------------------------------------------------------------------

/**
 * `onTiers` is fired once per **recognised panel**, not once per field read: a panel the gates
 * recognised and the parser then refuses must still report the mix it read so far — zero, when the
 * refusal comes before any 陷阱 field. Silence there is a recognised panel whose tier the log cannot
 * see ("a read that silently changes tier cannot be measured", plan Global Constraints), and it is
 * the hole this block pins.
 */
describe('a recognised panel refused before a numeral is read still reports its tier mix', () => {
  it('reports the drawn-card-after-an-undrawn-one layout it refuses', async () => {
    // Slot 5's border erased and slot 6 kept: a hole in the roster prefix, the layout opener.ts
    // refuses before the escalation is even built (so before `trapReader` can answer a field).
    const summaries: OpenerTierSummary[] = [];
    const parsed = await parseOpenerImage(withoutCardBorders(await jpegImage('panel-00.jpg'), [4]), {
      onTiers: (summary) => summaries.push(summary),
    });

    expect(parsed).toEqual({ ok: false, reason: 'unreadable' });
    // Nothing was read, and the panel still says so — once, with both counts zero.
    expect(summaries).toEqual([{ template: 0, ocr: 0 }]);
  });

  it('reports nothing for a frame the gates refused — no cards, no panel', async () => {
    // The other half of the boundary. This frame passes the panel band and the title's ink gate but
    // draws no card, so the parse answers `not-panel` and ChestPerceiver falls through to the bar:
    // there is no recognised panel whose tiers could be reported, and the log stays silent.
    const summaries: OpenerTierSummary[] = [];
    const parsed = await parseOpenerImage(withoutCardBorders(await jpegImage('panel-00.jpg'), [0, 1, 2, 3, 4, 5]), {
      onTiers: (summary) => summaries.push(summary),
    });

    expect(parsed).toEqual({ ok: false, reason: 'not-panel' });
    expect(summaries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The sharpened panel — the raw-pixel proxy of the live failure
// ---------------------------------------------------------------------------------------------

/**
 * These cases wait out one **real** OCR call each, and keep the suite's default 20 s deadline: the
 * call's own bound (`WVD_OCR_TIMEOUT_MS`, stubbed to 20 s in this file — R7) decides the read, and a
 * call that returns null still fails the content assertion. The suite runs its files one at a time
 * (vitest.config.ts, `fileParallelism: false`), so this file's calls are not queued behind the
 * corpus's 24 reads — the load that once made a call take 10-13 s and pushed a 20 s deadline.
 */
describe.skipIf(!OCR_LIVE)('the sharpened panel (the raw-pixel proxy)', () => {
  beforeEach(() => {
    assertOcrRuntime();
    vi.stubEnv('WVD_OCR_PYTHON', OCR_PYTHON);
    vi.stubEnv('WVD_OCR_SCRIPT', OCR_SCRIPT);
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
  });

  it('refuses the same frame when the OCR runtime is absent — the escalation is what answers it', async () => {
    // Not a loosened floor and not a second atlas: with no runtime named, the field the template tier
    // refuses stays refused, and a refused 陷阱 field refuses the panel. This is the premise of the
    // test above, asserted.
    vi.stubEnv('WVD_OCR_PYTHON', '');
    vi.stubEnv('WVD_OCR_SCRIPT', '');
    const image = sharpened(await jpegImage('panel-00.jpg'), 1);

    expect(await parseOpenerDetailed(frameOf(image))).toEqual({ ok: false, reason: 'unreadable' });
  });

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
  });
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
  // The block's own env: the two cases below are about what happens with no OCR runtime, so the pair
  // is stubbed out here as well as at the file level — the block does not lean on a hook it cannot
  // see. A host that exports the pair must not turn the 93 case into OCR's 92 or the refusal case into
  // a read; the case whose whole point is the escalation opts back into the real pair explicitly (the
  // sharpened describe's shape).
  beforeEach(() => {
    vi.stubEnv('WVD_OCR_PYTHON', '');
    vi.stubEnv('WVD_OCR_SCRIPT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  let sharpenedTwo: Promise<RgbaImage> | null = null;
  function sharpenedTwoPanel(): Promise<RgbaImage> {
    sharpenedTwo ??= jpegImage('panel-00.jpg').then((base) => sharpened(base, 2));
    return sharpenedTwo;
  }

  it('an auto chain answers the amount-2 refusals from the rules — the hazard R9 removes', async () => {
    // What the pre-R9 wiring passed as the escalation: a reader built with the config's former
    // default, `auto` (the config row itself was removed by R12 / review F2). The OCR runtime is
    // unset here, so this is the rule tier alone: card 4's 陷阱发现 comes back 93, not the measured
    // 92. If `number.ts`'s 4/3 fix (board card t-mw65nlh4-lfoik7) lands, this expectation is the one
    // to revisit — it pins the misname R9 keeps out of the panel's ranking.
    const expected = await measured();
    const observation = await new ChestPerceiver({ trapReader: createNumeralsReader({ strategy: 'auto' }) })
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

  it("the amount-2 panel refuses or reads the measured twelve — never the rule chain's 93", async () => {
    // The invariant that runs on every host, whatever its OCR load: R9's escalation is OCR-only, so a
    // field it cannot answer refuses the panel; it never falls back to the rules, whose 4-as-3 would
    // name card 4's 陷阱发现 93 where the screen says 92. A read is the other legal outcome and must
    // be the measured twelve. The runtime, when this host has one, is what the composition root
    // passes; without it the refusal branch is the answer.
    if (OCR_LIVE) {
      assertOcrRuntime();
      vi.stubEnv('WVD_OCR_PYTHON', OCR_PYTHON);
      vi.stubEnv('WVD_OCR_SCRIPT', OCR_SCRIPT);
    }
    const expected = await measured();
    const parsed = await parseOpenerImage(await sharpenedTwoPanel(), { trapReader: ocrReader });

    if (!parsed.ok) {
      // Refused, not named: nothing fills in for a field the escalation could not answer, so no
      // number at all is recorded — the 93 is not reachable from here.
      expect(parsed).toEqual({ ok: false, reason: 'unreadable' });
      return;
    }
    const detects = parsed.panel.members.map((member) => member.detect);
    expect(detects).toEqual(expected.map((member) => member.detect));
    expect(parsed.panel.members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
    // The measured value of the field the rule chain names 93, and the 93 itself nowhere in the read.
    expect(parsed.panel.members[3]!.detect).toBe(92);
    expect(detects).not.toContain(93);
  }, 40_000);

  describe.skipIf(!OCR_LIVE)('with the OCR runtime', () => {
    beforeEach(() => {
      assertOcrRuntime();
      vi.stubEnv('WVD_OCR_PYTHON', OCR_PYTHON);
      vi.stubEnv('WVD_OCR_SCRIPT', OCR_SCRIPT);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads the amount-2 panel as measured (92) on the production budget — this host's OCR starts the second call inside the 10 s window", async (context) => {
      // Two fields escalate on this proxy. R10 raised the production window (R6: two calls, none
      // starting more than OCR_CALL_WINDOW_MS after the first) from 2 s to 10 s, because this host's
      // OCR takes ~2.5–5 s per call (Task 4 report): the second escalation now starts inside it, so
      // the panel reads the measured twelve instead of refusing. No budget is injected — what the
      // composition root builds is what the panel is read under, and the 2-call cap is unchanged. On
      // a host whose OCR starts the second call past 10 s the panel refuses at the second take() (the
      // safe R9 outcome, never a rule's 93); the always-run invariant above holds on that host.
      //
      // The read is gated by one call's latency first: it needs **two** calls under this file's
      // stubbed 20 s bound (R7) with the second starting inside the 10 s window, and a loaded host
      // (the full suite's parallel forks made one call take 8 070 ms) would turn the 92 into a host
      // measurement. Over the threshold this case skips with the reason, named in docs/status.md
      // (review F9); under it the 92 below is asserted unchanged.
      const probeStart = Date.now();
      const probe = await ocrReader.read(await jpegImage('panel-00.jpg'), PROBE_BAND, { label: PROBE_LABEL });
      const probeMs = Date.now() - probeStart;
      if (probeMs > MEASURED_READ_PROBE_MAX_MS) {
        // vitest 2.1.9's context.skip() carries no note, so the reason is reported before the skip:
        // it lands in the run's log beside the skipped test.
        console.warn(`wvd: the amount-2 measured read is skipped — one OCR call took ${probeMs} ms, over the ${MEASURED_READ_PROBE_MAX_MS} ms a two-call read leaves headroom for`);
        context.skip();
      }
      // Fast and silent is a broken runtime, not a loaded host: that must fail, not skip.
      expect(probe?.value).toBe(38);

      const expected = await measured();
      const parsed = await parseOpenerImage(await sharpenedTwoPanel(), { trapReader: ocrReader });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const members = parsed.panel.members;
      expect(members.map((member) => member.detect)).toEqual(expected.map((member) => member.detect));
      expect(members.map((member) => member.disarm)).toEqual(expected.map((member) => member.disarm));
      // The measured value of the field the rule chain names 93.
      expect(members[3]!.detect).toBe(92);
    }, 45_000);
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
    // main.ts builds ChestPerceiver with the package's OCR tier and the tier log; the perceiver must
    // pass the reader into the parse as the escalation and the log up as the callback (R9, R6).
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
// One allowance and one log line per panel, not per observation (review F1)
// ---------------------------------------------------------------------------------------------

/**
 * The budget and the tier log belong to the **panel**, not to the observation (review F1).
 * `ChestPerceiver` is the composite's first perceiver, so it observes a frame on every tick; when the
 * opener stayed up undecided it used to build a fresh `OcrBudget` and fire `onTiers` per call — two
 * OCR calls (up to 2 x 8 s) and one log line **every tick**. The allowance and the reported flag now
 * live in the perceiver and are reset when a parse answers `not-panel`: the screen is no longer the
 * panel, so the next panel is a new one.
 */
describe('the OCR allowance and the tier log belong to the panel, not the observation (F1)', () => {
  let sharpenedThree: Promise<RgbaImage> | null = null;
  function sharpenedThreePanel(): Promise<RgbaImage> {
    sharpenedThree ??= jpegImage('panel-00.jpg').then((base) => sharpened(base, 3));
    return sharpenedThree;
  }

  function countingEscalation(): { reader: NumeralsReader; state: { calls: number } } {
    const state = { calls: 0 };
    const reader: NumeralsReader = {
      read: async () => {
        state.calls += 1;
        return { value: 11, confidence: 0.9, tier: 'ocr' };
      },
    };
    return { reader, state };
  }

  it('spends one panel allowance and logs once across two observes of the same panel', async () => {
    const image = await sharpenedThreePanel();
    const fake = countingEscalation();
    const summaries: OpenerTierSummary[] = [];
    const perceiver = new ChestPerceiver({
      trapReader: fake.reader,
      onOpenerTiers: (summary) => summaries.push(summary),
    });

    const first = await perceiver.observe(frameOf(image, 1_000));
    const second = await perceiver.observe(frameOf(image, 1_100));

    expect(first).toMatchObject({ screen: 'unknown', confidence: 0.3 });
    expect(second).toMatchObject({ screen: 'unknown', confidence: 0.3 });
    // One panel's two-call cap in total, not two per observation.
    expect(fake.state.calls).toBe(2);
    // One line for the panel: the second observation is the same undecided panel, not a new one.
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ ocr: 2 });
  });

  it('starts a fresh allowance and a fresh line once the screen is no longer the panel', async () => {
    const image = await sharpenedThreePanel();
    const bar = await jpegImage('frame-3.jpg', QTE_FIXTURES);
    const fake = countingEscalation();
    const summaries: OpenerTierSummary[] = [];
    const perceiver = new ChestPerceiver({
      trapReader: fake.reader,
      onOpenerTiers: (summary) => summaries.push(summary),
    });

    await perceiver.observe(frameOf(image, 1_000));
    // The bar: the parse answers `not-panel`, so the panel's allowance and its reported flag are done.
    const between = await perceiver.observe(frameOf(bar, 1_100));
    expect(between.screen).not.toBe('chest-open');
    const again = await perceiver.observe(frameOf(image, 1_200));

    expect(again).toMatchObject({ screen: 'unknown', confidence: 0.3 });
    // Two panels: two allowances, two lines.
    expect(fake.state.calls).toBe(4);
    expect(summaries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The read's hint carries what the opener knows about the field (review F6)
// ---------------------------------------------------------------------------------------------

/**
 * Every 陷阱 read hands the reader the field's length and its plausible bounds (review F6), so an
 * escalation cannot answer something the field cannot carry: an OCR `0` on a two-digit field is
 * refused by the hint's `digits`/`min` instead of relying on the opener's length comparison
 * afterwards. The bounds are the corpus's range: a 陷阱 bonus is a positive number of at most three
 * digits.
 */
describe("the trap read's hint carries the field's length and bounds (F6)", () => {
  it('names the expected digits, the plausible range and the label on every escalation', async () => {
    const hints: Array<ReadHint | undefined> = [];
    const answering: NumeralsReader = {
      read: async (_image, _region, hint) => {
        hints.push(hint);
        return { value: 11, confidence: 0.9, tier: 'ocr' };
      },
    };
    // The amount-3 proxy refuses three two-digit fields; the default two-call budget lets two reach
    // the escalation and refuses the third before it is asked (R6), which refuses the panel.
    const parsed = await parseOpenerImage(sharpened(await jpegImage('panel-00.jpg'), 3), { trapReader: answering });

    expect(parsed).toEqual({ ok: false, reason: 'unreadable' });
    expect(hints).toHaveLength(2);
    for (const hint of hints) {
      expect(hint).toMatchObject({ digits: 2, min: 1, max: 999 });
      expect(hint!.label).toBeDefined();
    }
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
