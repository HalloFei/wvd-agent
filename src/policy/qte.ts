/**
 * QTE timing: planTap schedules the press that lands the marker on a zone centre (contracts §7), and
 * qteVelocity measures the marker's speed from three frames (research §8).
 *
 * The model, measured on the recorded chest (research §8, spec §3):
 *
 * ~~~
 * stop_x = markerX + v·delay + v·L + sign(v)·carry
 * ~~~
 *
 * L is the input latency — measured per press now (61-76 ms, median 64; the config value is the prior
 * for a bar's first press). The carry is the **slide past the press**: for a bar that has parked, the
 * time measured from its own park (tauS, fed back by the caller); on a bar's first press the measured
 * prior (0.05 s over the recorded parks). One term, one meaning: carry = |v|·tau, so a caller that
 * knows the time passes carryPx = v·tau and a caller that only has a distance passes carryPx itself.
 * There is no fixed brake constant in this module any more (2026-11-06): the old brake model was a
 * one-recording fit (0.1017 s) that the corpus falsified, and the plan's one slide term is measured.
 *
 * The bounce points are the marker's *core-centre* reversals, not the zone edges: 656.5 and 1261.5 on
 * the recorded bar, ~40 px outside each zone, off the bar's end caps (research §5, §12 item 1; spec
 * §3). A planner that clamps at the zone edges (694 / 1224, as measurements.json says) schedules taps
 * into a reversal it does not model.
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
 * used. The recorded bar rectangle's edges (694 / 1224) are the zone edges, ~40 px inside these
 * points; a check that used them would test a different reversal than the one the plan avoids.
 */
export const BOUNCE_LEFT_X = 656.5;
export const BOUNCE_RIGHT_X = 1261.5;

/** Three 30 fps frames span 66 ms; two carry a 5.8 % worst-case velocity error (research §8). */
const VELOCITY_MIN_BASELINE_MS = 66;

/**
 * A bar faster than this is pressed as a **probe** when no measured slide is known (operator,
 * 2026-11-07). Provenance: the corpus the stop model was fitted on ran at 488 and 610 px/s; a live run
 * on 2026-11-07 measured 880-1280 px/s, where every banded plan was refused and every fallback press
 * was early (30+ presses, two 6-pass guards). 750 sits in the gap between the corpus and the live
 * bars, so the model's own recordings still take the banded path. Above the gate the pass is spent
 * measuring the slide rather than guessing it: the press aims the marker at the zone centre on arrival
 * (no carry) so the park that follows is the slide at that speed.
 */
export const PROBE_SPEED_GATE_PX_PER_S = 750;

/**
 * Below this the marker is easing within ~5 frames of a bounce and v is not meaningful — the
 * research's |dx| < 10 px per 30 fps frame, expressed as a speed so a slower loop keeps the same
 * meaning. **One recording:** a chest that genuinely runs below 300 px/s (the slow chest measured
 * 488) would never yield a speed, and the policy would have to fall back to a fixed-speed estimate.
 *
 * Exported because the replay's plan check uses the same threshold to find where the recording's
 * marker left free flight: a plan whose window crosses a step this slow is not comparable with a
 * straight line, so the floor is one fact, not two copies that could drift.
 */
export const VELOCITY_EASED_FLOOR_PX_PER_S = 300;

// ---------------------------------------------------------------------------------------------
// planTap (contracts §7)
// ---------------------------------------------------------------------------------------------

export interface PlanTapInput {
  readonly markerX: number;
  readonly v: number;
  readonly zones: readonly QteZone[];
  readonly latencyMs: number;
  readonly horizonMs: number;
  /**
   * The bar's post-press slide, px, along v's sign: carryPx = |v|·tau. A bar that has parked gives
   * its measured tau; a bar's first press gives the measured prior. **The only carry input**: the
   * module has no fixed brake model (2026-11-06).
   */
  readonly carryPx?: number;
  /** ± uncertainty of the input leg, ms; widens the stop band. */
  readonly latencySpreadMs?: number;
  /** ± uncertainty of the carry, px. */
  readonly carrySpreadPx?: number;
  /** ± uncertainty of the marker's speed, px/s. */
  readonly velocitySpreadPxPerS?: number;
  /**
   * The share of the predicted stop's band that must lie inside a zone for the plan to be returned.
   * 0 (default) is the old exact-point plan; 0.95 is the operator's rule (2026-11-05).
   */
  readonly minOverlap?: number;
}

/**
 * Solve markerX + v·delay + lead = zone centre for the soonest reachable zone, where lead is v·L plus
 * the carry.
 *
 * Refusal (null) means "no pass is feasible in this horizon": the marker is not moving, every centre
 * is behind it, every centre lies past a bounce in the direction of travel, the press would fall
 * beyond horizonMs, or the stop band does not fit a zone to minOverlap — in which case the caller
 * waits for the next pass (spec §8a: the marker bounces forever and passes are free until an attempt
 * is spent) or re-rolls the bar.
 */
export function planTap(input: PlanTapInput): TapPlan | null {
  const {
    markerX, v, zones, latencyMs, horizonMs,
    carryPx, latencySpreadMs = 0, carrySpreadPx = 0, velocitySpreadPxPerS = 0, minOverlap = 0,
  } = input;

  // A non-answer from perception must not become a NaN press.
  if (!Number.isFinite(markerX) || !Number.isFinite(v) || v === 0) return null;
  if (!Number.isFinite(latencyMs)) return null;
  if (!Number.isFinite(horizonMs) || horizonMs < 0) return null;

  // The one slide term: the measured carry for this bar when the caller has one, else nothing.
  const carry = carryPx !== undefined && Number.isFinite(carryPx) ? Math.sign(v) * Math.abs(carryPx) : 0;
  const lead = v * (latencyMs / 1_000) + carry;
  const reversal = v > 0 ? BOUNCE_RIGHT_X : BOUNCE_LEFT_X;
  const horizonS = horizonMs / 1_000;
  const banded = Number.isFinite(minOverlap) && minOverlap > 0;

  let soonest: TapPlan | null = null;
  for (const zone of zones) {
    if (!Number.isFinite(zone.from) || !Number.isFinite(zone.to)) continue;
    const target = (zone.from + zone.to) / 2;

    // The marker travels from where it is to the target without crossing a reversal: the current
    // pass is the half-line it is moving along, ending at the bounce.
    if (v > 0 ? target < markerX || target > reversal : target > markerX || target < reversal) continue;

    const delayS = (target - markerX - lead) / v;
    if (!Number.isFinite(delayS) || delayS < 0 || delayS > horizonS) continue;

    // The predicted stop's band (operator rule 2026-11-05): the input leg's spread over the time it
    // moves, the carry's own spread, and the speed error over the whole lead time. The plan aims the
    // centre, so the band is symmetric about it; a plan is only sent when the band is inside the
    // zone to the required share.
    let bandPx = 0;
    let overlap = 1;
    if (banded) {
      const totalS = delayS + latencyMs / 1_000;
      bandPx = Math.abs(v) * (Math.max(0, latencySpreadMs) / 1_000)
        + Math.max(0, carrySpreadPx)
        + Math.abs(totalS) * Math.max(0, velocitySpreadPxPerS);
      const lo = Math.max(target - bandPx, zone.from);
      const hi = Math.min(target + bandPx, zone.to);
      overlap = bandPx === 0 ? 1 : Math.max(0, hi - lo) / (2 * bandPx);
      if (overlap < minOverlap) continue;
    }
    if (soonest === null || delayS * 1_000 < soonest.atMs) {
      soonest = { atMs: delayS * 1_000, target, bandPx, overlap };
    }
  }

  return soonest;
}

/** The inputs of predictRest: where the marker is, how fast, how old the reading is, and the slide. */
export interface PredictRestInput {
  readonly markerX: number;
  readonly v: number;
  /** How old the reading is when the press would be issued: now() - reading.atMs, milliseconds. */
  readonly ageMs: number;
  readonly latencyMs: number;
  /** The bar's post-press slide, px, along v's sign (the same term planTap takes). */
  readonly carryPx?: number;
}

/**
 * Where the marker parks if the press is issued now: the frame's own age, the input leg and the
 * carry, so
 *
 *   markerX + v·(ageMs + latencyMs)/1000 + sign(v)·|carryPx|
 *
 * The same slide term planTap uses, so a press decided here and a press the planner scheduled answer
 * the same physics: the marker's own speed and the zone it has to land in, never a clock. null is a
 * non-answer (a bad input), never a guess.
 */
export function predictRest(input: PredictRestInput): number | null {
  const { markerX, v, ageMs, latencyMs, carryPx } = input;
  if (!Number.isFinite(markerX) || !Number.isFinite(v) || v === 0) return null;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return null;
  const carry = carryPx !== undefined && Number.isFinite(carryPx) ? Math.sign(v) * Math.abs(carryPx) : 0;
  return markerX + v * ((ageMs + latencyMs) / 1_000) + carry;
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
 * The marker's speed in px/s from three frames spanning at least 66 ms, or null when the samples
 * cannot support a number: a baseline shorter than 66 ms, a reversal between them, a marker that is
 * easing near a bounce, or a duplicated frame (which a naive two-point estimator turns into 0 then
 * 1215 px/s — research §5's duplicate frames 9 and 101).
 *
 * The velocity is signed: its sign is the direction of travel, which is what the plan's slide term
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
