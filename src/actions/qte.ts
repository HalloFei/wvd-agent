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
 * `reading.atMs + plan.atMs` in `now()`'s domain, and the sleep is what remains of it. Stamping a
 * reading with `now()` instead — or comparing the plan's delay to `now()` — would be wrong by the
 * whole capture latency (~50 ms).
 *
 * ## Two ways to a press
 *
 * The planned instant, while it is still ahead, is the accurate path: sleep to it and the rest lands
 * on the zone's centre. Once it has passed, the question stops being "when" and becomes "where": a
 * press issued now still carries the marker (`predictRest`), and if the landing is inside a zone —
 * with the model's margin, before the bounce — the press is taken late rather than not at all. That
 * is what makes a 1 200 px/s bar pressable at all: its lead is 75 ms of travel with the brake
 * switch off (the default) or ~177 ms with it on (latency 75 ms plus the drag brake's 101.7 ms), so
 * by the time a frame has been parsed the planned instant is often just behind us, and refusing it
 * would refuse every pass.
 *
 * ## What bounds the call
 *
 * `budgetMs` is the **pre-press** budget: a bar that outlives it yields a refusal, and the World's
 * next tick may try again (the marker bounces forever and passes are free, chest spec §8a). The
 * rest read after a successful press adds its own settle window, `REST_READ_MS`, and is clamped to
 * `budgetMs + REST_READ_MS` from the call's start — so the whole call is bounded by the pre-press
 * budget plus the rest read, never by the budget alone. Whether a *pass* is worth attempting is the
 * caller's judgement, not this module's: `choosePass` is asked before any press, and this loop only
 * decides *when* (the planned instant) or *whether the landing is still good* (the late press). The
 * reading's clock is not `now()` — a frame can be up to `FRAME_MAX_AGE_MS` (300 ms) old when it is
 * planned — so both tests are taken from what is actually left, never from the plan's own delay. A
 * dimmed 解除 button is `resolved`, not a live pass (chest spec §8a) — nothing is pressed, because
 * this pass was already answered.
 *
 * ## The refusals
 *
 * `bar-gone` is a sample that looked for the bar and did not find it; `capture-failed` is a sample
 * that could not look at all (a capture or a parse that threw, a crop that could not be decoded, or
 * one that is not the rectangle that was asked for). They are different facts on purpose — only the
 * second may reach the tick's failure accounting — and neither is retried here: the World's own
 * capture path owns warm-up retries and the session-end decision, and it runs on the very next
 * tick. `resolved` is a dimmed button; `press-refused` the actuator's answer; `misconfigured` a
 * non-finite or non-positive budget or a non-finite clock,
 * refused before the first sample in the same spirit as `planTap`'s own input guards. The three
 * that end a spent budget are split by what the loop had: `no-velocity` when fewer than three
 * readings arrived (a speed needs three), `no-reachable-zone` when speeds came but `planTap` never
 * found a centre inside the horizon, and `budget-spent` otherwise — including the stream whose
 * readings never form a steady velocity, which is what the recording's duplicate frames produce.
 */
import type { ActionResult, Frame, FrameSource, Point, QteZone } from '../contracts.ts';
import { parseQte, qteWindow, type QteRefusalReason } from '../perception/chest.ts';
import {
  BOUNCE_LEFT_X, BOUNCE_RIGHT_X, PROBE_SPEED_GATE_PX_PER_S, planTap, predictRest, qteVelocity,
  type QteSample,
} from '../policy/qte.ts';

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

/**
 * The margin a predicted landing keeps inside a zone, pixels. The prediction's real uncertainty is
 * the timing model's: with the brake switch on, the one measured stop gives tau = 112 ms while the
 * plan's carry is the measured prior (0.05 s), so the actual landing is up to
 * `v · 0.0103` px past the prediction — 12.8 px at 1 240 px/s. With it off (the default) the live
 * 2026-10-31 presses left ~4 px, and either way there are a few px of glyph and latency noise. 20 px
 * covers all of that, and a zone narrower than twice the margin is left to the exact path rather
 * than gambled on.
 */
const PREDICT_MARGIN_PX = 20;

/** The 3-frame velocity estimate's worst-case error (research §8): 5.8 %. */
const VELOCITY_ERROR_RATIO = 0.058;

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
  | 'capture-failed'    // we could not look: capture/parse threw, crop undecodable or wrong size
  | 'resolved'          // the 解除 button reads dimmed: this pass was already answered
  | 'no-velocity'       // fewer than three readings arrived before the budget ran out
  | 'no-reachable-zone' // speeds came, but no zone centre was reachable inside the horizon
  | 'budget-spent'      // three readings or more, no press, and nothing more specific to report
  | 'press-refused'     // the actuator declined the press (not foreground, engine gone)
  | 'misconfigured';    // bad budget or clock: refused before sampling

export interface QteTiming {
  readonly ok: true;
  readonly v: number;             // px/s, signed
  readonly atMs: number;          // the delay waited before the press; 0 when the landing was predicted
  readonly target: number;        // the zone centre the plan aimed at
  readonly tapX: number;          // the marker's position on the planning reading
  readonly restX: number | null;  // where it parked, when the bar was still there to read
  /**
   * Whether `restX` is a rest at all: true only when two consecutive readings agreed within the
   * settle tolerance (which includes a marker that was already still when the read began). A marker
   * still moving at the deadline reports its last position with `restSettled: false` — the fit
   * the carry prior (#18) makes from `(v, tapX, restX)` must not read a moving sample as a rest.
   */
  readonly restSettled: boolean;
  /** When the press was sent, on the caller's clock (ms). */
  readonly pressAtMs: number;
  /**
   * This press was a **probe** (operator, 2026-11-07): the bar ran faster than the corpus the model was
   * fitted on and no measured slide was known, so the pass was spent pressing the **arrival** onto the
   * zone centre — no carry — and the rest read is the slide at that speed. One pass buys the fit the
   * next bar uses.
   */
  readonly probe?: boolean;
  /** When the actuator answered, on the caller's clock (ms) — the round trip's end. */
  readonly ackAtMs: number;
  /** From the planning reading's clock to the send: the delay the loop actually waited (ms). */
  readonly delayActualMs: number;
  /** The child's own receipt→SendInput, when the actuator reported one. */
  readonly inputMs: number | null;
  /**
   * The bar's post-press carry time, seconds, measured from the park (operator rule 2026-11-05):
   * `tau = (restX − tapX)/v − delayActual − L`. `L` is the press's round trip, an upper bound of
   * the input leg (it includes the reply transit and excludes the game's frame). Null when the rest
   * did not settle — a moving marker has no park to measure.
   */
  readonly tauS: number | null;
}

/** One recorded QTE event: the chest path records its own bar when the operator asks for it. */
export type QteRecordEvent =
  | {
    readonly kind: 'reading';
    readonly atMs: number;
    readonly markerX: number;
    readonly zones: readonly QteZone[];
    readonly enabled: boolean;
  }
  | {
    readonly kind: 'plan';
    readonly atMs: number;
    readonly v: number;
    readonly target: number;
    readonly delayMs: number;
    /** A probe plan (2026-11-07): no carry, aimed at the zone centre on arrival. */
    readonly probe?: boolean;
  }
  | {
    readonly kind: 'press';
    readonly sentAtMs: number;
    readonly ackAtMs: number;
    readonly ok: boolean;
    readonly inputMs: number | null;
    readonly delayActualMs: number;
    readonly target: number;
    readonly v: number;
  }
  | {
    readonly kind: 'rest';
    readonly restX: number | null;
    readonly settled: boolean;
    readonly tauS: number | null;
  }
  | {
    readonly kind: 'outcome';
    readonly ok: boolean;
    readonly reason?: string;
    readonly v?: number;
    readonly target?: number;
    readonly restX?: number | null;
    readonly restSettled?: boolean;
    readonly tauS?: number | null;
  };

/** Where a recorded QTE event goes. The file sink lives in `qte-record.ts`, wired by main.ts. */
export type QteRecordSink = (event: QteRecordEvent) => void;

export type QteOutcome = QteTiming | { readonly ok: false; readonly reason: QteRefusal };

/**
 * `budgetMs` is the **pre-press** budget. The rest read that follows a successful press adds
 * `REST_READ_MS`, so the whole call is bounded by `budgetMs + REST_READ_MS`; a non-finite or
 * non-positive budget is refused as `misconfigured` rather than run unbounded.
 */
export interface QteTimingOptions {
  readonly sampler: QteSampler;
  readonly press: () => Promise<ActionResult>;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly latencyMs: number;
  readonly budgetMs: number;
  /**
   * Records the bar as it is timed (operator rule 2026-11-05): every accepted reading, the plan, the
   * press with its send/ack timing and the child's `inputMs`, and the rest with the carry time.
   * Absent means no recording; the analysis needs it, the loop does not.
   */
  readonly record?: QteRecordSink | undefined;
  /**
   * The bar's carry time, seconds: measured from its own park when it has one (the caller feeds the
   * previous outcome's `tauS` back), else the measured prior the World passes for a bar's first
   * press (`worlds.wvd.qtePriorCarryTauS`). The plan's one slide term.
   */
  readonly carryTauS?: number | undefined;
  /**
   * Whether `carryTauS` is a **measured** slide (an earlier press's park) or only the prior. A bar whose
   * speed passes `PROBE_SPEED_GATE_PX_PER_S` with no measured slide is pressed as a probe: the model
   * has never seen that speed, and one pass buys the measurement (operator, 2026-11-07).
   */
  readonly carryMeasured?: boolean | undefined;
  /** ± uncertainty of the input leg, ms, for the stop band (operator rule 2026-11-05). */
  readonly latencySpreadMs?: number | undefined;
  /** ± uncertainty of the carry, px, for the stop band. */
  readonly carrySpreadPx?: number | undefined;
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
  const {
    sampler, press, now, wait, latencyMs, budgetMs, record,
    carryTauS, carryMeasured = false, latencySpreadMs = 0, carrySpreadPx = 0,
  } = options;

  // A mis-typed number must not become a press, and an unbounded loop is the one failure this
  // module could not report as a value: refuse both before the first sample.
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
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
    record?.({ kind: 'reading', atMs: reading.atMs, markerX: reading.markerX, zones: reading.zones, enabled: reading.enabled });
    previousMarkerX = reading.markerX;
    lastThree.push({ atMs: reading.atMs, markerX: reading.markerX });
    if (lastThree.length > 3) lastThree.shift();
    if (lastThree.length < 3) continue;

    const v = qteVelocity(lastThree[0], lastThree[1], lastThree[2]);
    // No speed yet (a short baseline, a reversal, an eased marker): keep walking the pass.
    if (v === null) continue;

    const remainingMs = Math.max(0, budgetMs - (now() - startedAtMs));
    // A bar faster than the corpus the model was fitted on, with no measured slide for it, is pressed
    // as a **probe** (operator, 2026-11-07): the pass is spent putting the marker on the zone centre at
    // arrival — no carry, no band — so the park that follows is the slide at this speed, and the next
    // bar is planned with it. A bar inside the corpus keeps the measured stop-band plan.
    const probe = !carryMeasured && Math.abs(v) > PROBE_SPEED_GATE_PX_PER_S;
    const carryPx = probe
      ? 0
      : carryTauS !== undefined && Number.isFinite(carryTauS) ? v * carryTauS : undefined;
    const plan = planTap({
      markerX: reading.markerX,
      v,
      zones: reading.zones,
      latencyMs,
      horizonMs: remainingMs,
      ...(carryPx === undefined ? {} : { carryPx }),
      latencySpreadMs,
      carrySpreadPx,
      velocitySpreadPxPerS: Math.abs(v) * VELOCITY_ERROR_RATIO,
      minOverlap: probe ? 0 : 0.95,
    });
    planAttempted = true;
    if (plan !== null) {
      planFound = true;
      record?.({
        kind: 'plan', atMs: reading.atMs, v, target: plan.target, delayMs: plan.atMs,
        ...(probe ? { probe: true } : {}),
      });
    }
    // No attempt-vs-reroll callback any more (2026-11-06): the operator's "can this pass succeed?"
    // question is the stop band's, and a pass the band refuses for the whole sub-loop comes back as
    // `no-reachable-zone` — the World re-rolls the bar on that, while its budget lasts.
    // Two ways to a press, in order of accuracy. 1. The plan's instant is still ahead (`plan.atMs`
    // is a delay from the reading's clock, §7, and that clock can be hundreds of ms old): sleep to
    // it and the rest lands on the centre it aimed at. 2. It has passed, or no centre is reachable:
    // press now if the *landing* is inside a zone — the rest is what the game judges, measured on
    // the 2026-10-31 press that parked 55 px past its target and was accepted.
    let delayMs = 0;
    let plannedAtMs = 0;
    let target = plan?.target ?? 0;
    const leftMs = plan === null ? 0 : reading.atMs + plan.atMs - now();
    if (leftMs <= 0) {
      const landingRest = predictRest({
        markerX: reading.markerX,
        v,
        ageMs: now() - reading.atMs,
        latencyMs,
        ...(carryPx === undefined ? {} : { carryPx }),
      });
      const landingAt = landingRest;
      const landing = landingAt === null ? undefined : reading.zones.find((zone) =>
        landingAt >= zone.from + PREDICT_MARGIN_PX
        && landingAt <= zone.to - PREDICT_MARGIN_PX
        && (v > 0 ? landingAt <= BOUNCE_RIGHT_X : landingAt >= BOUNCE_LEFT_X));
      // No landing inside a zone: keep sampling. A bounce is free until an attempt is spent.
      if (landing === undefined) continue;
      target = (landing.from + landing.to) / 2;
    } else {
      delayMs = leftMs;
      plannedAtMs = plan?.atMs ?? 0;
    }

    // `delayMs` is the time left to the instant (zero on the predicted path), so the budget cannot
    // be overrun: `remainingMs` was the horizon.
    if (delayMs > 0) await wait(delayMs);

    // The press's own timing, on the caller's clock (operator rule 2026-11-05): the delay actually
    // waited, the round trip (send → the child's reply, the input leg's upper bound) and the child's
    // own receipt→SendInput, which splits the round trip. Two clock reads and no new request.
    const sentAtMs = now();
    const pressed = await press();
    const ackAtMs = now();
    const ack = pressed as ActionResult & { readonly inputMs?: unknown };
    const inputMs = typeof ack.inputMs === 'number' && Number.isFinite(ack.inputMs) ? ack.inputMs : null;
    const delayActualMs = sentAtMs - reading.atMs;
    record?.({
      kind: 'press', sentAtMs, ackAtMs, ok: pressed.ok, inputMs, delayActualMs, target, v,
    });
    if (!pressed.ok) return { ok: false, reason: 'press-refused' };

    const rest = await readRest(sampler, previousMarkerX, now, wait, restDeadlineLimitMs);
    // The carry time, from the park: only a settled marker measured a registration point. Everything
    // in the algebra was measured — the reading's clock, the send, the ack and the park.
    const tauS = rest.restSettled && rest.restX !== null && v !== 0
      ? (rest.restX - reading.markerX) / v - delayActualMs / 1_000 - (ackAtMs - sentAtMs) / 1_000
      : null;
    record?.({ kind: 'rest', restX: rest.restX, settled: rest.restSettled, tauS });
    record?.({
      kind: 'outcome', ok: true, v, target, restX: rest.restX, restSettled: rest.restSettled, tauS,
    });
    return {
      ok: true,
      v,
      atMs: plannedAtMs,
      target,
      tapX: reading.markerX,
      restX: rest.restX,
      restSettled: rest.restSettled,
      pressAtMs: sentAtMs,
      ackAtMs,
      delayActualMs,
      inputMs,
      tauS,
      ...(probe ? { probe: true } : {}),
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
