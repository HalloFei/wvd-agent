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
 * `budgetMs` is the **pre-press** budget: a bar that outlives it yields a refusal, and the World's
 * next tick may try again (the marker bounces forever and passes are free, chest spec §8a). The
 * rest read after a successful press adds its own settle window, `REST_READ_MS`, and is clamped to
 * `budgetMs + REST_READ_MS` from the call's start — so the whole call is bounded by the pre-press
 * budget plus the rest read, never by the budget alone. `minWindowMs` is the caller's floor over the
 * time left to the plan's instant, `reading.atMs + plan.atMs - now()`: a pass tighter than that is
 * dropped and the next reading re-plans (contracts §7 keeps the floor here, not in the planner).
 * The reading's clock is not `now()` — a frame can be up to `FRAME_MAX_AGE_MS` (300 ms) old when it
 * is planned — so the floor has to be taken from what is actually left, not from the plan's own
 * delay. A dimmed 解除 button is `resolved`, not a live pass (chest spec §8a) — nothing is pressed,
 * because this pass was already answered.
 *
 * ## The refusals
 *
 * `bar-gone` is a sample that looked for the bar and did not find it; `capture-failed` is a sample
 * that could not look at all (a capture or a parse that threw, a crop that could not be decoded, or
 * one that is not the rectangle that was asked for). They are different facts on purpose — only the
 * second may reach the tick's failure accounting — and neither is retried here: the World's own
 * capture path owns warm-up retries and the session-end decision, and it runs on the very next
 * tick. `resolved` is a dimmed button; `press-refused` the actuator's answer; `misconfigured` a
 * non-finite or non-positive budget, a non-finite or negative `minWindowMs`, or a non-finite clock,
 * refused before the first sample in the same spirit as `planTap`'s own input guards. The three
 * that end a spent budget are split by what the loop had: `no-velocity` when fewer than three
 * readings arrived (a speed needs three), `no-reachable-zone` when speeds came but `planTap` never
 * found a centre inside the horizon, and `budget-spent` otherwise — including the stream whose
 * readings never form a steady velocity, which is what the recording's duplicate frames produce.
 */
import type { ActionResult, Frame, FrameSource, Point, QteZone } from '../contracts.ts';
import { parseQte, qteWindow, type QteRefusalReason } from '../perception/chest.ts';
import { planTap, qteVelocity, type QteSample } from '../policy/qte.ts';

// ---------------------------------------------------------------------------------------------
// Measured constants
// ---------------------------------------------------------------------------------------------

/**
 * How long the rest read may take. It is the recorded marker's observed settle time (~500 ms; the
 * bar outlives the tap by ~3 s), and a module constant rather than config because it bounds only
 * the rest read: `budgetMs` already bounds the pre-press loop, and the whole call is the budget
 * plus this read.
 */
const REST_READ_MS = 600;

/** The spacing of rest polls: the settle window is measured in reads, not in a hot spin. */
const REST_POLL_MS = 16;

/** Two consecutive readings this close mean the marker has parked. */
const REST_SETTLE_PX = 2;

/**
 * The frame size the bar's anchors were measured at (contracts §0.5). The rectangle below is asked
 * for in these coordinates whatever the client area is: `qteWindow` cannot see the game window, so
 * the 1920×1080 client-size invariant is the composition root's to assert — `WvdWorld#timeQte` does,
 * and refuses any other size (Task 7). Exported so that gate compares against this one fact instead
 * of hard-coding a second copy that could drift.
 */
export const REFERENCE_FRAME = { width: 1920, height: 1080 } as const;

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
  | {
      readonly ok: false;
      /**
       * `bar-gone`: the sample looked for the bar and it is not there. `capture-failed`: the sample
       * could not look at all (a capture or a parse threw, or a crop could not be decoded or was the
       * wrong rectangle) — a different fact, and the one the tick's failure accounting must see.
       */
      readonly reason: 'bar-gone' | 'capture-failed';
    };

export interface QteSampler {
  sample(previousMarkerX?: number): Promise<BarSample>;
}

export type QteRefusal =
  | 'bar-gone'          // a sample looked for the bar and did not find it
  | 'capture-failed'    // the capture or parse threw: we could not look, which is not the same fact
  | 'resolved'          // the 解除 button reads dimmed: this pass was already answered
  | 'no-velocity'       // fewer than three readings arrived before the budget ran out
  | 'no-reachable-zone' // speeds came, but no zone centre was reachable inside the horizon
  | 'budget-spent'      // three readings or more, no press, and nothing more specific to report
  | 'press-refused'     // the actuator declined the press (not foreground, engine gone)
  | 'misconfigured';    // non-finite/non-positive budget or non-finite clock: refused before sampling

export interface QteTiming {
  readonly ok: true;
  readonly v: number;             // px/s, signed
  readonly atMs: number;          // the delay planTap asked for, from the reading that produced it
  readonly target: number;        // the zone centre the plan aimed at
  readonly tapX: number;          // the marker's position on the planning reading
  readonly restX: number | null;  // where it parked, when the bar was still there to read
  /**
   * Whether `restX` is a rest at all: true only when two consecutive readings agreed within the
   * settle tolerance (which includes a marker that was already still when the read began). A marker
   * still moving at the deadline reports its last position with `restSettled: false` — the fit
   * `qteDecelPxPerS2` (#18) makes from `(v, tapX, restX)` must not read a moving sample as a rest.
   */
  readonly restSettled: boolean;
}

export type QteOutcome = QteTiming | { readonly ok: false; readonly reason: QteRefusal };

/**
 * `budgetMs` is the **pre-press** budget. The rest read that follows a successful press adds
 * `REST_READ_MS`, so the whole call is bounded by `budgetMs + REST_READ_MS`; a non-finite or
 * non-positive budget is refused as `misconfigured` rather than run unbounded. `minWindowMs` is the
 * floor over the time remaining to the plan's instant; a non-finite or negative value is refused
 * the same way (zero is a legitimate "no floor").
 */
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

/**
 * The sub-loop as a dependency (contracts §0.2): the World owns *when* — the tick, the clock, the
 * actuator, the session that may end mid-wait — and this owns the timing arithmetic. Injecting it is
 * what lets a test drive the sub-loop without a bar on screen, exactly as `policy`, `classify` and
 * `commands` are injected. `timeQte` is the production realization.
 */
export type QteTimer = (options: QteTimingOptions) => Promise<QteOutcome>;

// ---------------------------------------------------------------------------------------------
// The sub-loop
// ---------------------------------------------------------------------------------------------

/**
 * Sample the bar until a plan is reachable, sleep to the instant it named, press exactly once, and
 * read where the marker parked. Every path returns a value; nothing throws into the control loop
 * (contracts §0.6) — a sampler that throws is `capture-failed`, never a retry. `press` is called at
 * most once, on the single path that survives every gate. The call is bounded by the pre-press
 * budget plus the rest read's settle window.
 */
export async function timeQte(options: QteTimingOptions): Promise<QteOutcome> {
  const { sampler, press, now, wait, latencyMs, decelPxPerS2, minWindowMs, budgetMs } = options;

  // A mis-typed number must not become a press, and an unbounded loop is the one failure this
  // module could not report as a value: refuse both before the first sample. `minWindowMs` belongs
  // in the same guard — `NaN` makes `delayMs < NaN` false and silently disables the one floor
  // between a plan and a gamble, and a negative floor is not a floor. Zero is a floor of zero.
  if (
    !Number.isFinite(budgetMs) || budgetMs <= 0
    || !Number.isFinite(minWindowMs) || minWindowMs < 0
  ) {
    return { ok: false, reason: 'misconfigured' };
  }
  const startedAtMs = now();
  if (!Number.isFinite(startedAtMs)) return { ok: false, reason: 'misconfigured' };
  const restDeadlineLimitMs = startedAtMs + budgetMs + REST_READ_MS;

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

    let sample: BarSample;
    try {
      sample = await sampler.sample(previousMarkerX);
    } catch {
      // "We could not look" is not "the bar is gone": the World's capture path owns warm-up retries
      // and the session-end decision, and it runs on the very next tick. No retry here.
      return { ok: false, reason: 'capture-failed' };
    }
    if (!sample.ok) return { ok: false, reason: sample.reason };
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
    // The floor guards the lead time we can still act on. `plan.atMs` is a delay from the reading's
    // clock (§7), and that clock can already be hundreds of ms old when the plan is made — a frame
    // carries up to `FRAME_MAX_AGE_MS` (300 ms) of age — so a plan whose own delay looks generous
    // can name an instant only a few ms away. Compare what is left from *now*. The old
    // `plan.atMs < minWindowMs` test is subsumed: a reading is stamped before `now()` (contracts
    // §0.4), so `reading.atMs + plan.atMs - now() <= plan.atMs`. A pass tighter than the floor is
    // dropped and the next reading re-plans; the reading stays in the rolling window (contracts §7
    // keeps the floor here, not in the planner).
    const delayMs = reading.atMs + plan.atMs - now();
    if (delayMs < minWindowMs) continue;

    // `delayMs` is already the remaining time, so the wait is exactly it (never negative after the
    // floor) and the budget cannot be overrun: `remainingMs` was the horizon.
    await wait(delayMs);

    const pressed = await press();
    if (!pressed.ok) return { ok: false, reason: 'press-refused' };

    const rest = await readRest(sampler, previousMarkerX, now, wait, restDeadlineLimitMs);
    return {
      ok: true,
      v,
      atMs: plan.atMs,
      target: plan.target,
      tapX: reading.markerX,
      restX: rest.restX,
      restSettled: rest.restSettled,
    };
  }
}

/**
 * Where the marker parked after the press, and whether it is a rest at all. Two readings within
 * `REST_SETTLE_PX` mean it has settled (`restSettled: true`, `restX` is the second of them); a
 * still-moving marker is reported at the deadline (`restSettled: false`) where it was last seen,
 * because losing the position is worse than naming it as unsettled. The deadline is the settle
 * window clamped to `budgetMs + REST_READ_MS` from the call's start, so the whole call stays
 * bounded; polls are spaced by `REST_POLL_MS`, so an instant sampler on a frozen clock cannot turn
 * this into a hot spin. A refusal or a throw is not the press's failure: the press happened, the bar
 * just went away (contracts §0.6). This read ignores `enabled` on purpose — the 解除 button reading
 * dimmed is exactly what a successful press looks like.
 */
async function readRest(
  sampler: QteSampler,
  previousMarkerX: number | undefined,
  now: () => number,
  wait: (ms: number) => Promise<void>,
  deadlineLimitMs: number,
): Promise<{ readonly restX: number | null; readonly restSettled: boolean }> {
  const deadlineMs = Math.min(now() + REST_READ_MS, deadlineLimitMs);
  let lastX: number | null = null;
  while (now() <= deadlineMs) {
    let sample: BarSample;
    try {
      sample = await sampler.sample(previousMarkerX);
    } catch {
      return { restX: null, restSettled: false };
    }
    if (!sample.ok) return { restX: null, restSettled: false };
    const markerX = sample.reading.markerX;
    previousMarkerX = markerX;
    if (lastX !== null && Math.abs(markerX - lastX) <= REST_SETTLE_PX) {
      return { restX: markerX, restSettled: true };
    }
    lastX = markerX;
    await wait(REST_POLL_MS);
  }
  return { restX: lastX, restSettled: false };
}

// ---------------------------------------------------------------------------------------------
// The production sampler
// ---------------------------------------------------------------------------------------------

/**
 * The production sampler: a band capture when the source has one, the QTE window, and `parseQte`.
 *
 * With a source that can crop, the rectangle asked for is the QTE window of the reference frame —
 * the band plus the 解除 annulus — and that rectangle's top-left becomes `parseQte`'s `origin`. A
 * source without `captureBand` keeps working: its full frame is parsed at its own origin.
 *
 * A `QteParse` refusal is split by what it is a fact about. The bar's shape — `no-bar`, `no-marker`,
 * `multi-marker`, `no-zones`, `bad-gap`, `gap-not-dark`, `no-button` — is a fact about the screen:
 * the bar was looked for and is not there, which is `bar-gone`, the normal end of a pass.
 * `decode-failed` and `unsupported-size` are facts about our own eyes: the crop could not be
 * decoded, or it is not the rectangle that was asked for, so nothing was learned about the screen.
 * Those are `capture-failed`, the fact the tick's failure accounting exists for — read as
 * `bar-gone` they would be logged at `info` as an ordinary pass and a broken crop or decode path
 * would stay invisible until the 120 s stall stop.
 *
 * A capture that throws is **not** `bar-gone`. `parseQte` with an origin checks the crop's size
 * against the reference window, not the game window's, so a 2560×1440 client area is cropped at the
 * 1920-anchored rectangle and parsed — the 1920×1080 client-size invariant is the composition root's,
 * which asserts it (`WvdWorld#timeQte`, Task 7). Every engine failure — a refused crop, a stale
 * frame, a dead child — is the separate fact `capture-failed`, and this sampler never rethrows it:
 * failure is a value (contracts §0.6).
 *
 * `atMs` is the frame's clock, never `now()`: a reading that lied about its age would be planned
 * against the wrong instant (contracts §7).
 */
export function bandSampler(source: FrameSource): QteSampler {
  return {
    async sample(previousMarkerX?: number): Promise<BarSample> {
      try {
        const { frame, origin } = await readFrame(source);
        const parsed = await parseQte(frame, previousMarkerX, origin);
        if (!parsed.ok) return { ok: false, reason: sampleRefusal(parsed.reason) };
        return {
          ok: true,
          reading: {
            atMs: frame.atMs,
            markerX: parsed.qte.markerX,
            zones: parsed.qte.zones,
            enabled: parsed.enabled,
          },
        };
      } catch {
        // "We could not look" is not "the bar is gone" — two facts, and only this one belongs to
        // the tick's failure accounting.
        return { ok: false, reason: 'capture-failed' };
      }
    },
  };
}

/**
 * Which sample refusal a `parseQte` refusal is. A shape refusal is a fact about the screen — the bar
 * was looked for and is not there. A decode or size refusal is a fact about our own eyes — nothing
 * was learned about the screen — and only the second belongs to the tick's failure accounting (see
 * `bandSampler`).
 */
function sampleRefusal(reason: QteRefusalReason): 'bar-gone' | 'capture-failed' {
  return reason === 'decode-failed' || reason === 'unsupported-size' ? 'capture-failed' : 'bar-gone';
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
