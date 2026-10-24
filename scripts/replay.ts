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
 * that crosses a reversal, names a delay outside the horizon or targets a point outside the
 * recording's zones is our planning model's answer, not perception's, so it is named in its own
 * `planViolations` list. `planned` says how many plans the model returned at all.
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
  QteZone,
  RgbaImage,
  ScreenId,
  TapPlan,
} from '../src/contracts.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { ChestPerceiver, parseQte, qteWindow } from '../src/perception/chest.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { MapPerceiver } from '../src/perception/map.ts';
import { planTap, qteVelocity } from '../src/policy/qte.ts';

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
  /** Plans that crossed a reversal, missed a recorded zone or named an impossible delay. */
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
   * readings at their own `atMs`, `qteVelocity`, then `planTap` with the contracts' defaults — and
   * check every returned plan against `measurements.json`: a finite delay inside the horizon, a
   * target inside a recorded zone, and no reversal crossed in the direction of travel. This is the
   * only check of the planning model against recorded marker motion (design acceptance 5); off when
   * `measurements.json` has no readable bar, since there is nothing to check a plan against.
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
 * `options.planCheck` adds the planning model's check against the recorded zones and bounce.
 */
export async function replay(dir: string, options: ReplayOptions = {}): Promise<ReplayReport> {
  const tools = replayTools();
  if (!tools.ok) throw new Error(`cannot replay ${dir}: ${tools.reason}`);

  const recording = await findRecording(dir);
  const info = probeVideo(recording);
  const recordedBar = await readRecordedBar(dir);
  const bandCheck = options.bandCheck === true;
  const planCheck = options.planCheck === true;

  const screens = emptyScreens();
  const failures: string[] = [];
  const band: BandTally = { frames: 0, mismatches: 0 };
  // The plan check needs the recording's zones and bounce to judge a plan; without a readable bar
  // there is nothing independent to check it against (readRecordedBar has already warned).
  const plan: PlanTally | null =
    planCheck && recordedBar ? { bar: recordedBar, readings: [], planned: 0, violations: [] } : null;
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

  return {
    frames,
    screens,
    failures,
    bandFrames: band.frames,
    bandMismatches: band.mismatches,
    planned: plan?.planned ?? 0,
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

/** One `chest-qte` reading the plan check keeps: the composite's own numbers, never a re-parse. */
interface PlanReading {
  readonly atMs: number;
  readonly markerX: number;
  readonly zones: readonly QteZone[];
}

interface PlanTally {
  /** The recording's zones and bounce, the independent facts a plan is judged against. */
  readonly bar: RecordedBar;
  /** The last three readings, oldest first: what `qteVelocity` reads and no more. */
  readonly readings: PlanReading[];
  planned: number;
  readonly violations: string[];
}

/**
 * The contracts' defaults for the three `planTap` inputs (`WVD_DEFAULTS`, contracts §7):
 * `measurements.json` records none of them, so there is no measured value to read. The numbers it
 * *does* record — the zones and the bounce — reach the check through `RecordedBar`, which is what
 * makes the target test an independent fact rather than `planTap`'s own input.
 */
const PLAN_LATENCY_MS = 75;
const PLAN_DECEL_PX_PER_S2 = 3000;
const PLAN_HORIZON_MS = 1000;

/**
 * Feed one `chest-qte` observation to the planning model exactly as the sub-loop would: its own
 * `atMs`, its own marker and its own zones. With three readings in hand, measure the speed; a
 * refusal is legitimate (a triple that straddles a bounce, or the easing near one, carries no
 * velocity), so only a *plan* is counted and checked.
 *
 * Design acceptance 5 asks for exactly this: the sub-loop, fed the recording's frames at their own
 * timestamps, plans presses that land inside the recorded zones. The unit tests drive `planTap` with
 * a synthetic constant-speed stream; this is the only place the model meets real recorded marker
 * motion.
 */
function checkPlan(plan: PlanTally, atMs: number, qte: QteState, index: number): void {
  plan.readings.push({ atMs, markerX: qte.markerX, zones: qte.zones });
  if (plan.readings.length > 3) plan.readings.shift();
  if (plan.readings.length < 3) return;

  const v = qteVelocity(plan.readings[0]!, plan.readings[1]!, plan.readings[2]!);
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
  for (const problem of planProblems(tap, v, plan.bar)) {
    plan.violations.push(`frame ${index}: ${problem}`);
  }
}

/**
 * What makes a returned plan wrong, judged without asking the planner: the instant must be a
 * finite, non-negative delay inside the horizon; the target must lie inside a zone
 * `measurements.json` recorded; and it must not be past the recording's bounce in the direction of
 * travel — a target beyond a reversal cannot arrive on the half-line the marker is on.
 *
 * The planner's own guards make most of these impossible for a correct model, which is the point:
 * the check exists to catch a wrong sign, a wrong bounce or zones read from the wrong place, not to
 * re-run the planner's refusals.
 */
function planProblems(tap: TapPlan, v: number, bar: RecordedBar): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(tap.atMs) || tap.atMs < 0) {
    problems.push(`plan delay ${tap.atMs} is not finite and non-negative`);
  } else if (tap.atMs > PLAN_HORIZON_MS) {
    problems.push(`plan delay ${tap.atMs.toFixed(1)} ms exceeds the ${PLAN_HORIZON_MS} ms horizon`);
  }
  if (!insideZone(tap.target, bar.left) && !insideZone(tap.target, bar.right)) {
    problems.push(`plan target ${tap.target} is not inside a recorded zone`);
  }
  const bounce = v > 0 ? bar.bounce[1] : bar.bounce[0];
  if (v > 0 ? tap.target > bounce : tap.target < bounce) {
    problems.push(
      `plan target ${tap.target} is past the recording's bounce at ${bounce} in the direction of travel`,
    );
  }
  return problems;
}

/** Inclusive: `measurements.json` draws its zones as closed pixel columns. */
function insideZone(x: number, zone: readonly [number, number]): boolean {
  return x >= zone[0] && x <= zone[1];
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
 * a recording omits it, the adjacent zone edges imply it. `marker.bounceAt` is read the same way:
 * when the recording states the marker's reversal points, a plan may not target past them; when it
 * does not, the bar's own outer edges imply them (the left zone's first column and one past the
 * right zone's last), which is what the QTE bar's ends mean.
 */
export interface RecordedBar {
  readonly left: readonly [number, number];
  readonly right: readonly [number, number];
  /** The danger gap between them; adjacent rectangles imply it, a recording may state it. */
  readonly gap: readonly [number, number];
  /** The marker's reversal points; `marker.bounceAt` states them, the bar's ends imply them. */
  readonly bounce: readonly [number, number];
}

const GEOMETRY_EDGE_SLACK_PX = 14;
/** Two edges move independently, so a width may drift by both. */
const GEOMETRY_WIDTH_SLACK_PX = 2 * GEOMETRY_EDGE_SLACK_PX;
/** Centres are the thing a tap plan uses; measured spread was ±5.5 px. */
const GEOMETRY_CENTRE_SLACK_PX = 10;

export async function readRecordedBar(dir: string): Promise<RecordedBar | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'measurements.json'), 'utf8');
  } catch {
    warn(`no measurements.json in ${dir}; the chest-qte geometry cross-check is off`);
    return null;
  }

  let bar: RecordedBar | null = null;
  try {
    const parsed = JSON.parse(text) as {
      bar?: { leftZone?: unknown; hazardGap?: unknown; rightZone?: unknown };
      marker?: { bounceAt?: unknown };
    };
    const left = readablePair(parsed.bar?.leftZone);
    const right = readablePair(parsed.bar?.rightZone);
    if (left && right) {
      const gap = readablePair(parsed.bar?.hazardGap) ?? ([left[1], right[0]] as const);
      const bounce = readablePair(parsed.marker?.bounceAt) ?? ([left[0], right[1] + 1] as const);
      bar = { left, right, gap, bounce };
    }
  } catch {
    bar = null;
  }
  if (!bar) {
    warn(`measurements.json in ${dir} has no readable bar; the chest-qte geometry cross-check is off`);
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
