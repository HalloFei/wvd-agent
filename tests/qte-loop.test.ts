import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { bandSampler, timeQte, type QteRecordEvent, type QteSampler } from '../src/actions/qte.ts';
import type { ActionResult } from '../src/contracts.ts';
import type { Frame, FrameSource, PixelRect, QteZone, RgbaImage } from '../src/contracts.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { qteWindow } from '../src/perception/chest.ts';

/**
 * The sub-loop's subject is timing, so its tests drive it with a sampler that answers with the
 * numbers a bar would have produced, and a clock that only moves when the loop sleeps or takes a
 * sample. No test here renders a bar: `parseQte` is the pixel parser, and reproducing its idea of a
 * warm run, a 55 %-lit profile and a 6–9 px white core in a timing test would copy the perception
 * module's knowledge into this one. The one place real pixels meet the sampler is
 * `bandSampler`, and the `bandSampler` tests below use the shipped still for exactly that.
 */
const FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
const ZONES: readonly QteZone[] = [
  { from: 696, to: 920 },
  { from: 999, to: 1223 },
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface VirtualClock {
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  /** Every delay the sub-loop asked for, in call order. */
  readonly waits: readonly number[];
  /** Move the clock past a frame's own stamp: a sample costs the interval the frame shows. */
  readonly advanceTo: (atMs: number) => void;
}

/**
 * `now`/`wait` as the sub-loop sees them. `wait` is the only place the loop can go wrong silently
 * (a NaN or negative sleep would hang or spin the World), so it is asserted here rather than in one
 * test: any call with a bad delay fails the test that provoked it.
 */
function virtualClock(startMs = 0): VirtualClock {
  let time = startMs;
  const waits: number[] = [];
  return {
    now: () => time,
    wait: async (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`wait(${ms}) is not a finite, non-negative delay`);
      waits.push(ms);
      time += ms;
    },
    waits,
    advanceTo: (atMs: number) => {
      if (atMs > time) time = atMs;
    },
  };
}

/** One scripted answer; `null` is a sample the bar refused (the QTE screen is gone). */
type ScriptEntry =
  | { readonly atMs: number; readonly markerX: number; readonly enabled?: boolean }
  | null;

interface ScriptedSampler extends QteSampler {
  /** The `previousMarkerX` each call was given, in call order. */
  readonly passedPrevious: ReadonlyArray<number | undefined>;
}

/** A still bar sampled again without a script entry: the next frame on the same ~30 fps cadence. */
const SAMPLE_CADENCE_MS = 33;

/**
 * What one sample costs on the virtual clock after its frame was stamped: the crop's decode and the
 * pipe (measured at 8–9 ms). It is deliberately non-zero — if `now()` at planning were exactly the
 * frame's stamp, a loop that slept `plan.atMs` instead of `reading.atMs + plan.atMs - now()` would
 * press at the same instant and the contract §7 trap would be untested.
 */
const SAMPLE_COST_MS = 10;

/**
 * The bar as the sampler sees it: one reading per call, in order. When the script runs out the last
 * reading is repeated one cadence later — a still bar that keeps answering, which is what the rest
 * read needs. Duplicate timestamps would have been just as faithful, but a frozen clock cannot
 * exhaust the budget the loop measures with `now()`, so the cadence advances it.
 */
function scriptedSampler(script: readonly ScriptEntry[], clock: VirtualClock): ScriptedSampler {
  const passedPrevious: Array<number | undefined> = [];
  let index = 0;
  let last: { atMs: number; markerX: number; enabled: boolean } | null = null;
  return {
    passedPrevious,
    async sample(previousMarkerX?: number) {
      passedPrevious.push(previousMarkerX);
      const entry = index < script.length ? script[index] : undefined;
      index += 1;

      if (entry === null) return { ok: false, reason: 'bar-gone' };
      if (entry === undefined) {
        if (last === null) throw new Error('scriptedSampler ran out before its first reading');
        last = { ...last, atMs: last.atMs + SAMPLE_CADENCE_MS };
      } else {
        last = { atMs: entry.atMs, markerX: entry.markerX, enabled: entry.enabled ?? true };
      }

      clock.advanceTo(last.atMs + SAMPLE_COST_MS);
      return {
        ok: true,
        reading: { atMs: last.atMs, markerX: last.markerX, zones: ZONES, enabled: last.enabled },
      };
    },
  };
}

/** A press that succeeds, recording the virtual-clock instant it was sent at. */
function recordingPress(clock: VirtualClock): { press: () => Promise<{ ok: true }>; presses: number[] } {
  const presses: number[] = [];
  return { press: async () => { presses.push(clock.now()); return { ok: true }; }, presses };
}

/** Decode a shipped still the way a `FrameSource` would. Two tests, so no cache: ~300 ms a decode. */
async function jpegFrame(name: string, atMs: number): Promise<Frame> {
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return {
    atMs,
    width: decoded.width,
    height: decoded.height,
    toRgba: async () => ({ data: decoded.data, width: decoded.width, height: decoded.height }),
  };
}

/**
 * A source that can crop: `captureBand` answers the requested rectangle of `full`, and `capture()`
 * throws, so a `bandSampler` that fell back to a full frame would fail the test instead of pass
 * quietly. `rejects` makes the band capture throw the way a stale frame or a refused crop does.
 */
function bandOnlySource(full: Frame, { rejects = false }: { readonly rejects?: boolean } = {}): FrameSource {
  return {
    capture: async () => {
      throw new Error('bandSampler called capture() although captureBand exists');
    },
    captureBand: async (rect: PixelRect) => {
      if (rejects) throw new Error('EngineCaptureError: stale-frame');
      const image = await full.toRgba();
      const cropped = cropBgra(image.data, image.width, image.height, rect);
      return {
        atMs: full.atMs,
        width: cropped.width,
        height: cropped.height,
        toRgba: async () => ({ data: cropped.pixels, width: cropped.width, height: cropped.height }),
      };
    },
  };
}

/** Paint one RGB rectangle, the way the live narrow bar's zones and marker differ from the still. */
function paint(image: RgbaImage, x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
      image.data[offset + 3] = 255;
    }
  }
}

/** The marker's white core at `centreX`: 9 px wide and 31 rows tall, the measured 6–9 px range. */
const paintMarker = (image: RgbaImage, centreX: number): void =>
  paint(image, Math.round(centreX) - 4, 40, 9, 31, [255, 255, 255]);

/**
 * The recorded still with the bar re-drawn the way the live 2026-10-25 chest drew it: 39 px zones
 * around the same centres (808 and 1111) and a 264 px hazard gap, instead of 194 px zones and a
 * 78 px gap. The 解除 control is untouched; the marker is painted per sample so it can move.
 */
function narrowBarBase(image: RgbaImage): RgbaImage {
  const copy = { data: Uint8Array.from(image.data), width: image.width, height: image.height };
  paint(copy, 696, 36, 93, 47, [0, 0, 0]);    // 696–788
  paint(copy, 828, 36, 93, 47, [0, 0, 0]);    // 828–920
  paint(copy, 999, 36, 93, 47, [0, 0, 0]);    // 999–1091, the recorded marker included
  paint(copy, 1131, 36, 93, 47, [0, 0, 0]);   // 1131–1223
  return copy;
}

// ---------------------------------------------------------------------------------------------
// timeQte
// ---------------------------------------------------------------------------------------------

describe('timeQte', () => {
  it('presses once, at the instant the plan named, and reports the fit sample', async () => {
    // marker 20 px per 33 ms → 606 px/s. The no-brake lead is 606·0.06 = 36.4 px, so the left zone's
    // centre (808) is still 68 px ahead and is the soonest reachable one: the plan waits 52.2 ms.
    // The right zone's 1111 would take ~552 ms.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        { atMs: 600, markerX: 900 },   // the rest read
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.v).toBeCloseTo(606, 0);
    expect(out.target).toBe(808);
    expect(out.tapX).toBe(740);
    // §7: the plan is a delay from the reading's clock, never a timestamp.
    expect(out.atMs).toBeCloseTo(52.2, 1);
    // The one pre-press sleep is the plan's: due at 66 + 52.2, asked at 76 (the sample cost).
    expect(clock.waits[0]).toBeCloseTo(42.2, 1);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 1);   // the reading's clock plus the plan's delay
    expect(out.restX).toBe(900);
    // The rest read repeated 900 one cadence later: two readings within the settle tolerance are
    // what makes this a rest (#18's fit must not take a moving sample for one).
    expect(out.restSettled).toBe(true);
    // Every sample after the first is told where the marker was last read — absolute, full-frame.
    expect(sampler.passedPrevious.slice(0, 3)).toEqual([undefined, 700, 720]);
  });

  it('presses the braked plan the 2026-10-24 recording measured (carryTauS: 610 / 6_000)', async () => {
    // The same bar with the switch on: the 61.6 px carry puts the left zone's centre behind the
    // stop (740 + 36.4 + 61.6 = 838), so the plan aims at the right zone's 1111 and waits 450.5 ms —
    // the expectation this test had before the switch defaulted off.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        { atMs: 600, markerX: 900 },   // the rest read
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 610 / 6_000, carryMeasured: true,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(740);
    expect(out.atMs).toBeCloseTo(450.5, 0);
    expect(clock.waits[0]).toBeCloseTo(440.5, 0);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 0);
    expect(out.restX).toBe(900);
    expect(out.restSettled).toBe(true);
  });

  it('presses a plan whose instant the sample cost has already reached', async () => {
    // 606 px/s; at 766.4 the plan's instant is 8.6 ms away — (808 − 766.4 − 36.36)/606 — and the
    // sample itself costs 10 ms, so the instant is just behind us. The landing is not: pressing now
    // carries the marker 606·(0.010 + 0.060) = 42.4 px, to 808.8, the left zone's centre. The press
    // is immediate: a 10 ms lead is not a reason to refuse a pass.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 726.4 },
        { atMs: 33, markerX: 746.4 },
        { atMs: 66, markerX: 766.4 },
        { atMs: 99, markerX: 786.4 },
        { atMs: 600, markerX: 820 },   // the rest read
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(808);
    expect(out.tapX).toBe(766.4);
    expect(out.atMs).toBe(0);
    expect(presses).toEqual([76]);
    expect(out.restX).toBe(820);
  });

  it('presses the braked late landing (carryTauS: 610 / 6_000)', async () => {
    // With the switch on, the same bar at 704.4 has its planned instant 9.9 ms away
    // ((808 − 704.4 − 97.58)/606), just behind the 10 ms sample cost; the predicted landing adds the
    // 61.6 px carry to the 42.4 px of age and input leg and parks at 808.4 — the pre-switch test.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 664.4 },
        { atMs: 33, markerX: 684.4 },
        { atMs: 66, markerX: 704.4 },
        { atMs: 99, markerX: 724.4 },
        { atMs: 600, markerX: 820 },   // the rest read
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 610 / 6_000, carryMeasured: true,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(808);
    expect(out.tapX).toBe(704.4);
    expect(out.atMs).toBe(0);
    expect(presses).toEqual([76]);
    expect(out.restX).toBe(820);
  });

  it('measures the press\'s own timing: the actual delay, the round trip and the child\'s leg', async () => {
    // Operator rule 2026-11-05: L is measured, not assumed. Two clock reads around the press give
    // the round trip; the child's own inputMs splits it; the reading's clock gives the real delay.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        { atMs: 600, markerX: 900 },   // the rest read: the park
      ],
      clock,
    );
    const press = async (): Promise<ActionResult & { readonly inputMs: number }> => {
      await clock.wait(40);                     // the IPC + SendInput + reply round trip
      return { ok: true, inputMs: 76 };
    };

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.delayActualMs).toBeCloseTo(52.2, 0);      // the reading's clock to the send
    expect(out.pressAtMs - out.delayActualMs).toBeCloseTo(66, 1);
    expect(out.ackAtMs - out.pressAtMs).toBeCloseTo(40, 5);
    expect(out.inputMs).toBe(76);
    // The park against the measured timeline: (900 - 740)/606 - 52.2 ms - 40 ms = 0.1718 s.
    expect(out.tauS).toBeCloseTo(0.1718, 3);
  });

  it('records every reading, the plan, the press and the measured carry', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        { atMs: 600, markerX: 900 },
      ],
      clock,
    );
    const events: QteRecordEvent[] = [];
    const press = async (): Promise<ActionResult & { readonly inputMs: number }> => {
      await clock.wait(40);
      return { ok: true, inputMs: 76 };
    };

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, record: (event) => events.push(event),
    });

    expect(out.ok).toBe(true);
    const kinds = events.map((event) => event.kind);
    expect(kinds.slice(0, 3)).toEqual(['reading', 'reading', 'reading']);
    expect(kinds).toContain('plan');
    expect(kinds).toContain('press');
    expect(kinds).toContain('rest');
    expect(kinds).toContain('outcome');
    const plan = events.find((event) => event.kind === 'plan');
    if (plan?.kind !== 'plan') throw new Error('the plan was not recorded');
    expect(plan.target).toBe(808);
    expect(plan.v).toBeCloseTo(606, 0);
    const pressEvent = events.find((event) => event.kind === 'press');
    if (pressEvent?.kind !== 'press') throw new Error('the press was not recorded');
    expect(pressEvent.ok).toBe(true);
    expect(pressEvent.inputMs).toBe(76);
    const restEvent = events.find((event) => event.kind === 'rest');
    if (restEvent?.kind !== 'rest') throw new Error('the rest was not recorded');
    expect(restEvent.restX).toBe(900);
    expect(restEvent.tauS).toBeCloseTo(0.1718, 3);
  });

  it('reads no carry time from a bar that never settled', async () => {
    // A moving marker has no park: the algebra is refused rather than fitted to a flying sample.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        null,                                     // the rest read finds the bar gone
      ],
      clock,
    );
    const press = async (): Promise<ActionResult> => ({ ok: true });
    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.restSettled).toBe(false);
    expect(out.tauS).toBeNull();
  });

  it('plans with the measured carry, so the aim is earlier than the plain lead', async () => {
    // The bar's own carry (0.2 s, measured on an earlier press) is 121 px at 606 px/s: the left
    // zone's centre is behind that stop, so the plan takes the right zone 352 ms out, not 52 ms.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        { atMs: 600, markerX: 900 },
      ],
      clock,
    );
    const { press } = recordingPress(clock);
    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 0.2,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.atMs).toBeCloseTo(352.3, 0);
  });

  it('keeps the 51 ms a stale frame still leaves, and sleeps exactly that', async () => {
    // The third frame arrives 400 ms late, so by the time it is planned `now()` is 466 ms while the
    // plan's instant is 66 + 451.5. Fifty-one ms of the lead is left: still ahead of us, so the plan
    // is kept and the sleep is the remaining 51.5 ms — not the plan's 451.5, and not a refusal.
    const clock = virtualClock(0);
    const script: ReadonlyArray<{ atMs: number; markerX: number; costMs?: number }> = [
      { atMs: 0, markerX: 761 },
      { atMs: 33, markerX: 781 },
      { atMs: 66, markerX: 801, costMs: 400 },
      // The game moved on while the decode was slow: the next frame is stamped after it.
      { atMs: 500, markerX: 806 },
      { atMs: 533, markerX: 808 },
      { atMs: 566, markerX: 808 },
    ];
    let index = 0;
    let last = { atMs: 0, markerX: 761 };
    const sampler: QteSampler = {
      async sample() {
        const entry = script[index];
        index += 1;
        last = entry ?? { ...last, atMs: last.atMs + SAMPLE_CADENCE_MS };
        clock.advanceTo(last.atMs + (entry?.costMs ?? 10));
        return {
          ok: true,
          reading: { atMs: last.atMs, markerX: last.markerX, zones: ZONES, enabled: true },
        };
      },
    };
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tapX).toBe(801);
    expect(out.atMs).toBeCloseTo(451.5, 1);
    expect(clock.waits[0]).toBeCloseTo(51.5, 1);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 1);
  });

  it('keeps the braked 51 ms a stale frame leaves (carryTauS: 610 / 6_000)', async () => {
    // The pre-switch expectation for the same test: the carry makes the right zone the only
    // reachable target and its plan is 450.5 ms out, so 466 ms of clock leaves 50.5 ms of lead.
    const clock = virtualClock(0);
    const script: ReadonlyArray<{ atMs: number; markerX: number; costMs?: number }> = [
      { atMs: 0, markerX: 700 },
      { atMs: 33, markerX: 720 },
      { atMs: 66, markerX: 740, costMs: 400 },
      { atMs: 500, markerX: 760 },
      { atMs: 533, markerX: 780 },
      { atMs: 566, markerX: 800 },
    ];
    let index = 0;
    let last = { atMs: 0, markerX: 700 };
    const sampler: QteSampler = {
      async sample() {
        const entry = script[index];
        index += 1;
        last = entry ?? { ...last, atMs: last.atMs + SAMPLE_CADENCE_MS };
        clock.advanceTo(last.atMs + (entry?.costMs ?? 10));
        return {
          ok: true,
          reading: { atMs: last.atMs, markerX: last.markerX, zones: ZONES, enabled: true },
        };
      },
    };
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 610 / 6_000, carryMeasured: true,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.tapX).toBe(740);
    expect(out.atMs).toBeCloseTo(450.5, 0);
    expect(clock.waits[0]).toBeCloseTo(50.5, 0);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 0);
  });

  it('presses a 1 242 px/s bar whose plan is 55 ms away', async () => {
    // The 13:59 bar's measured geometry (t-mvvzwhb1): 41 px per 33 ms = 1 242 px/s, zones
    // [696,920] and [999,1223]. At 955 the left centre is already behind the no-brake stop, so the
    // plan targets the right zone's 1111 with a 65.6 ms delay; the sample cost leaves 55.6 ms. The
    // pass-window floor would drop it; the lead is a physical boundary, and 55.6 ms is still ahead.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 873 },
        { atMs: 33, markerX: 914 },
        { atMs: 66, markerX: 955 },
        { atMs: 99, markerX: 996 },
        { atMs: 132, markerX: 1037 },
        { atMs: 165, markerX: 1078 },
        { atMs: 198, markerX: 1119 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(955);
    expect(out.atMs).toBeCloseTo(65.56, 1);
    expect(clock.waits[0]).toBeCloseTo(55.56, 1);
    expect(presses).toHaveLength(1);
  });

  it('presses the braked 1 242 px/s bar 55 ms out (carryTauS: 610 / 6_000)', async () => {
    // With the carry the plan is 64.5 ms out, so the 10 ms sample cost leaves 54.5 ms — the
    // pre-switch expectation.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 748 },
        { atMs: 33, markerX: 789 },
        { atMs: 66, markerX: 830 },
        { atMs: 99, markerX: 871 },
        { atMs: 132, markerX: 912 },
        { atMs: 165, markerX: 953 },
        { atMs: 198, markerX: 994 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 610 / 6_000, carryMeasured: true,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(830);
    expect(out.atMs).toBeCloseTo(64.5, 0);
    expect(clock.waits[0]).toBeCloseTo(54.5, 0);
    expect(presses).toHaveLength(1);
  });

  it('spends a fast bar on a probe press that measures the slide, when no slide is known', async () => {
    // Operator, 2026-11-07: a bar above the corpus gate with no measured carry is pressed as a probe —
    // the press aims the marker at the zone centre **on arrival** (no carry), so the park it produces is
    // the slide at this speed, and the next plan uses it. Same bar as the test above at 1 242 px/s; with
    // no carry the plan is 166 ms out instead of 64.5.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 748 },
        { atMs: 33, markerX: 789 },
        { atMs: 66, markerX: 830 },
        { atMs: 99, markerX: 871 },
        { atMs: 132, markerX: 912 },
        { atMs: 165, markerX: 953 },
        { atMs: 198, markerX: 994 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 0.05,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.probe).toBe(true);
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(830);
    expect(out.atMs).toBeCloseTo(166.2, 0);
    expect(presses).toHaveLength(1);
  });

  it('presses now when the plan instant has passed but the landing is still in a zone', async () => {
    // Same bar, one zone later: at 1 034 the no-brake plan's instant is only 2 ms ahead — the
    // reading plus the 10 ms sample cost has already reached it — so the plan is not slept on. A
    // press now carries the marker 87 px and parks it at 1 121, inside [999,1223]. The press is
    // immediate: no wait, no floor, the landing is the test.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 952 },
        { atMs: 33, markerX: 993 },
        { atMs: 66, markerX: 1_034 },
        { atMs: 99, markerX: 1_075 },
        { atMs: 132, markerX: 1_116 },
        { atMs: 165, markerX: 1_157 },
        { atMs: 198, markerX: 1_198 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(1_034);
    expect(out.atMs).toBe(0);              // predicted from this reading: nothing was waited for
    expect(presses).toEqual([76]);         // 66 ms reading + the 10 ms sample cost
  });

  it('presses the braked late landing past the plan instant (carryTauS: 610 / 6_000)', async () => {
    // With the carry the same reading at 960 has its planned instant 49.9 ms behind (the lead is
    // 201 px against a 151 px gap), so the late press is taken: 960 + 213 px parks at 1 173, inside
    // [999,1223] — the pre-switch expectation.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 878 },
        { atMs: 33, markerX: 919 },
        { atMs: 66, markerX: 960 },
        { atMs: 99, markerX: 1_001 },
        { atMs: 132, markerX: 1_042 },
        { atMs: 165, markerX: 1_083 },
        { atMs: 198, markerX: 1_124 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000, carryTauS: 610 / 6_000, carryMeasured: true,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(960);
    expect(out.atMs).toBe(0);
    expect(presses).toEqual([76]);
  });

  it('does not press when the predicted landing is past the bounce', async () => {
    // At 1 242 px/s the carry is 213 px: a marker at 1 242 would park at 1 455, past the 1 261.5
    // reversal, where the model no longer holds. The loop must wait for the next pass instead.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 1160 },
        { atMs: 33, markerX: 1201 },
        { atMs: 66, markerX: 1242 },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 400,
    });

    // Speeds came but no landing was ever inside a zone: the loop reports that, not a spent budget.
    expect(out).toEqual({ ok: false, reason: 'no-reachable-zone' });
    expect(presses).toHaveLength(0);
  });

  it('stops with bar-gone when a sample refuses', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        null,
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out).toEqual({ ok: false, reason: 'bar-gone' });
    expect(presses).toHaveLength(0);
  });

  it('does not press a bar whose 解除 button is dimmed', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700, enabled: false },
        { atMs: 33, markerX: 720, enabled: false },
        { atMs: 66, markerX: 740, enabled: false },
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out).toEqual({ ok: false, reason: 'resolved' });
    expect(presses).toHaveLength(0);
  });

  it('stops with budget-spent when every plan is unreachable', async () => {
    const clock = virtualClock(0);
    // Two neighbouring x values: every window changes sign, so `qteVelocity` refuses every time.
    const sampler = scriptedSampler(
      Array.from({ length: 40 }, (_, index) => ({
        atMs: index * SAMPLE_CADENCE_MS,
        markerX: index % 2 === 0 ? 700 : 702,
      })),
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 1000,
    });

    expect(out).toEqual({ ok: false, reason: 'budget-spent' });
    expect(presses).toHaveLength(0);
  });

  it('reports the press even when the bar is gone before the rest reading', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        null,   // the bar resolves while the marker is still settling
      ],
      clock,
    );
    const { press } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    // The press happened; a bar that vanished before it parked is not the press's failure.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.restX).toBeNull();
      expect(out.restSettled).toBe(false);
      expect(out.target).toBe(808);
    }
  });

  it('reports the press when the sampler throws during the rest read', async () => {
    const clock = virtualClock(0);
    const scripted = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
      ],
      clock,
    );
    let calls = 0;
    const sampler: QteSampler = {
      async sample(previousMarkerX?: number) {
        calls += 1;
        if (calls > 3) throw new Error('EngineCaptureError: stale-frame');
        return scripted.sample(previousMarkerX);
      },
    };
    const { press } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    // A capture that throws after the press is the same unreadable rest as a refusal: `null`, and
    // the press still reports.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.restX).toBeNull();
      expect(out.restSettled).toBe(false);
    }
  });

  it('does not read a rest position when the press is refused', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
      ],
      clock,
    );

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait,
      press: async () => ({ ok: false, reason: 'rejected', detail: 'not-foreground' }),
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out).toEqual({ ok: false, reason: 'press-refused' });
  });

  it('returns capture-failed, without pressing, when the sampler throws', async () => {
    const clock = virtualClock(0);
    // The production sampler already turns a throw into a value; a realizer that does not must not
    // be able to crash the tick through this loop either.
    const sampler: QteSampler = {
      async sample() {
        throw new Error('EngineCaptureError: stale-frame');
      },
    };
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out).toEqual({ ok: false, reason: 'capture-failed' });
    expect(presses).toHaveLength(0);
  });

  it('refuses a misconfigured budget or clock before sampling', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler([{ atMs: 0, markerX: 700 }], clock);
    const { press, presses } = recordingPress(clock);
    const base = {
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60,
    };

    // A non-positive or non-finite budget makes the loop unbounded; a non-finite clock makes every
    // deadline meaningless. Both are refused at entry, in the same spirit as planTap's guards.
    for (const budgetMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await timeQte({ ...base, budgetMs })).toEqual({ ok: false, reason: 'misconfigured' });
    }
    expect(await timeQte({ ...base, now: () => Number.NaN, budgetMs: 4000 }))
      .toEqual({ ok: false, reason: 'misconfigured' });

    // Refused before the first sample: nothing was looked at and nothing was pressed.
    expect(sampler.passedPrevious).toHaveLength(0);
    expect(presses).toHaveLength(0);
  });

  it('stops with no-velocity when the budget ends before a third reading', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 1_200, markerX: 720 },   // the second sample crosses the 1 000 ms budget
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 1000,
    });

    expect(out).toEqual({ ok: false, reason: 'no-velocity' });
    expect(presses).toHaveLength(0);
  });

  it('stops with no-reachable-zone when every centre is behind the marker', async () => {
    // A steady 606 px/s from 1 200: every zone centre is already behind the predicted stop and the
    // late landing is past the right zone's margin and the reversal, so planTap and the late press
    // both refuse — a speed without a reachable centre, inside the budget.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      Array.from({ length: 40 }, (_, index) => ({
        atMs: index * SAMPLE_CADENCE_MS,
        markerX: 1_200 + index * 20,
      })),
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 240,
    });

    expect(out).toEqual({ ok: false, reason: 'no-reachable-zone' });
    expect(presses).toHaveLength(0);
  });

  it('reads the last position, unsettled, when the marker is still moving at the rest deadline', async () => {
    const clock = virtualClock(0);
    const scripted = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        // The rest read: one distinct reading every 50 ms, so no two ever agree within 2 px.
        ...Array.from({ length: 40 }, (_, index) => ({
          atMs: 700 + index * 50,
          markerX: 900 + index * 20,
        })),
      ],
      clock,
    );
    const handed: number[] = [];
    const sampler: QteSampler = {
      async sample(previousMarkerX?: number) {
        const sample = await scripted.sample(previousMarkerX);
        if (sample.ok) handed.push(sample.reading.markerX);
        return sample;
      },
    };
    const { press } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Nothing settled inside REST_READ_MS: report the last place it was seen, not null.
    expect(out.restX).not.toBeNull();
    expect(out.restX).toBe(handed[handed.length - 1]);
    // But name it for what it is: the marker was still moving when the window closed, so this
    // position is not a rest and the `qteDecelPxPerS2` fit must not read it as one.
    expect(out.restSettled).toBe(false);
    // Every sleep after the plan's is a restart-poll, not a spin on an instant sampler.
    expect(clock.waits.length).toBeGreaterThan(1);
    expect(clock.waits.slice(1).every((ms) => ms === 16)).toBe(true);
  });

  it('never reads the rest position past the budget plus the settle window', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 700 },
        { atMs: 33, markerX: 720 },
        { atMs: 66, markerX: 740 },
        // A marker that keeps moving after a press which itself completed past the budget.
        ...Array.from({ length: 20 }, (_, index) => ({
          atMs: 4_500 + index * 50,
          markerX: 900 + index * 20,
        })),
      ],
      clock,
    );
    const { press } = recordingPress(clock);
    const pressPastBudget = async () => {
      clock.advanceTo(4_500);   // the actuator's press completes 500 ms past the 4 000 ms budget
      return { ok: true as const };
    };

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press: pressPastBudget,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The limit is the call's start + budget + REST_READ_MS: readings at 4 500, 4 550 and 4 600 ms
    // fit, the next one would not. Without the clamp the read would run to 5 100 ms and report 1 140.
    expect(out.restX).toBe(940);
  });
});

// ---------------------------------------------------------------------------------------------
// bandSampler — the one place the crop, its origin and `parseQte` meet
// ---------------------------------------------------------------------------------------------

describe('bandSampler', () => {
  it('bandSampler reads the shipped still through its crop', async () => {
    const full = await jpegFrame('frame-3.jpg', 1_000);   // marker 889.5, the fixture's zones
    const sample = await bandSampler(bandOnlySource(full)).sample();

    expect(sample).toMatchObject({
      ok: true,
      reading: { markerX: 889.5, zones: [{ from: 696, to: 920 }, { from: 999, to: 1223 }], enabled: true },
    });
    // The stamp is the frame's clock, never the sampler's own `now()` (contracts §7).
    if (sample.ok) expect(sample.reading.atMs).toBe(1_000);
  });

  it('falls back to capture() when the source has no band capture', async () => {
    const full = await jpegFrame('frame-3.jpg', 1_000);
    let captures = 0;
    const source: FrameSource = {
      capture: async () => {
        captures += 1;
        return full;
      },
    };

    const sample = await bandSampler(source).sample();

    expect(captures).toBe(1);
    // A full frame is read at its own origin: no `origin` is handed to `parseQte`, which would
    // otherwise refuse the 1920×1080 frame as an unsupported crop.
    expect(sample).toMatchObject({ ok: true, reading: { markerX: 889.5, zones: ZONES, enabled: true } });
  });

  it('reports capture-failed when the capture throws, rather than bar-gone', async () => {
    const full = await jpegFrame('frame-3.jpg', 1_000);

    // A band capture that throws (a stale frame, a refused crop) and a full capture that throws
    // are the same fact to this sampler: we could not look.
    expect(await bandSampler(bandOnlySource(full, { rejects: true })).sample())
      .toEqual({ ok: false, reason: 'capture-failed' });

    const broken: FrameSource = {
      capture: async () => {
        throw new Error('EngineCaptureError: timeout');
      },
    };
    expect(await bandSampler(broken).sample()).toEqual({ ok: false, reason: 'capture-failed' });
  });

  it('reports a decode or size refusal as capture-failed, not bar-gone', async () => {
    const window = qteWindow({ width: 1920, height: 1080 });

    // A crop of the right size whose pixels cannot be decoded: parseQte says `decode-failed`, which
    // is a fact about our own eyes, not about the screen.
    const undecodable: FrameSource = {
      capture: async () => {
        throw new Error('bandSampler fell back to capture()');
      },
      captureBand: async () => ({
        atMs: 1_000,
        width: window.width,
        height: window.height,
        toRgba: async () => {
          throw new Error('GDI+ could not decode the crop');
        },
      }),
    };
    expect(await bandSampler(undecodable).sample())
      .toEqual({ ok: false, reason: 'capture-failed' });

    // A crop that is not the rectangle qteWindow asked for: `unsupported-size`, also our eyes. The
    // wrong-size frame is refused from its declared size, before its decode.
    const wrongSize: FrameSource = {
      capture: async () => {
        throw new Error('bandSampler fell back to capture()');
      },
      captureBand: async () => ({
        atMs: 1_000,
        width: window.width,
        height: window.height - 1,
        toRgba: async () => ({
          data: new Uint8Array(window.width * (window.height - 1) * 4),
          width: window.width,
          height: window.height - 1,
        }),
      }),
    };
    expect(await bandSampler(wrongSize).sample())
      .toEqual({ ok: false, reason: 'capture-failed' });

    // A crop of the right size that simply has no bar is still a fact about the screen: `bar-gone`.
    const noBar: FrameSource = {
      capture: async () => {
        throw new Error('bandSampler fell back to capture()');
      },
      captureBand: async () => ({
        atMs: 1_000,
        width: window.width,
        height: window.height,
        toRgba: async () => ({
          data: new Uint8Array(window.width * window.height * 4),
          width: window.width,
          height: window.height,
        }),
      }),
    };
    expect(await bandSampler(noBar).sample()).toEqual({ ok: false, reason: 'bar-gone' });
  });

  it('detects, plans and presses the live narrow zone pair', async () => {
    // The bar the live 2026-10-25 chest drew after 爱丽丝 (陷阱解除 43): 39 px zones, a 264 px gap,
    // the same centres and 解除 control. Its width is a stat, so the loop reads the measured zones
    // and times the marker's speed against their centres — it never refuses a bar for being
    // narrower than the recorded fixture.
    const base = narrowBarBase(await (await jpegFrame('frame-0.jpg', 0)).toRgba());
    const clock = virtualClock(0);
    const readings: ReadonlyArray<{ atMs: number; markerX: number }> = [
      { atMs: 0, markerX: 700 },
      { atMs: 33, markerX: 720 },
      { atMs: 66, markerX: 740 },
    ];
    let index = 0;
    const source: FrameSource = {
      capture: async () => {
        throw new Error('bandSampler fell back to capture()');
      },
      captureBand: async (rect) => {
        // The first three samples move; every sample after the press is the marker parked at 900.
        const reading = index < readings.length
          ? readings[index]!
          : { atMs: clock.now(), markerX: 900 };
        index += 1;
        const image = { data: Uint8Array.from(base.data), width: base.width, height: base.height };
        paintMarker(image, reading.markerX);
        const cropped = cropBgra(image.data, image.width, image.height, rect);
        clock.advanceTo(reading.atMs + 10);
        return {
          atMs: reading.atMs,
          width: cropped.width,
          height: cropped.height,
          toRgba: async () => ({ data: cropped.pixels, width: cropped.width, height: cropped.height }),
        };
      },
    };
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler: bandSampler(source), now: clock.now, wait: clock.wait, press,
      latencyMs: 60, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.v).toBeCloseTo(606, 0);
    // 808 is the measured left zone's centre — (789 + 827) / 2 — the same x the wide fixture has.
    expect(out.target).toBe(808);
    expect(out.tapX).toBe(740);
    expect(out.atMs).toBeCloseTo(52.2, 1);
    expect(presses).toHaveLength(1);
    expect(out.restX).toBe(900);
    expect(out.restSettled).toBe(true);
  });
});
