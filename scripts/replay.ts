/**
 * Replay harness: run the real recognisers over a recorded video and report what they saw.
 *
 * This is a development instrument, not runtime code. Nothing under `src/` imports it; it is how
 * "the parser looked right on one frame" becomes "over 250 frames it refused 51 times, all for the
 * right reasons". `tests/replay.test.ts` is its only caller, and it drives perception through
 * `CompositePerceiver` exactly as the composition root will (progress.md: "Replay drives perception
 * through the composite; no direct parser calls"), so a change to a recogniser shows up here.
 *
 * ## Decoding
 *
 * `ffmpeg` decodes the recording to raw RGBA on a pipe, and this harness assembles **one frame at a
 * time**: a chunk is copied into a per-frame `Buffer.allocUnsafeSlow`, and the loop awaits the whole
 * observation before pulling the next chunk, so the stream applies backpressure and no second frame
 * can be read until the first is finished with. Nothing is written to disk — not to `testdata/`,
 * not to a temp directory — so there are no decoded frames to clean up. (A temp directory would be
 * the right answer if extraction were needed; a pipe is strictly narrower.)
 *
 * `ffprobe` supplies the frame size and nominal rate; the recognisers need the size to refuse a
 * frame they were not measured at (contracts §0.5) and `Frame.atMs` needs a timeline. Per-frame
 * timestamps are not read: `atMs` is the nominal media time (`index / fps`), which is what the
 * recording claims and is monotonic, which is all the contract asks of it.
 *
 * ## What is a failure
 *
 * `failures` names the frames that produced something inconsistent — not frames that were refused.
 * Refusal is a first-class answer (contracts §0.2/§0.6): frames 203–249 of the QTE recording show
 * the opened chest with no bar, and `unknown` is the correct answer, not a failure. A frame is a
 * failure when:
 *
 * - perception threw (a recogniser bug must not vanish behind `unknown`);
 * - perception returned no observation at all (the composite's contract says it always returns one);
 * - it read `chest-qte` with a payload that has no readable zones (a recogniser may violate its
 *   type at runtime; that is a named failure for frame N, not a crash);
 * - it read `chest-qte` with zones that do not fit the geometry `measurements.json` recorded for the
 *   recording — the "plausible garbage" the parser exists to refuse (research-qte-parser §10);
 * - the band cross-check is on (`options.bandCheck`) and the crop's parse refused or disagreed with
 *   the full frame's `QteState` — the sample the World will take must be the observation it validated;
 * - the decoded stream ended with a partial frame, or ffmpeg produced a frame the harness could not
 *   turn into an image.
 *
 * The plan check (`options.planCheck`) is the one thing that is **not** a `failures` entry: a plan
 * whose target misses the recording's zones, that crosses the planner's own reversal, or whose
 * predicted press position disagrees with the recording is our planning model's answer, not
 * perception's, so it is named in its own `planViolations` list. `planned` says how many plans the
 * model returned at all; `planPositions` how many of those the recording could actually check.
 *
 * A malformed or absent `measurements.json` disables only the geometry check — and the plan check,
 * which needs the same bar to judge a plan against; a recording may be replayed before it has
 * measurements, and everything else still runs. It **warns** when it does so, so a switched-off
 * cross-check cannot be mistaken for one that passed. A setup failure — no video, `ffmpeg`/`ffprobe`
 * missing, ffmpeg exiting non-zero — throws rather than returning a tally that would look like a
 * measurement.
 *
 * ## Recogniser order and floors
 *
 * Each recogniser keeps its own floor (composite.ts). This harness uses the route's act floor, 0.5
 * (contracts §6), so the tally is "what the route would act on", not a parsing score. Order is
 * cheapest decisive gate first: the chest band is 1.43 % of a frame and is the recording's subject;
 * the map's coordinate readout is the decisive map gate; the HUD's uniformity sample is the widest
 * read and comes last.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Frame,
  Observation,
  QteState,
  RgbaImage,
  ScreenId,
  TapPlan,
} from '../src/contracts.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { ChestPerceiver, parseQte, qteWindow } from '../src/perception/chest.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { MapPerceiver } from '../src/perception/map.ts';
import {
  BOUNCE_LEFT_X,
  BOUNCE_RIGHT_X,
  VELOCITY_EASED_FLOOR_PX_PER_S,
  planTap,
  qteVelocity,
} from '../src/policy/qte.ts';

// ---------------------------------------------------------------------------------------------
// The public shape
// ---------------------------------------------------------------------------------------------

export interface ReplayReport {
  /** Complete frames decoded; an inconsistent one is still a decoded frame and is named in `failures`. */
  readonly frames: number;
  /** Observations per `ScreenId`; every id is present, unseen screens are 0. */
  readonly screens: Record<ScreenId, number>;
  /** One line per inconsistent frame, naming the frame index (0-based) and the problem. */
  readonly failures: string[];
  /** `chest-qte` frames the band cross-check re-parsed; 0 when `bandCheck` is off. */
  readonly bandFrames: number;
  /** Band re-parses that disagreed with the composite's `QteState`; 0 when `bandCheck` is off. */
  readonly bandMismatches: number;
  /** Plans `planTap` returned from the recording's own readings; 0 when `planCheck` is off. */
  readonly planned: number;
  /**
   * Plans whose predicted press position was actually compared with a recorded reading; at most
   * `planned`, 0 when `planCheck` is off. A plan is unchecked, never a violation, when the
   * recording has no reading within one frame of its press instant, when that nearest reading is
   * the plan's own reading (predicting its position from itself is a tautology), or when the
   * recording's own press had already braked the marker.
   */
  readonly planPositions: number;
  /**
   * Plans whose target missed a recorded zone, crossed the planner's reversal, or whose predicted
   * press position disagreed with the recording beyond `PLAN_PRESS_TOLERANCE_PX`.
   */
  readonly planViolations: string[];
}

/** Optional harness work. Absent means off, so every existing caller keeps its exact behaviour. */
export interface ReplayOptions {
  /**
   * Also crop every `chest-qte` frame to `qteWindow` (the rectangle the World asks the child for,
   * contracts §5), re-parse it, and compare its `QteState` with the full frame's. This is the
   * scale half of the crop proof: the six stills pin the geometry, the recording proves the sample.
   */
  readonly bandCheck?: boolean;
  /**
   * Also feed the planning model the recording's own `chest-qte` observations — the last three
   * readings at their own `atMs`, `qteVelocity`, then `planTap` with the contracts' latency and
   * slide defaults and the harness's one-pass horizon — and check every returned plan: its target
   * must lie inside a zone `measurements.json` recorded, it must not cross the planner's own
   * reversal, and the press position it predicts at the reading nearest its press instant must
   * agree with that reading, at the reading's own time, within `PLAN_PRESS_TOLERANCE_PX`. This is
   * the only check of the planning model against recorded marker motion (design acceptance 5); off
   * when `measurements.json` has no readable bar, since there is nothing to check a plan against.
   */
  readonly planCheck?: boolean;
}

export type ReplayTools =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Is the external toolchain the harness needs on PATH? The test asks first so that a machine
 * without `ffmpeg` reports a skip and its reason instead of a red suite; `replay` also checks, so a
 * caller that forgets gets a named error rather than a `spawn` ENOENT.
 */
export function replayTools(): ReplayTools {
  const missing = ['ffmpeg', 'ffprobe'].filter((tool) => !onPath(tool));
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: `not on PATH: ${missing.join(', ')}` };
}

/**
 * Replay the first `.mp4` in `dir` (sorted, so the choice is deterministic) through perception.
 * `measurements.json` beside it, when present and well formed, supplies the bar geometry against
 * which `chest-qte` zones are checked. `options.bandCheck` adds the crop cross-check;
 * `options.planCheck` adds the planning model's check against the recorded zones and marker motion.
 */
export async function replay(dir: string, options: ReplayOptions = {}): Promise<ReplayReport> {
  const tools = replayTools();
  if (!tools.ok) throw new Error(`cannot replay ${dir}: ${tools.reason}`);

  const recording = await findRecording(dir);
  const info = probeVideo(recording);
  const bandCheck = options.bandCheck === true;
  const planCheck = options.planCheck === true;
  // The warning names the plan check when it asked for the bar: `planned: 0` with no violations
  // would otherwise look like a clean check.
  const recordedBar = await readRecordedBar(dir, { planCheck });

  const screens = emptyScreens();
  const failures: string[] = [];
  const band: BandTally = { frames: 0, mismatches: 0 };
  // The plan check needs the recording's zones to judge a target, and the recording's readings to
  // judge the press position; without a readable bar there is nothing independent to check it
  // against (readRecordedBar has already warned).
  const plan: PlanTally | null =
    planCheck && recordedBar
      ? {
          zones: [recordedBar.left, recordedBar.right],
          recent: [],
          markers: [],
          plans: [],
          planned: 0,
          positions: 0,
          violations: [],
          frameMs: 1_000 / info.fps,
        }
      : null;
  const composite = new CompositePerceiver([
    { perceiver: new ChestPerceiver(), floor: 0.5 },
    { perceiver: new MapPerceiver(), floor: 0.5 },
    { perceiver: new HudPerceiver(), floor: 0.5 },
  ]);

  let frames = 0;
  let buffer = Buffer.allocUnsafeSlow(info.frameBytes);
  let filled = 0;

  const child = spawn(
    'ffmpeg',
    [
      '-v', 'error',
      '-nostdin',
      '-i', recording,
      // Video only: the rawvideo muxer carries no audio, and a recording with a track must not fail
      // for it.
      '-an',
      // Every decoded frame, never a frame-rate-converted duplicate or drop.
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!child.stdout || !child.stderr) {
    child.kill();
    throw new Error('ffmpeg did not provide stdout/stderr pipes');
  }

  let stderr = '';
  const MAX_STDERR = 4_096;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < MAX_STDERR) stderr += chunk;
  });

  const closed = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: undefined }));
  });

  // The async iterator is the backpressure mechanism: the next chunk is pulled only after the
  // previous frame's observation has finished, so a decoded frame does not accumulate.
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(info.frameBytes - filled, chunk.length - offset);
        chunk.copy(buffer, filled, offset, offset + take);
        filled += take;
        offset += take;

        if (filled === info.frameBytes) {
          const index = frames;
          const image: RgbaImage = { data: rgbaView(buffer, info.frameBytes), ...info.size };
          const atMs = Math.round((index * 1000) / info.fps);
          const frame: Frame = {
            atMs,
            width: info.size.width,
            height: info.size.height,
            toRgba: async () => image,
          };
          await observeFrame(frame, index, composite, recordedBar, bandCheck, band, plan, screens, failures);
          frames += 1;
          buffer = Buffer.allocUnsafeSlow(info.frameBytes);
          filled = 0;
        }
      }
    }
  } catch (error) {
    // An unexpected failure in the harness must not leave ffmpeg writing into a dead pipe.
    child.kill();
    throw error;
  }

  const outcome = await closed;
  if (outcome.error) throw new Error(`ffmpeg could not run: ${outcome.error.message}`);
  if (outcome.code !== 0) {
    throw new Error(`ffmpeg exited ${outcome.code} for ${recording}: ${stderr.trim()}`);
  }
  if (frames === 0) {
    // Zero frames is not a clean tally: it is a video (or a decode) that told us nothing.
    throw new Error(`ffmpeg decoded no frames from ${recording}`);
  }
  if (filled > 0) {
    failures.push(
      `frame ${frames}: truncated frame (${filled} of ${info.frameBytes} bytes decoded)`,
    );
  }

  // The plans are judged here, not as they are made: a plan's press instant is later than its own
  // reading, so the recorded reading nearest that instant only exists once the decode is done.
  if (plan) judgePlans(plan);

  return {
    frames,
    screens,
    failures,
    bandFrames: band.frames,
    bandMismatches: band.mismatches,
    planned: plan?.planned ?? 0,
    planPositions: plan?.positions ?? 0,
    planViolations: plan?.violations ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// Perception, one frame
// ---------------------------------------------------------------------------------------------

async function observeFrame(
  frame: Frame,
  index: number,
  composite: CompositePerceiver,
  recordedBar: RecordedBar | null,
  bandCheck: boolean,
  band: BandTally,
  plan: PlanTally | null,
  screens: Record<ScreenId, number>,
  failures: string[],
): Promise<void> {
  let observation: Observation;
  try {
    observation = await composite.observe(frame);
  } catch (error) {
    failures.push(`frame ${index}: perception threw: ${messageOf(error)}`);
    return;
  }

  if (!isObservation(observation)) {
    failures.push(`frame ${index}: no observation`);
    return;
  }
  if (!Object.hasOwn(screens, observation.screen)) {
    failures.push(`frame ${index}: unrecognised screen '${String(observation.screen)}'`);
    return;
  }
  screens[observation.screen] += 1;

  if (observation.screen === 'chest-qte') {
    if (!hasReadableZones(observation.qte)) {
      failures.push(`frame ${index}: chest-qte observation carries no readable zones`);
      return;
    }
    if (recordedBar) {
      const problem = geometryProblem(observation.qte, recordedBar);
      if (problem) failures.push(`frame ${index}: chest-qte ${problem}`);
    }
    if (bandCheck) await checkBand(frame, index, observation.qte, band, failures);
    if (plan) checkPlan(plan, observation.atMs, observation.qte, index);
  }
}

// ---------------------------------------------------------------------------------------------
// The band cross-check
// ---------------------------------------------------------------------------------------------

/** How many `chest-qte` frames the band check saw, and how many of those disagreed. */
interface BandTally {
  frames: number;
  mismatches: number;
}

/**
 * Re-read one `chest-qte` frame from the rectangle the World will actually capture.
 *
 * The crop is cut from the frame's own already-decoded pixels: `Frame.toRgba()` is lazy and, in this
 * harness, memoised in the frame it was built with (one `image` per decoded frame), so the composite's
 * own read and this one are the same decode, not two. `parseQte` gets the window's origin so both
 * sides answer in full-frame device pixels, and **neither side passes `previousMarkerX`**: the
 * comparison is one frame against itself, not against the recording's previous marker.
 *
 * A refusal where the composite saw `chest-qte`, or a differing `QteState`, is a mismatch and is
 * named in `failures` too — the harness's failure list means "something inconsistent", and a sample
 * that disagrees with the observation is exactly that.
 */
async function checkBand(
  frame: Frame,
  index: number,
  expected: QteState,
  band: BandTally,
  failures: string[],
): Promise<void> {
  band.frames += 1;
  const rect = qteWindow(frame);

  let image: RgbaImage;
  try {
    image = await frame.toRgba();
  } catch (error) {
    band.mismatches += 1;
    failures.push(`frame ${index}: band crop could not read the frame: ${messageOf(error)}`);
    return;
  }

  let cropped: { pixels: Uint8Array; width: number; height: number };
  try {
    cropped = cropBgra(image.data, image.width, image.height, rect);
  } catch (error) {
    band.mismatches += 1;
    failures.push(`frame ${index}: band crop failed: ${messageOf(error)}`);
    return;
  }

  const bandFrame: Frame = {
    atMs: frame.atMs,
    width: cropped.width,
    height: cropped.height,
    toRgba: async () => ({ data: cropped.pixels, width: cropped.width, height: cropped.height }),
  };
  const parsed = await parseQte(bandFrame, undefined, { x: rect.x, y: rect.y });
  if (!parsed.ok) {
    band.mismatches += 1;
    failures.push(
      `frame ${index}: band parse refused (${parsed.reason}) where the full frame read chest-qte`,
    );
    return;
  }
  if (!sameQte(parsed.qte, expected)) {
    band.mismatches += 1;
    failures.push(
      `frame ${index}: band parse ${JSON.stringify(parsed.qte)} disagrees with ` +
        `the full frame ${JSON.stringify(expected)}`,
    );
  }
}

/** Field-by-field, so a `QteState` that differs in one zone or one point is a mismatch. */
function sameQte(a: QteState, b: QteState): boolean {
  if (a.markerX !== b.markerX || a.attempts !== b.attempts) return false;
  if (a.button.x !== b.button.x || a.button.y !== b.button.y) return false;
  if (a.zones.length !== b.zones.length) return false;
  return a.zones.every(
    (zone, side) => zone.from === b.zones[side].from && zone.to === b.zones[side].to,
  );
}

/** A structural check, not a cast: an instrument that swallows a malformed answer is useless. */
function isObservation(value: unknown): value is Observation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { screen?: unknown; atMs?: unknown };
  return typeof candidate.screen === 'string' && typeof candidate.atMs === 'number';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// The plan check
// ---------------------------------------------------------------------------------------------

/** A `chest-qte` marker reading: the composite's own numbers, never a re-parse. */
interface PlanSample {
  readonly atMs: number;
  readonly markerX: number;
}

/** One plan's own reading, carrying the speed measured at it and the zones its target is judged against. */
export interface PlanReading extends PlanSample {
  /** Signed speed measured from the three readings ending here, px/s. */
  readonly v: number;
  /**
   * The recorded zone columns a valid target must fall inside — `measurements.json`'s bar, not the
   * parsed fill interiors the planner was handed. The parser's fills sat 0–11 px inside these
   * columns (research-qte-parser §4) and `geometryProblem` pins each parsed centre to them, so a
   * target is judged against the recording's own drawing rather than against `planTap`'s input.
   */
  readonly zones: readonly (readonly [number, number])[];
}

/** A plan the recording produced, kept until every reading is in (the press instant is later). */
interface RecordedPlan {
  readonly index: number;
  readonly reading: PlanReading;
  readonly plan: TapPlan;
}

interface PlanTally {
  /** The recording's zones, the independent fact a target is judged against. */
  readonly zones: readonly (readonly [number, number])[];
  /** The last three samples, oldest first: what `qteVelocity` reads and no more. */
  readonly recent: PlanSample[];
  /** Every `chest-qte` marker reading, for the nearest-press-instant lookup. */
  readonly markers: PlanSample[];
  readonly plans: RecordedPlan[];
  planned: number;
  /** Plans whose predicted press position a recorded reading actually checked. */
  positions: number;
  readonly violations: string[];
  /** One video frame in ms; the press-instant lookup may not reach further than this. */
  readonly frameMs: number;
}

/**
 * The contracts' defaults for the two `planTap` inputs `measurements.json` does not record —
 * `qteLatencyMs` and `qteDecelPxPerS2` (`WVD_DEFAULTS`, contracts §7) — so there is no measured
 * value to read. The numbers the recording *does* carry reach the check elsewhere: the zones through
 * `PlanReading.zones`, the marker's motion through its own readings.
 */
const PLAN_LATENCY_MS = 75;
const PLAN_DECEL_PX_PER_S2 = 3000;

/**
 * The harness's horizon, 1000 ms: **not** a contract default. Production passes what is left of the
 * sub-loop's budget (`remainingMs`, `actions/qte.ts`), up to `qteSubLoopMs` (4000 ms). The harness
 * has no budget to spend, and it judges a plan against the one reading nearest its press instant, so
 * one recorded pass is the useful horizon: the marker reverses every ~1 s here (frames 28 and 58 at
 * 30 fps), and a longer horizon would plan presses into later passes the recording can answer only
 * by coincidence.
 */
const PLAN_HORIZON_MS = 1000;

/**
 * How far a plan's predicted press position may sit from the recorded reading nearest its press
 * instant, in px.
 *
 * The prediction is evaluated at that reading's own time, `x0 + v·(next.atMs − reading.atMs)` — not
 * at the press instant. The lookup accepts a reading up to one frame interval (33.3 ms) from the
 * instant, and at the recorded 610 px/s one frame of travel is 20.4 px: a press-instant prediction
 * would spend the whole old tolerance on that offset alone, and a perfect predictor could be
 * flagged. At the reading's own time the residual measures only the two-frame velocity estimate's
 * error over the plan's duration. The recording's 38 compared plans measure **0.05 px min,
 * 2.09 px median, 5.98 px p90, 8.25 px max**; the worst is ~3 % velocity error over a 452 ms plan.
 * 12 px is that worst plus 45 % headroom — it tolerates a 4.3 % error at that duration — and it
 * stays under the ~27 px a 10 % speed error leaves on a 450 ms plan, so the check keeps its
 * sensitivity: a wrong sign displaces a long plan's prediction by `2·v·d`, hundreds of px, and a
 * 10 % speed error by ~27 px, both outside the bound. The shortest plans cannot tell either error
 * apart, which is why the long ones carry this check.
 */
export const PLAN_PRESS_TOLERANCE_PX = 12;

/**
 * Feed one `chest-qte` observation to the planning model exactly as the sub-loop would: its own
 * `atMs`, its own marker and its own zones. With three readings in hand, measure the speed; a
 * refusal is legitimate (a triple that straddles a bounce, or the easing near one, carries no
 * velocity), so only a *plan* is counted. The plan's check waits for the decode to finish: the
 * press instant is later than the reading, so the recorded reading nearest it does not exist yet
 * (see `judgePlans`).
 *
 * Design acceptance 5 asks for exactly this: the sub-loop, fed the recording's frames at their own
 * timestamps, plans presses that land inside the recorded zones. The unit tests drive `planTap` with
 * a synthetic constant-speed stream; this is the only place the model meets real recorded marker
 * motion.
 */
function checkPlan(plan: PlanTally, atMs: number, qte: QteState, index: number): void {
  const sample = { atMs, markerX: qte.markerX };
  plan.recent.push(sample);
  plan.markers.push(sample);
  if (plan.recent.length > 3) plan.recent.shift();
  if (plan.recent.length < 3) return;

  const v = qteVelocity(plan.recent[0]!, plan.recent[1]!, plan.recent[2]!);
  if (v === null) return;
  const tap = planTap({
    markerX: qte.markerX,
    v,
    zones: qte.zones,
    latencyMs: PLAN_LATENCY_MS,
    decelPxPerS2: PLAN_DECEL_PX_PER_S2,
    horizonMs: PLAN_HORIZON_MS,
  });
  if (tap === null) return;
  plan.planned += 1;
  plan.plans.push({ index, reading: { ...sample, v, zones: plan.zones }, plan: tap });
}

/**
 * What `planProblem` decided. `compared` is what `planPositions` counts: the target branches return
 * before the press position is looked at, and a plan with no usable reading is not compared either.
 */
export interface PlanVerdict {
  /** `null` when the plan agrees with the recording; otherwise the fault, to report verbatim. */
  readonly problem: string | null;
  /** Whether the predicted press position was actually compared with a recorded reading. */
  readonly compared: boolean;
}

/**
 * What makes a returned plan wrong, judged without asking the planner:
 *
 * - the target must lie inside a zone `measurements.json` recorded. `planTap` targets zone centres
 *   and `geometryProblem` already pins every parsed centre within 10 px of the recorded one, so
 *   this cannot fire on the recording; it is kept because a plan should be judged on where it aims,
 *   not only on the marker's motion, and it names the fault synthetically.
 * - the target must not lie past the planner's own reversal (`BOUNCE_LEFT_X`/`BOUNCE_RIGHT_X`) in
 *   the direction of travel. `planTap` refuses those too, so this is the check on the planner's
 *   guard: the test feeds it a target between the recorded zone edge (1223) and the real reversal
 *   (1261.5), which a check that went back to the zone edges would wrongly reject.
 * - the marker position the plan predicts at the reading nearest its press instant,
 *   `x0 + v·(next.atMs − reading.atMs)`, must agree with that reading within
 *   `PLAN_PRESS_TOLERANCE_PX`. The prediction is evaluated at the reading's own time, not at the
 *   press instant: the reading may sit up to one frame (33.3 ms, 20.4 px of travel here) from that
 *   instant, and predicting at the instant would spend the tolerance on the lookup's own offset.
 *   `next` is `null` when the recording has no reading close enough, which skips only this check;
 *   so is a `next` that *is* the plan's own reading — predicting the reading's position from itself
 *   is a tautology (residual 0 by construction), so it is neither counted nor compared.
 *
 * There is no delay check: `planTap` returns a delay only when it is finite, non-negative and
 * inside the horizon (its own guard, pinned in `tests/replay-plan.test.ts`), so re-testing it here
 * would be a branch that can never fire.
 */
export function planProblem(
  reading: PlanReading,
  plan: TapPlan,
  next: PlanSample | null,
  bounce: { readonly left: number; readonly right: number },
): PlanVerdict {
  const target = plan.target;
  if (!reading.zones.some(([from, to]) => target >= from && target <= to)) {
    return { problem: `plan target ${target} is not inside a recorded zone`, compared: false };
  }

  const rightward = reading.v > 0;
  const reversal = rightward ? bounce.right : bounce.left;
  if (rightward ? target > reversal : target < reversal) {
    return {
      problem:
        `plan target ${target} is past the planner's reversal at ${reversal} for ` +
        `${rightward ? 'rightward' : 'leftward'} travel`,
      compared: false,
    };
  }

  if (next === null || next.atMs === reading.atMs) return { problem: null, compared: false };
  const predicted = reading.markerX + reading.v * ((next.atMs - reading.atMs) / 1_000);
  const residual = next.markerX - predicted;
  if (Math.abs(residual) > PLAN_PRESS_TOLERANCE_PX) {
    return {
      problem:
        `plan predicts x=${predicted.toFixed(1)} at its press reading, the recording reads ` +
        `${next.markerX} at ${Math.round(next.atMs)} ms ` +
        `(${residual.toFixed(1)} px off, tolerance ${PLAN_PRESS_TOLERANCE_PX} px)`,
      compared: true,
    };
  }
  return { problem: null, compared: true };
}

/**
 * Judge every plan once the recording's readings are all in.
 *
 * The press-position check needs the reading nearest `atMs + delay`, which is later than the plan's
 * own reading — hence this deferred pass. A plan is unchecked, never a violation, when the
 * recording cannot answer: no reading within one frame of the press instant (the bar can go away,
 * and frames 124–127 are the light burst), a nearest reading that is the plan's own reading (six
 * short plans: the comparison would be a tautology), or a press instant after the recording's own
 * press. The operator pressed at ~3.3 s; the marker then glides 44 px to rest over 300 ms
 * (`measurements.json`), so seven plans name instants after free flight ended, and comparing them
 * with a straight line the recording did not fly would manufacture violations.
 */
function judgePlans(tally: PlanTally): void {
  const bounce = { left: BOUNCE_LEFT_X, right: BOUNCE_RIGHT_X };
  for (const recorded of tally.plans) {
    const pressAtMs = recorded.reading.atMs + recorded.plan.atMs;
    const near = nearestReading(tally.markers, pressAtMs);
    const checkable =
      near !== null &&
      Math.abs(near.atMs - pressAtMs) <= tally.frameMs &&
      inFreeFlight(tally.markers, recorded.reading.atMs, near.atMs);
    const verdict = planProblem(recorded.reading, recorded.plan, checkable ? near : null, bounce);
    if (verdict.compared) tally.positions += 1;
    if (verdict.problem) tally.violations.push(`frame ${recorded.index}: ${verdict.problem}`);
  }
}

/** The reading whose `atMs` is closest to `atMs`; `null` only when the recording has none. */
function nearestReading(readings: readonly PlanSample[], atMs: number): PlanSample | null {
  let best: PlanSample | null = null;
  let bestDistance = Infinity;
  for (const reading of readings) {
    const distance = Math.abs(reading.atMs - atMs);
    if (distance < bestDistance) {
      best = reading;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Did the recording's marker stay in free flight from the plan's reading to the reading it is
 * judged against? A recorded step slower than the research's easing threshold (§5) means the
 * recording's own press — or a bounce — had braked the marker by that reading, and a straight-line
 * prediction cannot be compared with it.
 *
 * Free flight ends at the **first** such step after the plan's reading, not at the second of two:
 * the recording's post-press steps are 8, 8, 8, 0 px, so a plan landing one frame after onset still
 * saw only one slow step and would have been compared — turning its ~107 px braking residual into a
 * plan violation. The isolated duplicate frames (research §5's frames 9 and 101: a 0 px step
 * followed by a fast one) are not braking — the marker resumes flight on the next step — so they are
 * skipped rather than taken for onset.
 *
 * Exported for `tests/replay-plan.test.ts`, which pins the boundary a two-step rule cannot see.
 */
export function inFreeFlight(
  readings: readonly PlanSample[],
  fromMs: number,
  toMs: number,
): boolean {
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1]!;
    const current = readings[index]!;
    if (current.atMs <= fromMs) continue;
    const seconds = (current.atMs - previous.atMs) / 1_000;
    if (!(seconds > 0)) continue;
    const speed = Math.abs(current.markerX - previous.markerX) / seconds;
    if (speed >= VELOCITY_EASED_FLOOR_PX_PER_S) continue;
    if (isDuplicateFrame(readings, index)) continue;
    // The first real slow step: was the judged reading already past it?
    return current.atMs > toMs;
  }
  return true;
}

/**
 * Is the slow step ending at `readings[index]` a duplicated frame? The recording's duplicates are a
 * single 0 px step after which the marker resumes flight (research §5); braking keeps every step
 * slow, so a fast step after this one means this one was a repeated image, not a braked marker.
 */
function isDuplicateFrame(readings: readonly PlanSample[], index: number): boolean {
  const current = readings[index]!;
  const next = readings[index + 1];
  if (next === undefined) return false;
  const seconds = (next.atMs - current.atMs) / 1_000;
  if (!(seconds > 0)) return false;
  return Math.abs(next.markerX - current.markerX) / seconds >= VELOCITY_EASED_FLOOR_PX_PER_S;
}

// ---------------------------------------------------------------------------------------------
// The recorded geometry
// ---------------------------------------------------------------------------------------------

/**
 * `measurements.json`'s `bar` rectangle, as drawn. `parseQte` reports the zones' **fill interior**,
 * which over the recording sat 0–11 px inside these edges (left 696–919 against 694–922, right
 * 1000–1223 against 997–1223; research-qte-parser §4). The slack is that measured relationship plus
 * the 8 px edge error a marker parked on a zone edge causes — 14 px, with the centre check doing the
 * real work. `hazardGap` is read when present (it measures the danger gap, not the fill gap); where
 * a recording omits it, the adjacent zone edges imply it.
 *
 * The marker's reversal points are **not** here: `marker.bounceAt` in this recording is drawn at
 * the zone edges (694 / 1224), while the marker's core centre turns at 656.5 / 1261.5
 * (`policy/qte.ts`). The plan check reads the planner's own constants instead.
 */
export interface RecordedBar {
  readonly left: readonly [number, number];
  readonly right: readonly [number, number];
  /** The danger gap between them; adjacent rectangles imply it, a recording may state it. */
  readonly gap: readonly [number, number];
}

const GEOMETRY_EDGE_SLACK_PX = 14;
/** Two edges move independently, so a width may drift by both. */
const GEOMETRY_WIDTH_SLACK_PX = 2 * GEOMETRY_EDGE_SLACK_PX;
/** Centres are the thing a tap plan uses; measured spread was ±5.5 px. */
const GEOMETRY_CENTRE_SLACK_PX = 10;

export interface RecordedBarOptions {
  /**
   * Whether the caller also asked for the plan check, which needs the recorded zones. Only used to
   * make the warning name every check the missing bar disables: `planned: 0` with an empty
   * `planViolations` must not read as a clean plan check.
   */
  readonly planCheck?: boolean;
}

export async function readRecordedBar(
  dir: string,
  options: RecordedBarOptions = {},
): Promise<RecordedBar | null> {
  const disabled =
    options.planCheck === true
      ? 'the chest-qte geometry cross-check and the plan check are'
      : 'the chest-qte geometry cross-check is';
  let text: string;
  try {
    text = await readFile(join(dir, 'measurements.json'), 'utf8');
  } catch {
    warn(`no measurements.json in ${dir}; ${disabled} off`);
    return null;
  }

  let bar: RecordedBar | null = null;
  try {
    const parsed = JSON.parse(text) as {
      bar?: { leftZone?: unknown; hazardGap?: unknown; rightZone?: unknown };
    };
    const left = readablePair(parsed.bar?.leftZone);
    const right = readablePair(parsed.bar?.rightZone);
    if (left && right) {
      const gap = readablePair(parsed.bar?.hazardGap) ?? ([left[1], right[0]] as const);
      bar = { left, right, gap };
    }
  } catch {
    bar = null;
  }
  if (!bar) {
    warn(`measurements.json in ${dir} has no readable bar; ${disabled} off`);
  }
  return bar;
}

function warn(message: string): void {
  console.warn(`replay: ${message}`);
}

function readablePair(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [from, to] = value as unknown[];
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return [from, to];
}

/**
 * The payload this harness dereferences, checked before it is touched. `QteState` says the zones
 * are there; a recogniser is a separate module and can violate its own type at runtime, and the
 * failure must stay a value for frame N (contracts §0.6), never a `TypeError` that kills the run.
 */
function hasReadableZones(value: unknown): value is QteState {
  if (typeof value !== 'object' || value === null) return false;
  const zones = (value as { zones?: unknown }).zones;
  if (!Array.isArray(zones)) return false;
  return zones.every((zone) => {
    if (typeof zone !== 'object' || zone === null) return false;
    const candidate = zone as { from?: unknown; to?: unknown };
    return Number.isFinite(candidate.from) && Number.isFinite(candidate.to);
  });
}

/** `null` when the zones fit the recording; otherwise the sentence that names what is wrong. */
export function geometryProblem(qte: unknown, bar: RecordedBar): string | null {
  if (!hasReadableZones(qte)) return 'observation carries no readable zones';
  if (qte.zones.length !== 2) return `has ${qte.zones.length} zones, expected 2`;

  const recorded = [bar.left, bar.right] as const;
  const names = ['left', 'right'] as const;
  for (let side = 0; side < 2; side += 1) {
    const zone = qte.zones[side];
    const [from, to] = recorded[side];
    if (
      zone.from < from - GEOMETRY_EDGE_SLACK_PX ||
      zone.to > to + GEOMETRY_EDGE_SLACK_PX
    ) {
      return (
        `${names[side]} zone [${zone.from}, ${zone.to}] lies outside the recorded ` +
        `[${from}, ${to}] ± ${GEOMETRY_EDGE_SLACK_PX} px`
      );
    }

    const width = zone.to - zone.from + 1;
    if (Math.abs(width - (to - from + 1)) > GEOMETRY_WIDTH_SLACK_PX) {
      return (
        `${names[side]} zone is ${width} px wide, the recorded one ` +
        `${to - from + 1} px ± ${GEOMETRY_WIDTH_SLACK_PX}`
      );
    }

    const centre = (zone.from + zone.to) / 2;
    const recordedCentre = (from + to) / 2;
    if (Math.abs(centre - recordedCentre) > GEOMETRY_CENTRE_SLACK_PX) {
      return (
        `${names[side]} zone centre ${centre} is ${Math.abs(centre - recordedCentre)} px ` +
        `from the recorded ${recordedCentre}`
      );
    }
  }

  const gap = qte.zones[1].from - qte.zones[0].to - 1;
  const recordedGap = bar.gap[1] - bar.gap[0] - 1;
  if (Math.abs(gap - recordedGap) > GEOMETRY_EDGE_SLACK_PX) {
    return (
      `hazard gap is ${gap} px, the recorded one ${recordedGap} px ` +
      `± ${GEOMETRY_EDGE_SLACK_PX}`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Video facts
// ---------------------------------------------------------------------------------------------

interface VideoInfo {
  readonly size: { readonly width: number; readonly height: number };
  readonly fps: number;
  readonly frameBytes: number;
}

async function findRecording(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    throw new Error(`cannot read replay directory ${dir}: ${messageOf(error)}`);
  }
  const videos = entries.filter((entry) => entry.toLowerCase().endsWith('.mp4')).sort();
  const first = videos[0];
  if (first === undefined) throw new Error(`no .mp4 recording in ${dir}`);
  return join(dir, first);
}

/** ffprobe's answer for the frame size and nominal rate; a missing answer is a setup failure. */
function probeVideo(video: string): VideoInfo {
  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate',
      '-of', 'json',
      video,
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw new Error(`ffprobe could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`ffprobe exited ${result.status} for ${video}: ${result.stderr.trim()}`);
  }

  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  const stream = parsed.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    throw new Error(`ffprobe did not report a frame size for ${video}`);
  }
  const fps = frameRate(stream?.r_frame_rate) ?? frameRate(stream?.avg_frame_rate);
  if (fps === null) throw new Error(`ffprobe did not report a frame rate for ${video}`);

  return { size: { width, height }, fps, frameBytes: width * height * 4 };
}

function frameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!numerator || !denominator || !Number.isFinite(numerator / denominator)) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------

/** Every id, compiler-enforced: adding a `ScreenId` breaks this literal, not a count. */
function emptyScreens(): Record<ScreenId, number> {
  return {
    town: 0,
    worldmap: 0,
    dungeon: 0,
    dungeonmap: 0,
    combat: 0,
    'chest-open': 0,
    'chest-qte': 0,
    'chest-prompt': 0,
    loot: 0,
    loading: 0,
    unknown: 0,
  };
}

/**
 * A view of the frame's bytes. `allocUnsafeSlow` gives the buffer its own `ArrayBuffer`, so the
 * view can never alias the Node buffer pool; the frame owns exactly this frame's pixels.
 */
function rgbaView(buffer: Buffer, frameBytes: number): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, frameBytes);
}

function onPath(tool: string): boolean {
  const result = spawnSync(tool, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}
