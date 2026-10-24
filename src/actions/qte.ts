/**
 * QTE timing, the action: hold the tick's clock long enough to press once on the bar.
 *
 * ## Why this is an action and not a policy
 *
 * `planTap` (`policy/qte.ts`) is pure — marker, speed, zones in, a delay out — and `qteVelocity` is
 * the same kind of thing. Neither has ever had a caller, because the World's 100 ms tick cannot
 * time a bar: at 610 px/s one tick is 61 px of marker travel, 27 % of a 224 px zone. This module is
 * the caller. It owns a clock (`now`), sleeps (`wait`) and sends one press; a policy is a decision
 * taken from an observation and owns none of those. Keeping the loop here is what lets `planTap`
 * stay testable without a bar — and this loop testable without pixels.
 *
 * ## Why the sampler is injected
 *
 * `parseQte` is a real pixel parser: warm runs, a 55 %-lit row profile, a 6–9 px white core, a
 * bright-gap test, a button annulus. A timing test driven through a rendered bar would have to
 * reproduce all of that, so it would pin the perception module's idea of what a bar looks like
 * instead of this module's arithmetic. The seam is `QteSampler` — one reading of the bar, on the
 * frame's own clock — and the scripted tests supply the readings a bar would have produced.
 * `bandSampler` is the production sampler, and the one place the crop rectangle, its origin and
 * `parseQte` meet.
 *
 * ## The trap: `planTap` answers a delay, not an instant
 *
 * `reading.atMs` is the capturing frame's clock, and `plan.atMs` is a delay from *that* reading
 * (contracts §7, and `policy/qte.ts` says so at length). The instant to press is therefore
 * `reading.atMs + plan.atMs` in `now()`'s domain, and the sleep is what remains of it, clamped at
 * zero. Stamping a reading with `now()` instead — or comparing the plan's delay to `now()` — would
 * be wrong by the whole capture latency (~50 ms) against a 150 ms floor.
 *
 * ## What bounds the call
 *
 * `budgetMs` bounds the pre-press loop: a bar that outlives it yields a refusal, and the World's
 * next tick may try again (the marker bounces forever and passes are free, chest spec §8a). The
 * rest read after a successful press has its own `REST_READ_MS` bound — the recorded marker settles
 * in ~500 ms — so a press is not held to a budget it has already spent. `minWindowMs` is the
 * caller's floor over `plan.atMs`: a pass tighter than that is dropped and the next reading
 * re-plans (contracts §7 keeps the floor here, not in the planner). A dimmed 解除 button is
 * `resolved`, not a live pass (chest spec §8a) — nothing is pressed, because this pass was already
 * answered.
 *
 * ## The refusals
 *
 * `bar-gone` is a refused sample; `resolved` a dimmed button; `press-refused` the actuator's
 * answer. The three that end a spent budget are split by what the loop had: `no-velocity` when
 * fewer than three readings arrived (a speed needs three), `no-reachable-zone` when speeds came but
 * `planTap` never found a centre inside the horizon, and `budget-spent` otherwise — including the
 * stream whose readings never form a steady velocity, which is what the recording's duplicate
 * frames produce.
 */
import type { ActionResult, Frame, FrameSource, Point, QteZone } from '../contracts.ts';
import { parseQte, qteWindow } from '../perception/chest.ts';
import { planTap, qteVelocity, type QteSample } from '../policy/qte.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/**
 * How long the rest read may take. It is the recorded marker's observed settle time (~500 ms; the
 * bar outlives the tap by ~3 s), and a module constant rather than config because `budgetMs`
 * already bounds the call: a second key would be a second opinion on the same fact.
 */
const REST_READ_MS = 600;

/** Two consecutive readings this close mean the marker has parked. */
const REST_SETTLE_PX = 2;

/**
 * The only frame size the bar's anchors were measured at (contracts §0.5). A window of another
 * size is refused, never re-scaled: the rectangle below would not be where the bar is.
 */
const REFERENCE_FRAME = { width: 1920, height: 1080 } as const;

/** The bar's band and the 解除 annulus in one rectangle: it does not move between samples. */
const QTE_WINDOW = qteWindow(REFERENCE_FRAME);

// ---------------------------------------------------------------------------------------------
// The contracts (the sub-loop's own seam)
// ---------------------------------------------------------------------------------------------

/** One reading of the bar, on the frame's own clock (contracts §0.4 — timing is data). */
export interface BarReading {
  readonly atMs: number;
  readonly markerX: number;                       // full-frame device pixels
  readonly zones: readonly QteZone[];             // full-frame device pixels
  readonly enabled: boolean;                      // the 解除 button; false means this pass is answered
}

export type BarSample =
  | { readonly ok: true; readonly reading: BarReading }
  | { readonly ok: false; readonly reason: 'bar-gone' };   // the QTE screen is not there any more

export interface QteSampler {
  sample(previousMarkerX?: number): Promise<BarSample>;
}

export type QteRefusal =
  | 'bar-gone'
  | 'resolved'          // the 解除 button reads dimmed: this pass was already answered
  | 'no-velocity'       // samples came, but no three spanned a steady 66 ms before the budget ran out
  | 'no-reachable-zone' // no zone centre can be reached in the current pass, inside the horizon
  | 'budget-spent'      // the bar outlived `budgetMs`
  | 'press-refused';    // the actuator declined the press (not foreground, engine gone)

export interface QteTiming {
  readonly ok: true;
  readonly v: number;             // px/s, signed
  readonly atMs: number;          // the delay planTap asked for, from the reading that produced it
  readonly target: number;        // the zone centre the plan aimed at
  readonly tapX: number;          // the marker's position on the planning reading
  readonly restX: number | null;  // where it parked, when the bar was still there to read
}

export type QteOutcome = QteTiming | { readonly ok: false; readonly reason: QteRefusal };

export interface QteTimingOptions {
  readonly sampler: QteSampler;
  readonly press: () => Promise<ActionResult>;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly latencyMs: number;
  readonly decelPxPerS2: number;
  readonly minWindowMs: number;
  readonly budgetMs: number;
}

// ---------------------------------------------------------------------------------------------
// The sub-loop
// ---------------------------------------------------------------------------------------------

/**
 * Sample the bar until a plan is reachable, sleep to the instant it named, press exactly once, and
 * read where the marker parked. Every path returns a value; nothing throws into the control loop
 * (contracts §0.6). `press` is called at most once, on the single path that survives every gate.
 */
export async function timeQte(options: QteTimingOptions): Promise<QteOutcome> {
  const { sampler, press, now, wait, latencyMs, decelPxPerS2, minWindowMs, budgetMs } = options;

  const startedAtMs = now();
  /** The rolling window `qteVelocity` reads; at most three readings. */
  const lastThree: QteSample[] = [];
  let previousMarkerX: number | undefined;
  let planAttempted = false;
  let planFound = false;

  for (;;) {
    if (now() - startedAtMs >= budgetMs) {
      // Nothing was pressed. Which fact to report is what the loop had not got.
      if (lastThree.length < 3) return { ok: false, reason: 'no-velocity' };
      if (planAttempted && !planFound) return { ok: false, reason: 'no-reachable-zone' };
      return { ok: false, reason: 'budget-spent' };
    }

    const sample = await sampler.sample(previousMarkerX);
    if (!sample.ok) return { ok: false, reason: 'bar-gone' };
    const reading = sample.reading;
    // The dimmed button separates "the QTE is live" from "this pass is answered" without waiting
    // for the screen to change (chest spec §8a).
    if (!reading.enabled) return { ok: false, reason: 'resolved' };

    // From here the reading is accepted: the parser's static-run cross-check wants the last
    // *accepted* marker, never a refused one (research §5).
    previousMarkerX = reading.markerX;
    lastThree.push({ atMs: reading.atMs, markerX: reading.markerX });
    if (lastThree.length > 3) lastThree.shift();
    if (lastThree.length < 3) continue;

    const v = qteVelocity(lastThree[0], lastThree[1], lastThree[2]);
    // No speed yet (a short baseline, a reversal, an eased marker): keep walking the pass.
    if (v === null) continue;

    const remainingMs = Math.max(0, budgetMs - (now() - startedAtMs));
    const plan = planTap({
      markerX: reading.markerX,
      v,
      zones: reading.zones,
      latencyMs,
      decelPxPerS2,
      horizonMs: remainingMs,
    });
    planAttempted = true;
    // No centre is reachable in this pass and horizon: keep sampling; a bounce is free.
    if (plan === null) continue;
    planFound = true;
    // The caller's floor (contracts §7): a late press is worse than no press. The reading stays in
    // the rolling window; only this press is withheld.
    if (plan.atMs < minWindowMs) continue;

    // `plan.atMs` is a delay from the reading's clock, so the instant is absolute in `now()`'s
    // domain. During the wait the budget cannot be overrun: `remainingMs` was the horizon.
    await wait(Math.max(0, reading.atMs + plan.atMs - now()));

    const pressed = await press();
    if (!pressed.ok) return { ok: false, reason: 'press-refused' };

    const restX = await readRest(sampler, previousMarkerX, now);
    return { ok: true, v, atMs: plan.atMs, target: plan.target, tapX: reading.markerX, restX };
  }
}

/**
 * Where the marker parked after the press, or `null` when the bar stopped being readable. Two
 * readings within `REST_SETTLE_PX` mean it has settled; a still-moving marker is reported at the
 * `REST_READ_MS` deadline, where it was last seen. A refusal is not the press's failure: the press
 * happened, the bar just went away (contracts §0.6). This read ignores `enabled` on purpose — the
 * 解除 button reading dimmed is exactly what a successful press looks like.
 */
async function readRest(
  sampler: QteSampler,
  previousMarkerX: number | undefined,
  now: () => number,
): Promise<number | null> {
  const deadlineMs = now() + REST_READ_MS;
  let lastX: number | null = null;
  while (now() <= deadlineMs) {
    const sample = await sampler.sample(previousMarkerX);
    if (!sample.ok) return null;
    const markerX = sample.reading.markerX;
    previousMarkerX = markerX;
    if (lastX !== null && Math.abs(markerX - lastX) <= REST_SETTLE_PX) return markerX;
    lastX = markerX;
  }
  return lastX;
}

// ---------------------------------------------------------------------------------------------
// The production sampler
// ---------------------------------------------------------------------------------------------

/**
 * The production sampler: a band capture when the source has one, the QTE window, and `parseQte`.
 *
 * With a source that can crop, the rectangle asked for is the QTE window of the reference frame —
 * the band plus the 解除 annulus — and the perceiver's size gate makes the crop's origin safe: a
 * crop of another size is `unsupported-size`, never read with the anchors at the wrong place. A
 * source without `captureBand` keeps working: its full frame is parsed at its own origin, and a
 * frame of another size is refused the same way (contracts §0.5). Every refusal — including a
 * foreign window — is one fact to this loop: the bar is not readable.
 *
 * `atMs` is the frame's clock, never `now()`: a reading that lied about its age would be planned
 * against the wrong instant (contracts §7).
 */
export function bandSampler(source: FrameSource): QteSampler {
  return {
    async sample(previousMarkerX?: number): Promise<BarSample> {
      const { frame, origin } = await readFrame(source);
      const parsed = await parseQte(frame, previousMarkerX, origin);
      if (!parsed.ok) return { ok: false, reason: 'bar-gone' };
      return {
        ok: true,
        reading: {
          atMs: frame.atMs,
          markerX: parsed.qte.markerX,
          zones: parsed.qte.zones,
          enabled: parsed.enabled,
        },
      };
    },
  };
}

/** One capture, cropped when the source can crop, with the crop's origin in full-frame pixels. */
async function readFrame(source: FrameSource): Promise<{ frame: Frame; origin?: Point }> {
  if (source.captureBand) {
    return {
      frame: await source.captureBand(QTE_WINDOW),
      origin: { x: QTE_WINDOW.x, y: QTE_WINDOW.y },
    };
  }
  return { frame: await source.capture() };
}
