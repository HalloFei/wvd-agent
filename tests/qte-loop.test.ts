import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { bandSampler, timeQte, type QteSampler } from '../src/actions/qte.ts';
import type { Frame, FrameSource, PixelRect, QteZone } from '../src/contracts.ts';
import { cropBgra } from '../src/engine/crop.mjs';

/**
 * The sub-loop's subject is timing, so its tests drive it with a sampler that answers with the
 * numbers a bar would have produced, and a clock that only moves when the loop sleeps or takes a
 * sample. No test here renders a bar: `parseQte` is the pixel parser, and reproducing its idea of a
 * warm run, a 55 %-lit profile and a 6–9 px white core in a timing test would copy the perception
 * module's knowledge into this one. The one place real pixels meet the sampler is
 * `bandSampler`, and the two `bandSampler` tests below use the shipped still for exactly that.
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
 * quietly.
 */
function bandOnlySource(full: Frame): FrameSource {
  return {
    capture: async () => {
      throw new Error('bandSampler called capture() although captureBand exists');
    },
    captureBand: async (rect: PixelRect) => {
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

// ---------------------------------------------------------------------------------------------
// timeQte
// ---------------------------------------------------------------------------------------------

describe('timeQte', () => {
  it('presses once, at the instant the plan named, and reports the fit sample', async () => {
    // marker 20 px per 33 ms → 606 px/s. The left zone's centre (808) is already behind the stop
    // (740 + v·L + v²/2a = 837.6), so the plan aims at the right zone's 1111 and waits 451 ms.
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.v).toBeCloseTo(606, 0);
    expect(out.target).toBe(1111);
    expect(out.tapX).toBe(740);
    // §7: the plan is a delay from the reading's clock, never a timestamp.
    expect(out.atMs).toBeCloseTo(451.1, 0);
    // One sleep, and the press lands on the reading's clock plus the plan's delay — not on
    // `now()` plus the delay, which the 10 ms sample cost would put 10 ms late.
    expect(clock.waits).toHaveLength(1);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 0);   // the reading's clock plus the plan's delay
    expect(out.restX).toBe(900);
    // Every sample after the first is told where the marker was last read — absolute, full-frame.
    expect(sampler.passedPrevious.slice(0, 3)).toEqual([undefined, 700, 720]);
  });

  it('does not press when the plan is shorter than the minimum window, and presses on the next pass', async () => {
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      [
        { atMs: 0, markerX: 664.4 },
        { atMs: 33, markerX: 684.4 },
        // 704.4 plus the 97.58 px lead (v·0.06 + v²/6000) stops 6 px short of 808:
        // (808 − 704.4 − 97.58)/606 ≈ 9.9 ms, under the 150 ms floor.
        { atMs: 66, markerX: 704.4 },
        // A real distance from the next centre: the same speed, 477 ms from the right zone.
        { atMs: 99, markerX: 724.4 },
        { atMs: 600, markerX: 820 },   // the rest read
      ],
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
    });

    // The ~10 ms plan is under the floor and is dropped; the next reading re-plans and presses.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.atMs).toBeGreaterThanOrEqual(150);
      expect(out.restX).toBe(820);
    }
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeGreaterThan(66 + 10);
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 1000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
    });

    // The press happened; a bar that vanished before it parked is not the press's failure.
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.restX).toBeNull();
      expect(out.target).toBe(1111);
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
    });

    expect(out).toEqual({ ok: false, reason: 'press-refused' });
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
});
