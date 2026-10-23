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
 * - the decoded stream ended with a partial frame, or ffmpeg produced a frame the harness could not
 *   turn into an image.
 *
 * A malformed or absent `measurements.json` disables only the geometry check (a recording may be
 * replayed before it has measurements); everything else still runs. It **warns** when it does so, so
 * a switched-off cross-check cannot be mistaken for one that passed. A setup failure — no video,
 * `ffmpeg`/`ffprobe` missing, ffmpeg exiting non-zero — throws rather than returning a tally that
 * would look like a measurement.
 *
 * ## Recogniser order and floors
 *
 * Each recogniser keeps its own floor (composite.ts). This harness uses the route's act floor, 0.5
 * (contracts §6), so the tally is "what the route would act on", not a parsing score. Order is
 * cheapest decisive gate first: the chest band is 2.2 % of a frame and is the recording's subject;
 * the map's coordinate readout is the decisive map gate; the HUD's uniformity sample is the widest
 * read and comes last.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame, Observation, QteState, RgbaImage, ScreenId } from '../src/contracts.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { MapPerceiver } from '../src/perception/map.ts';

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
 * which `chest-qte` zones are checked.
 */
export async function replay(dir: string): Promise<ReplayReport> {
  const tools = replayTools();
  if (!tools.ok) throw new Error(`cannot replay ${dir}: ${tools.reason}`);

  const recording = await findRecording(dir);
  const info = probeVideo(recording);
  const recordedBar = await readRecordedBar(dir);

  const screens = emptyScreens();
  const failures: string[] = [];
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
          await observeFrame(frame, index, composite, recordedBar, screens, failures);
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

  return { frames, screens, failures };
}

// ---------------------------------------------------------------------------------------------
// Perception, one frame
// ---------------------------------------------------------------------------------------------

async function observeFrame(
  frame: Frame,
  index: number,
  composite: CompositePerceiver,
  recordedBar: RecordedBar | null,
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
  }
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
// The recorded geometry
// ---------------------------------------------------------------------------------------------

/**
 * `measurements.json`'s `bar` rectangle, as drawn. `parseQte` reports the zones' **fill interior**,
 * which over the recording sat 0–11 px inside these edges (left 696–919 against 694–922, right
 * 1000–1223 against 997–1223; research-qte-parser §4). The slack is that measured relationship plus
 * the 8 px edge error a marker parked on a zone edge causes — 14 px, with the centre check doing the
 * real work. `hazardGap` is read when present (it measures the danger gap, not the fill gap); where
 * a recording omits it, the adjacent zone edges imply it.
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
