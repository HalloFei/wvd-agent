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
 *   `reading.atMs + plan.atMs - now()` — against `qteMinWindowMs` (150 ms) and waits for the next
 *   pass when it is short.
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
 */
const BOUNCE_LEFT_X = 656.5;
const BOUNCE_RIGHT_X = 1261.5;

/** Three 30 fps frames span 66 ms; two carry a 5.8 % worst-case velocity error (research §8). */
const VELOCITY_MIN_BASELINE_MS = 66;

/**
 * Below this the marker is easing within ~5 frames of a bounce and `v` is not meaningful — the
 * research's `|Δx| < 10 px per 30 fps frame`, expressed as a speed so a slower loop keeps the same
 * meaning. **One recording:** a chest that genuinely runs below 300 px/s (the slow chest measured
 * 488) would never yield a speed, and the policy would have to fall back to a fixed-speed estimate.
 */
const VELOCITY_EASED_FLOOR_PX_PER_S = 300;

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

  const lead = v * (latencyMs / 1_000) + Math.sign(v) * ((v * v) / (2 * decelPxPerS2));
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
