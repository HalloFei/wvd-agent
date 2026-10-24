import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { bandSampler, timeQte, type QteSampler } from '../src/actions/qte.ts';
import type { Frame, FrameSource, PixelRect, QteZone } from '../src/contracts.ts';
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
    // The one pre-press sleep is the plan's: due at 66 + 451.14, asked at 76 (the sample cost).
    expect(clock.waits[0]).toBeCloseTo(441.1, 0);
    expect(presses).toHaveLength(1);
    expect(presses[0]).toBeCloseTo(66 + out.atMs, 0);   // the reading's clock plus the plan's delay
    expect(out.restX).toBe(900);
    // The rest read repeated 900 one cadence later: two readings within the settle tolerance are
    // what makes this a rest (#18's fit must not take a moving sample for one).
    expect(out.restSettled).toBe(true);
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
      expect(out.restSettled).toBe(false);
      expect(out.target).toBe(1111);
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 1000,
    });

    expect(out).toEqual({ ok: false, reason: 'no-velocity' });
    expect(presses).toHaveLength(0);
  });

  it('stops with no-reachable-zone when every centre is behind the marker', async () => {
    // A steady 606 px/s from 1100: every zone centre is already behind the predicted stop, so
    // planTap refuses every pass — a speed without a reachable centre, inside the budget.
    const clock = virtualClock(0);
    const sampler = scriptedSampler(
      Array.from({ length: 40 }, (_, index) => ({
        atMs: index * SAMPLE_CADENCE_MS,
        markerX: 1100 + index * 20,
      })),
      clock,
    );
    const { press, presses } = recordingPress(clock);

    const out = await timeQte({
      sampler, now: clock.now, wait: clock.wait, press,
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 240,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
      latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
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
});
