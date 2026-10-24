import { describe, expect, it } from 'vitest';
import type { TapPlan } from '../src/contracts.ts';
import { BOUNCE_LEFT_X, BOUNCE_RIGHT_X, planTap } from '../src/policy/qte.ts';
import {
  PLAN_PRESS_TOLERANCE_PX,
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
 * reversal points, and the tolerance the recording measured.
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

/** A real rightward plan taken at x = 800, and the press position its own formula predicts. */
function rightwardPlan(): { readonly plan: TapPlan; readonly pressX: number } {
  const plan = planTap({ markerX: 800, v: 610, zones: PARSED_ZONES, ...TAP });
  if (plan === null) throw new Error('the test input must plan');
  return { plan, pressX: 800 + 610 * (plan.atMs / 1_000) };
}

describe('planProblem', () => {
  it('accepts a plan whose target and predicted press position fit the recording', () => {
    const { plan, pressX } = rightwardPlan();
    const next = { atMs: 1_000 + plan.atMs, markerX: pressX };

    expect(planProblem(reading(), plan, next, BOUNCE)).toBeNull();
  });

  it('names a target outside the recorded zones', () => {
    // 950 is the danger gap: outside both recorded columns (research-qte-parser §4).
    const plan: TapPlan = { atMs: 100, target: 950 };

    expect(planProblem(reading(), plan, null, BOUNCE)).toBe(
      'plan target 950 is not inside a recorded zone',
    );
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

    expect(planProblem(reading({ zones }), legal, null, BOUNCE)).toBeNull();
    expect(planProblem(reading({ zones }), past, null, BOUNCE)).toBe(
      "plan target 1270 is past the planner's reversal at 1261.5 for rightward travel",
    );
  });

  it("fires past the planner's leftward reversal", () => {
    const zones = [
      [600, 922],
      [997, 1_223],
    ] as const;
    const past: TapPlan = { atMs: 100, target: 640 };

    expect(planProblem(reading({ v: -610, zones }), past, null, BOUNCE)).toBe(
      "plan target 640 is past the planner's reversal at 656.5 for leftward travel",
    );
  });

  it('fires when the recorded marker is not where the plan predicts at its press instant', () => {
    const { plan, pressX } = rightwardPlan();
    const next = { atMs: 1_000 + plan.atMs, markerX: pressX + PLAN_PRESS_TOLERANCE_PX + 1 };

    expect(planProblem(reading(), plan, next, BOUNCE)).toMatch(
      /plan predicts x=.* at the press instant, the recording reads .*px off, tolerance 20 px/,
    );
  });

  it('accepts a press position inside the measured tolerance', () => {
    const { plan, pressX } = rightwardPlan();
    const next = { atMs: 1_000 + plan.atMs, markerX: pressX + PLAN_PRESS_TOLERANCE_PX - 0.5 };

    expect(planProblem(reading(), plan, next, BOUNCE)).toBeNull();
  });

  it('skips the press-position check when no reading is near the press instant', () => {
    // The last plans of a pass can name an instant after the bar went away; they are unchecked,
    // not violations (the replay counts them as such).
    const { plan } = rightwardPlan();

    expect(planProblem(reading(), plan, null, BOUNCE)).toBeNull();
  });

  it("leaves a nonsense delay to planTap's own contract", () => {
    // The delay branches were dropped because planTap never returns a plan outside its horizon.
    // This is the contract that drop relies on, pinned from both directions. (A planner that
    // returned a nonsense delay would fail here, not in planProblem.)
    for (const markerX of [660, 700, 800, 900, 1_000, 1_100, 1_200, 1_250]) {
      for (const v of [610, -610]) {
        const plan = planTap({ ...TAP, markerX, v, zones: PARSED_ZONES, horizonMs: 250 });
        if (plan === null) continue;
        expect(Number.isFinite(plan.atMs)).toBe(true);
        expect(plan.atMs).toBeGreaterThanOrEqual(0);
        expect(plan.atMs).toBeLessThanOrEqual(250);
      }
    }
  });
});
