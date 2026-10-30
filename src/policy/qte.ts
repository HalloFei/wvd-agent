/**
 * QTE timing: `planTap` schedules the press that lands the marker on a zone centre (contracts §7),
 * and `qteVelocity` measures the marker's speed from three frames (research §8).
 *
 * The model, measured on the recorded chest (research §8, spec §3):
 *
 * ```
 * stop_x = markerX + v·delay + v·L + sign(v)·v²/(2a)
 * ```
 *
 * `L` is the input latency (`qteLatencyMs`, measured 48.7–67.2 ms), `a` is the post-tap slide
 * (`qteDecelPxPerS2`, provisional 3000, one-sample support 2740–3100), and the slide term carries
 * the sign of motion because the marker keeps sliding the way it was going — get the sign wrong and
 * a leftward plan aims 62 px past the zone on a 610 px/s chest.
 *
 * Two things the signature of contracts §7 cannot express, and where they live instead:
 *
 * - **`atMs` is a delay, not a timestamp.** `planTap` is given no clock (§0.4: the frame carries the
 *   only clock), so it answers "press this many ms from now"; the caller adds it to `frame.atMs`.
 * - **The minimum window is the caller's gate.** Contracts §7 refuses "a window shorter than
 *   `qteMinWindowMs`", but that value is config the planner never sees. The caller
 *   (`actions/qte.ts`) measures what is left of the plan's instant from its own clock —
 *   `reading.atMs + plan.atMs - now()` — against `qteMinWindowMs` (150 ms); a pass tighter than
 *   that is dropped without a press, and the sub-loop re-plans on the next reading inside the same
 *   pass (the reading stays in its rolling window).
 *
 * The bounce points are the marker's *core-centre* reversals, not the zone edges: 656.5 and 1261.5
 * on the recorded bar, ~40 px outside each zone, off the bar's end caps (research §5, §12 item 1;
 * spec §3). A planner that clamps at the zone edges (694 / 1224, as `measurements.json` says)
 * schedules taps into a reversal it does not model.
 */
import type { QteZone, TapPlan } from '../contracts.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/**
 * The marker's reversal points in 1920×1080 device pixels — the extreme core centres of the one
 * recorded bar (frames 28 and 58: 656.5 and 1261.5, research §11). **One recording**, and the bar's
 * own frame may move between chests; the plan therefore treats only targets outside these points
 * as unreachable, which is the conservative direction (it waits a pass rather than crossing one).
 *
 * Exported because the replay's plan check judges a plan against the same reversal the planner
 * used. The recorded `bar` rectangle's edges (694 / 1224) are the zone edges, ~40 px inside these
 * points; a check that used them would test a different reversal than the one the plan avoids.
 */
export const BOUNCE_LEFT_X = 656.5;
export const BOUNCE_RIGHT_X = 1261.5;

/** Three 30 fps frames span 66 ms; two carry a 5.8 % worst-case velocity error (research §8). */
const VELOCITY_MIN_BASELINE_MS = 66;

/**
 * Below this the marker is easing within ~5 frames of a bounce and `v` is not meaningful — the
 * research's `|Δx| < 10 px per 30 fps frame`, expressed as a speed so a slower loop keeps the same
 * meaning. **One recording:** a chest that genuinely runs below 300 px/s (the slow chest measured
 * 488) would never yield a speed, and the policy would have to fall back to a fixed-speed estimate.
 *
 * Exported because the replay's plan check uses the same threshold to find where the recording's
 * marker left free flight: a plan whose window crosses a step this slow is not comparable with a
 * straight line, so the floor is one fact, not two copies that could drift.
 */
export const VELOCITY_EASED_FLOOR_PX_PER_S = 300;

// ---------------------------------------------------------------------------------------------
// The brake model (2026-10-31)
// ---------------------------------------------------------------------------------------------

/** The speed the brake acceleration is quoted at: the recorded bar's steady speed (research §8). */
export const BRAKE_REFERENCE_PX_PER_S = 610;

/**
 * How the brake acceleration scales with speed: `a(v) = aRef · (|v| / vRef)^exponent`.
 *
 * **1, from the recording.** The 2026-10-24 `qte.mp4` is the one recording that contains a stop
 * (the operator's press). Frame by frame (30 fps, 1920x1080, extracted to `.tmp/qtefull/`), the
 * marker runs at 600-630 px/s, then at the press frame — 841.5 px — the speed collapses and glides:
 * 240, 240, 225, 180, 165, 135, 120, 120, 60, 60, 60, 30, 30, 0 px/s over 15 frames, parking at
 * 909.5 px. The brake is **not a constant deceleration**: the first frame loses ~370 px/s
 * (~12 000 px/s²) and the tail decays with a ≈ 450 px/s². The shape is exponential — the speed
 * proportional to itself — i.e. `a(v) ∝ v`, which is this exponent. The carry is 68 px at
 * 610 px/s, i.e. a brake time tau = 68 / 610 = 0.112 s.
 *
 * The exponent is a measurement, not a preference: the corpus has one stop, so it is one speed's
 * worth of evidence. A stop recorded at a second speed (the live bars run at 470-500 px/s) decides
 * whether 1 holds; the fitting procedure is in `brakeDistancePx`.
 */
export const BRAKE_SPEED_EXPONENT = 1;

/** `a(v)` in px/s²: the reference acceleration scaled by the speed. */
export function brakeAccelerationPxPerS2(v: number, aRefPxPerS2: number): number {
  const speed = Math.abs(v);
  if (!Number.isFinite(speed) || !Number.isFinite(aRefPxPerS2)) return Number.NaN;
  return aRefPxPerS2 * Math.pow(speed / BRAKE_REFERENCE_PX_PER_S, BRAKE_SPEED_EXPONENT);
}

/** The brake time, seconds: `t = |v| / a(v)`. With the exponent 1 this is a constant tau. */
export function brakeTimeS(v: number, aRefPxPerS2: number): number {
  const speed = Math.abs(v);
  const acceleration = brakeAccelerationPxPerS2(speed, aRefPxPerS2);
  if (!(speed > 0) || !(acceleration > 0) || !Number.isFinite(acceleration)) return 0;
  return speed / acceleration;
}

/**
 * How far the marker carries after the press — the operator's rule, *brake distance = speed x brake
 * time*: `d = |v| · t` with `t = |v| / a(v)`. At the exponent 1 that is `d = |v| · tau`: a carry
 * proportional to speed, which is what the recorded stop shows (68 px at 610 px/s).
 *
 * **Fitting one stop:** the carry is `rest_x - tap_x - v · (delay + latency)`; then
 * `tau = carry / |v|` and `aRef = vRef / tau`. The 2026-10-24 stop gives tau = 0.112 s, so
 * aRef ≈ 5 450; the plan uses 6 000 — the same carry as the old constant-deceleration term at
 * 610 px/s (`v² / (2 · 3000)` = 62 px) — so every plan at the recorded speed is unchanged and the
 * speed dependence is the new part.
 */
export function brakeDistancePx(v: number, aRefPxPerS2: number): number {
  return Math.abs(v) * brakeTimeS(v, aRefPxPerS2);
}

// ---------------------------------------------------------------------------------------------
// planTap (contracts §7)
// ---------------------------------------------------------------------------------------------

export interface PlanTapInput {
  readonly markerX: number;
  readonly v: number;
  readonly zones: readonly QteZone[];
  readonly latencyMs: number;
  readonly decelPxPerS2: number;
  readonly horizonMs: number;
}

/**
 * Solve `markerX + v·delay + v·L + sign(v)·v²/(2a) = zone centre` for the soonest reachable zone.
 *
 * Refusal (`null`) means "no pass is feasible in this horizon": the marker is not moving, every
 * centre is behind it, every centre lies past a bounce in the direction of travel, or the press
 * would fall beyond `horizonMs` — in which case the policy waits for the next pass (spec §8a: the
 * marker bounces forever and passes are free until an attempt is spent).
 */
export function planTap(input: PlanTapInput): TapPlan | null {
  const { markerX, v, zones, latencyMs, decelPxPerS2, horizonMs } = input;

  // A non-answer from perception must not become a NaN press. `decelPxPerS2 ≤ 0` would divide by 0.
  if (!Number.isFinite(markerX) || !Number.isFinite(v) || v === 0) return null;
  if (!Number.isFinite(latencyMs) || !Number.isFinite(decelPxPerS2) || decelPxPerS2 <= 0) return null;
  if (!Number.isFinite(horizonMs) || horizonMs < 0) return null;

  // The carry is the brake model's, not an inline constant deceleration: `decelPxPerS2` keeps its
  // measured meaning (the uniform-deceleration fit), and the model's reference acceleration is twice
  // it, which is the same carry at the recorded speed under `d = v · t` (see `brakeDistancePx`).
  const lead = v * (latencyMs / 1_000) + Math.sign(v) * brakeDistancePx(v, 2 * decelPxPerS2);
  const reversal = v > 0 ? BOUNCE_RIGHT_X : BOUNCE_LEFT_X;
  const horizonS = horizonMs / 1_000;

  let soonest: TapPlan | null = null;
  for (const zone of zones) {
    if (!Number.isFinite(zone.from) || !Number.isFinite(zone.to)) continue;
    const target = (zone.from + zone.to) / 2;

    // The marker travels from where it is to the target without crossing a reversal: the current
    // pass is the half-line it is moving along, ending at the bounce.
    if (v > 0 ? target < markerX || target > reversal : target > markerX || target < reversal) continue;

    const delayS = (target - markerX - lead) / v;
    if (!Number.isFinite(delayS) || delayS < 0 || delayS > horizonS) continue;
    if (soonest === null || delayS * 1_000 < soonest.atMs) {
      soonest = { atMs: delayS * 1_000, target };
    }
  }

  return soonest;
}

// ---------------------------------------------------------------------------------------------
// qteVelocity (research §8)
// ---------------------------------------------------------------------------------------------

/** A marker reading, on the frame's clock. */
export interface QteSample {
  readonly atMs: number;
  readonly markerX: number;
}

/**
 * The marker's speed in px/s from three frames spanning at least 66 ms, or `null` when the samples
 * cannot support a number: a baseline shorter than 66 ms, a reversal between them, a marker that is
 * easing near a bounce, or a duplicated frame (which a naive two-point estimator turns into 0 then
 * 1215 px/s — research §5's duplicate frames 9 and 101).
 *
 * The velocity is signed: its sign is the direction of travel, which is what `planTap`'s slide term
 * needs.
 */
export function qteVelocity(previous: QteSample, last: QteSample, now: QteSample): number | null {
  if (!Number.isFinite(previous.atMs) || !Number.isFinite(last.atMs) || !Number.isFinite(now.atMs)) {
    return null;
  }
  const firstS = (last.atMs - previous.atMs) / 1_000;
  const secondS = (now.atMs - last.atMs) / 1_000;
  // The clock must strictly advance; a repeated timestamp carries no interval to divide by.
  if (!(firstS > 0) || !(secondS > 0)) return null;
  if (now.atMs - previous.atMs < VELOCITY_MIN_BASELINE_MS) return null;

  const first = last.markerX - previous.markerX;
  const second = now.markerX - last.markerX;
  // A sign change, or a zero step from a duplicated frame, is not a speed — wait a frame.
  if (first * second < 0) return null;
  if (Math.abs(first) / firstS < VELOCITY_EASED_FLOOR_PX_PER_S) return null;
  if (Math.abs(second) / secondS < VELOCITY_EASED_FLOOR_PX_PER_S) return null;

  return (now.markerX - previous.markerX) / (firstS + secondS);
}
// ---------------------------------------------------------------------------------------------
// The attempt-vs-reroll policy (the operator's rule, 2026-10-31)
// ---------------------------------------------------------------------------------------------

/**
 * One pass of the bar, as the policy judges it: how long the marker spends crossing the zone the
 * plan aims at. A slower marker or a wider zone is a longer pass, and a longer pass is the better
 * bar to take.
 */
export interface QtePass {
  readonly windowMs: number;
  readonly speedPxPerS: number;
}

/** What to do with the bar in front of us. */
export type QtePassChoice = 'press' | 'reroll' | 'give-up';

/** What this chest's QTE has seen: the recorded baseline passes, and the rerolls spent. */
export interface QteRerollState {
  /** Rerolls spent on this chest (a cancelled QTE, not an attempt — chest §4). */
  readonly rerolls: number;
  /** `worlds.wvd.maxRerolls`: 5. A ceiling, never a quota — the first good pass ends it. */
  readonly budget: number;
}

/**
 * The operator's rule (2026-10-31, refined the same day): **judge each open or reroll on its own
 * pass — press if this pass can succeed, reroll if it cannot — and spend the budget only while that
 * keeps being false.**
 *
 * "Can succeed" is the physics the planner already uses: the marker spends `windowMs` inside the
 * zone the plan aims at, and a press is only schedulable when that window clears `minWindowMs` —
 * the same floor `actions/qte.ts` applies to the lead time. A pass that does not clear it is not
 * gambled on: the QTE is cancelled and an opener re-selected, which changes the marker's speed
 * (chest §4 — a floor chest's cancellation costs no attempt, so the reroll is free).
 *
 * `budget` is `maxRerolls` (five): at most five cancelled bars after the first. An acceptable pass
 * is pressed the moment it appears, so the budget is never spent just because it exists.
 */
export function chooseQtePass(
  pass: QtePass,
  state: QteRerollState,
  minWindowMs: number,
): QtePassChoice {
  if (Number.isFinite(pass.windowMs) && pass.windowMs >= minWindowMs) return 'press';
  return state.rerolls < state.budget ? 'reroll' : 'give-up';
}
