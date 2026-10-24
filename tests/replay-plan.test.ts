import { describe, expect, it } from 'vitest';
import type { TapPlan } from '../src/contracts.ts';
import { BOUNCE_LEFT_X, BOUNCE_RIGHT_X, planTap } from '../src/policy/qte.ts';
import {
  PLAN_PRESS_TOLERANCE_PX,
  inFreeFlight,
  planProblem,
  type PlanReading,
} from '../scripts/replay.ts';

/**
 * The plan check's decision on its own, without the decode. `planProblem` is the only place that
 * decides a returned plan is wrong, so these tests are what make the check's sensitivity real: the
 * integration test can only say "the recording produced no violations", and a check that never
 * fires would say that too.
 *
 * The inputs are synthetic on purpose. The recording's 51 plans are all legal, so a violation can
 * only be shown by constructing one; the constants, though, are the real ones — the planner's own
 * reversal points, and the tolerance the recording's measured residuals set (12 px). The press
 * residuals are literal numbers, not `PLAN_PRESS_TOLERANCE_PX ± 1`, so widening the constant cannot
 * quietly keep them green; the absolute pin below is what makes those literals meaningful.
 */

/** `measurements.json`'s bar: the columns a plan's target must fall inside. */
const RECORDED_ZONES = [
  [694, 922],
  [997, 1223],
] as const;

/** The parsed fill interiors the recording's parser produced, 0–11 px inside the recorded columns. */
const PARSED_ZONES = [
  { from: 696, to: 919 },
  { from: 1000, to: 1223 },
] as const;

/** The planner's real reversal points, read from the policy so a swap moves the test with it. */
const BOUNCE = { left: BOUNCE_LEFT_X, right: BOUNCE_RIGHT_X } as const;

const TAP = { latencyMs: 75, decelPxPerS2: 3_000, horizonMs: 1_000 } as const;

/** A reading at the plan's own instant, carrying the recording's zones and the measured speed. */
function reading(overrides: Partial<PlanReading> = {}): PlanReading {
  return { atMs: 1_000, markerX: 800, v: 610, zones: RECORDED_ZONES, ...overrides };
}

/** A real rightward plan taken at `markerX`, and the press position its own formula predicts. */
function rightwardPlan(markerX = 800): { readonly plan: TapPlan; readonly pressX: number } {
  const plan = planTap({ markerX, v: 610, zones: PARSED_ZONES, ...TAP });
  if (plan === null) throw new Error('the test input must plan');
  return { plan, pressX: markerX + 610 * (plan.atMs / 1_000) };
}

/**
 * The reading nearest the plan's press instant, offset by `residualPx`. The prediction is evaluated
 * at the reading's own time (`next.atMs − reading.atMs`), so this reading measures exactly
 * `residualPx`, whatever the plan's delay was.
 */
function readingAfter(plan: TapPlan, pressX: number, residualPx: number): { atMs: number; markerX: number } {
  return { atMs: 1_000 + plan.atMs, markerX: pressX + residualPx };
}

describe('the press-position tolerance', () => {
  it('is pinned absolutely at 12 px, so widening it must change a test', () => {
    // An explicit pin, not a value the boundary cases derive from: `scripts/replay.ts` and
    // `docs/status.md` claim this bound and the ~27 px speed-error sensitivity it leaves, and a
    // pure widening (20 → 30/50/100) used to keep every unit test green while making both claims
    // false.
    expect(PLAN_PRESS_TOLERANCE_PX).toBe(12);
  });
});

describe('planProblem', () => {
  it('accepts a plan whose target and predicted press position fit the recording', () => {
    const { plan, pressX } = rightwardPlan();

    expect(planProblem(reading(), plan, readingAfter(plan, pressX, 0), BOUNCE)).toEqual({
      problem: null,
      compared: true,
    });
  });

  it('names a target outside the recorded zones', () => {
    // 950 is the danger gap: outside both recorded columns (research-qte-parser §4).
    const plan: TapPlan = { atMs: 100, target: 950 };

    expect(planProblem(reading(), plan, null, BOUNCE)).toEqual({
      problem: 'plan target 950 is not inside a recorded zone',
      compared: false,
    });
  });

  it("fires past the planner's reversal, not the recording's zone edge", () => {
    // The zones are drawn wider than the bar so the target can sit in the 1224–1261.5 strip. A
    // target at 1250 is past the recorded zone edge (1223) but inside the planner's real
    // reversal (1261.5): it is legal, and a check that went back to the zone edges would reject
    // it. A target at 1270 is past both and must fire, naming the real reversal.
    const zones = [
      [694, 922],
      [997, 1_300],
    ] as const;
    const legal: TapPlan = { atMs: 100, target: 1_250 };
    const past: TapPlan = { atMs: 100, target: 1_270 };

    expect(planProblem(reading({ zones }), legal, null, BOUNCE)).toEqual({
      problem: null,
      compared: false,
    });
    expect(planProblem(reading({ zones }), past, null, BOUNCE)).toEqual({
      problem: "plan target 1270 is past the planner's reversal at 1261.5 for rightward travel",
      compared: false,
    });
  });

  it("fires past the planner's leftward reversal", () => {
    const zones = [
      [600, 922],
      [997, 1_223],
    ] as const;
    const past: TapPlan = { atMs: 100, target: 640 };

    expect(planProblem(reading({ v: -610, zones }), past, null, BOUNCE)).toEqual({
      problem: "plan target 640 is past the planner's reversal at 656.5 for leftward travel",
      compared: false,
    });
  });

  it('fires one pixel past the 12 px tolerance and accepts one pixel inside it', () => {
    const { plan, pressX } = rightwardPlan();

    const outside = planProblem(reading(), plan, readingAfter(plan, pressX, 13), BOUNCE);
    expect(outside.problem).toMatch(
      /plan predicts x=.* at its press reading, the recording reads .* \(13\.0 px off, tolerance 12 px\)/,
    );
    expect(outside.compared).toBe(true);

    expect(planProblem(reading(), plan, readingAfter(plan, pressX, 11), BOUNCE)).toEqual({
      problem: null,
      compared: true,
    });
  });

  it('fires at ~27 px, the residual a 10 % speed error leaves on a 450 ms plan', () => {
    // The recording's longest checked plans run ~450 ms. A 10 % error in v displaces the prediction
    // by 0.1 · 610 px/s · 0.45 s ≈ 27 px, so a 27 px residual has to fire or the speed-error
    // sensitivity `docs/status.md` claims is gone.
    const { plan, pressX } = rightwardPlan(729);
    expect(plan.atMs).toBeGreaterThan(440);
    expect(plan.atMs).toBeLessThan(460);

    const outside = planProblem(
      reading({ markerX: 729 }),
      plan,
      readingAfter(plan, pressX, 27),
      BOUNCE,
    );
    expect(outside.problem).toContain('(27.0 px off, tolerance 12 px)');
    expect(outside.compared).toBe(true);
  });

  it('skips the press-position check when no reading is near the press instant', () => {
    // The last plans of a pass can name an instant after the bar went away; they are unchecked,
    // not violations (the replay counts them as such).
    const { plan } = rightwardPlan();

    expect(planProblem(reading(), plan, null, BOUNCE)).toEqual({ problem: null, compared: false });
  });

  it('skips a plan whose nearest reading is its own reading, and does not count it', () => {
    // A press instant within half a frame of the plan's own reading resolves back to that reading.
    // Predicting its position from itself is a tautology — the residual is 0 by construction — so
    // the recording's six such plans are unchecked, never compared.
    const { plan } = rightwardPlan();

    expect(
      planProblem(reading(), plan, { atMs: 1_000, markerX: 800 }, BOUNCE),
    ).toEqual({ problem: null, compared: false });
  });

  it("leaves a nonsense delay to planTap's own contract", () => {
    // The delay branches were dropped because planTap never returns a plan outside its horizon.
    // This is the contract that drop relies on, pinned from both directions: every plan it returns
    // is inside [0, horizon] ...
    for (const markerX of [660, 700, 800, 900, 1_000, 1_100, 1_200, 1_250]) {
      for (const v of [610, -610]) {
        const plan = planTap({ ...TAP, markerX, v, zones: PARSED_ZONES, horizonMs: 250 });
        if (plan === null) continue;
        expect(Number.isFinite(plan.atMs)).toBe(true);
        expect(plan.atMs).toBeGreaterThanOrEqual(0);
        expect(plan.atMs).toBeLessThanOrEqual(250);
      }
    }
    // ... and a target it cannot reach inside the horizon is refused (null), not clamped into it.
    expect(planTap({ ...TAP, markerX: 800, v: 610, zones: PARSED_ZONES, horizonMs: 100 })).toBeNull();
  });
});

/**
 * Free flight ends at the first recorded step slower than the easing floor, not two steps later.
 * A plan landing one frame after braking onset must be unchecked, or its ~107 px braking residual
 * is reported as a plan violation: the recording's post-press steps are 8, 8, 8, 0 px, so a
 * two-step rule still lets a plan whose press instant is the first of them be compared.
 */
describe('inFreeFlight', () => {
  /** Readings at 30 fps: 20 px per step is flight (~610 px/s), 8 px is braking (~240 px/s). */
  const series = (...xs: number[]): { atMs: number; markerX: number }[] =>
    xs.map((markerX, index) => ({ atMs: Math.round((index * 1_000) / 30), markerX }));

  it('ends flight at the first braking step, and stays out one frame later', () => {
    // 800 → 820 → 840 is flight; the 840 → 848 step is the first braking one (8 px in 33 ms).
    const readings = series(800, 820, 840, 848, 856);

    // A press instant one frame before onset is still flight.
    expect(inFreeFlight(readings, 0, 67)).toBe(true);
    // At onset, and one frame after it (where the old two-step rule still said "flight"), it is
    // not: the marker the plan predicts a straight line for has already been braked.
    expect(inFreeFlight(readings, 0, 100)).toBe(false);
    expect(inFreeFlight(readings, 0, 133)).toBe(false);
  });

  it('does not mistake an isolated duplicate frame for braking onset', () => {
    // Research §5's duplicate frames: a 0 px step followed by a 20 px one — the marker resumes
    // flight, so the step is a repeated image, not the operator's press. The real slow step after
    // it is still braking onset.
    const readings = series(800, 800, 820, 828);

    expect(inFreeFlight(readings, 0, 67)).toBe(true);
    expect(inFreeFlight(readings, 0, 100)).toBe(false);
  });

  it('keeps a window with no slow step in free flight', () => {
    expect(inFreeFlight(series(800, 820, 840), 0, 67)).toBe(true);
  });
});
