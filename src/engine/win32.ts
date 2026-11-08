/**
 * The World side of Win32 (contracts §1, §4, §5): capture and input realized through the engine
 * child. Capture, input and the stop hotkey happen in that process; the frame's **pixels** arrive
 * through the shared frame channel (the child publishes raw BGRA), and the World reads the newest
 * slot as a copy — there is no decode at all in the loop. JPEG is encoded here, in the World, only
 * for the escalation snapshot: slow, rare, and never on the tick path (the vision module, 2026-11-07).
 */
import jpeg from 'jpeg-js';
import type {
  ActionFailure,
  ActionResult,
  EngineReply,
  EngineRequest,
  Frame,
  FrameSource,
  PixelRect,
  RgbaImage,
} from '../contracts.ts';
import { cropBgra } from './crop.mjs';
import { encodePng } from '../perception/ledger.ts';
import { scaleBgra } from './scale.mjs';
import {
  isStaleFrame,
  MAX_CAPTURE_WIDTH,
  MIN_CAPTURE_WIDTH,
  type EngineCapture,
  type EngineForeground,
  type EngineInputAck,
} from './protocol.ts';
import { latest, type FrameChannel, type ServedFrame } from './vision/frame-channel.ts';

/** The part of the engine the World needs; `EngineClient` (./child.ts) satisfies it, tests fake it. */
export interface EngineRequester {
  request(request: EngineRequest): Promise<EngineReply>;
}

/** A request that carries input; capture and foreground are reads. */
export type InputRequest = Extract<EngineRequest, { op: 'tap' } | { op: 'key' } | { op: 'drag' }>;

/**
 * The focus buffer. The operator launches the game after the World is already running, and Windows
 * can land `SetForegroundWindow` a frame or two after the call returns, so one immediate check is
 * not evidence that focus was refused. Four attempts, 200 ms apart, and a 200 ms settle after the
 * window takes the foreground: ~1 s of buffer before an input is refused.
 */
const FOCUS_ATTEMPTS = 4;
const FOCUS_RETRY_MS = 200;
const FOCUS_SETTLE_MS = 200;

/** The test seam for the retry loop; production uses `setTimeout`. */
export interface FocusOptions {
  readonly attempts?: number;
  readonly retryMs?: number;
  readonly settleMs?: number;
  readonly wait?: (ms: number) => Promise<void>;
}

const waitFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bring the game window to the foreground and hold it there for a beat, or report that Windows
 * refused. It does nothing when the window already holds the foreground, so a session start does
 * not tap Alt into a focused game. A missing window is retried too: the World starts before the
 * operator launches the game, and the first command after that launch is the one that heals.
 */
export async function focusGame(
  engine: EngineRequester,
  options: FocusOptions = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? FOCUS_ATTEMPTS);
  const retryMs = Math.max(0, options.retryMs ?? FOCUS_RETRY_MS);
  const settleMs = Math.max(0, options.settleMs ?? FOCUS_SETTLE_MS);
  const wait = options.wait ?? waitFor;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await engine.request({ op: 'foreground' });
    if (current.ok && (current.value as Partial<EngineForeground> | null)?.foreground === true) return true;
    const focused = await engine.request({ op: 'focus' });
    if (focused.ok && (focused.value as { foreground?: boolean } | null)?.foreground === true) {
      // The window holds the foreground; let the game arm its input before the press that follows.
      if (settleMs > 0) await wait(settleMs);
      return true;
    }
    if (attempt < attempts - 1) await wait(retryMs);
  }
  return false;
}

/** `ActionResult` plus the measured input leg when the child reported one (contracts §5). */
export type InputOutcome = ActionResult & { readonly inputMs?: number };

/**
 * The one failure a foreground miss can be (ruling R4). `ActionFailure` is closed, so "the window
 * is not foreground" is the detail of a `rejected`, never a name of its own.
 */
export const NOT_FOREGROUND: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };

const failure = (reply: Extract<EngineReply, { ok: false }>): ActionResult =>
  reply.detail === undefined
    ? { ok: false, reason: reply.error }
    : { ok: false, reason: reply.error, detail: reply.detail };

/**
 * Sends one input to the game after taking the foreground. The foreground is asserted first, but a
 * miss is not final: the World asks for the focus, waits out the buffer, and only then reports
 * `not-foreground` — the old one-shot check is what left a session pressing into a window that had
 * never taken focus. The child asserts again immediately before `SendInput`, so a focus change
 * between the query and the input is still refused; and when it did send, it reports how long the
 * input leg took, which the planner uses instead of assuming one.
 */
export async function sendInput(
  engine: EngineRequester,
  request: InputRequest,
  focus?: FocusOptions,
): Promise<InputOutcome> {
  const foreground = await engine.request({ op: 'foreground' });
  if (!foreground.ok) return failure(foreground);
  const value = foreground.value as Partial<EngineForeground> | null;
  if (value?.foreground !== true && !(await focusGame(engine, focus))) return { ...NOT_FOREGROUND };
  const sent = await engine.request(request);
  if (!sent.ok) return failure(sent);
  const ack = sent.value as Partial<EngineInputAck> | null;
  return typeof ack?.inputMs === 'number' && Number.isFinite(ack.inputMs) && ack.inputMs >= 0
    ? { ok: true, inputMs: ack.inputMs }
    : { ok: true };
}

/**
 * A capture that produced no frame. `FrameSource.capture` has no failure channel (contracts §1),
 * so a source rejects and the loop turns that into a stop or an escalate (§0.6).
 */
export class EngineCaptureError extends Error {
  constructor(readonly reason: ActionFailure, readonly detail?: string) {
    super(detail === undefined ? `capture ${reason}` : `capture ${reason}: ${detail}`);
    this.name = 'EngineCaptureError';
  }
}

/**
 * `FrameSource` over the engine child and the frame channel (contracts §1, §5).
 *
 * `capture()` asks the child for its newest frame, checks the reply's age, and reads the published
 * slot: the pixels are a copy the channel's seqlock already made (2 ms for 1920×1080), and
 * `toRgba()` only swaps BGRA to RGBA. There is no decoder here any more — the native JPEG decode
 * that used to cost 10–20 ms a frame, and its jpeg-js fallback, are gone with the encoder.
 *
 * `captureBand(rect)` serves the same frame and crops the rectangle **locally**: the QTE sampler asks
 * for the bar's own rectangle, and a rectangle of a copied slot costs a row copy instead of a native
 * decode. `atMs` is the reply instant minus the reply's `ageMs` — the child reports durations, never
 * timestamps (§0.4) — so a band and a full frame are stamped by the same rule.
 */
export class Win32Capture implements FrameSource {
  constructor(
    private readonly engine: EngineRequester,
    private readonly channel: FrameChannel,
  ) {}

  async capture(): Promise<Frame> {
    const reply = await this.engine.request({ op: 'capture' });
    // stamped at the reply, not at the request: the round trip is latency, and charging it to the
    // frame's age would make every frame older than it is (contracts §0.4, §7)
    const receivedAt = performance.now();
    const value = captureOf(reply);
    if (isStaleFrame(value.ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
    const served = this.serve();
    let image: RgbaImage | undefined;
    return {
      atMs: receivedAt - value.ageMs,
      width: value.width,
      height: value.height,
      // toRgba() is once per frame in practice; the contract allows two calls and the second is free
      toRgba: async (): Promise<RgbaImage> => {
        image ??= toRgbaImage(served.pixels, served.width, served.height);
        return image;
      },
    };
  }

  /**
   * The next frame cropped to `rect` (contracts §1). The rectangle is refused here, before the wire,
   * when it is not a legal crop, and again when it does not fit the frame: a caller's bad rectangle
   * must not become a frame the QTE parser reads at the wrong columns.
   */
  async captureBand(rect: PixelRect): Promise<Frame> {
    if (!isCropRect(rect)) throw new EngineCaptureError('rejected', 'crop-out-of-range');
    const reply = await this.engine.request({ op: 'capture' });
    const receivedAt = performance.now();
    const value = captureOf(reply);
    if (isStaleFrame(value.ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
    const served = this.serve();
    let cropped;
    try {
      cropped = cropBgra(served.pixels, served.width, served.height, rect);
    } catch {
      throw new EngineCaptureError('rejected', 'crop-out-of-frame');
    }
    let image: RgbaImage | undefined;
    return {
      atMs: receivedAt - value.ageMs,
      width: cropped.width,
      height: cropped.height,
      toRgba: async (): Promise<RgbaImage> => {
        image ??= toRgbaImage(cropped.pixels, cropped.width, cropped.height);
        return image;
      },
    };
  }

  /** The newest published frame, or the stale-frame refusal the loop already knows how to take. */
  private serve(): ServedFrame {
    const served = latest(this.channel, { nowMs: Date.now() });
    if (served === null) throw new EngineCaptureError('timeout', 'stale-frame');
    return served;
  }
}

/** A JPEG exactly as the World encoded it, with the size it was encoded at. */
export interface CapturedJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The config's own default snapshot quality; `main.ts` passes the live `jpegQuality`. */
const DEFAULT_SNAPSHOT_QUALITY = 75;

/**
 * The escalation snapshot (contracts §5): the newest frame, downscaled and encoded **in the World**.
 *
 * This is the only JPEG on the machine now, and it exists because the bytes leave it: the model reads
 * the image. The loop never pays for it — the encode is 174 ms for a full 1920×1080 frame and the
 * escalation is a rare, on-demand path (the design measured it; the child's native encoder is gone
 * with the crash it caused). The downscale is the same box filter the child used for `maxWidth`
 * (`scale.mjs`), now over the copied slot, and a request at or above the frame's width comes back
 * native: a snapshot is never upscaled.
 *
 * `source.capture()` proves a fresh frame exists and refuses a stale one by the loop's own rule; the
 * pixels then come from the channel's newest slot, already a copy. An out-of-range `maxWidth` is
 * refused here, before either the request or the capture: it is a caller bug, and a clamped guess
 * would hand the model a different size than the caller's coordinates assume.
 *
 * A failure is the same `EngineCaptureError` the plain capture throws: the caller decides whether a
 * question without an image is still worth asking (it is — the text carries the perception line).
 */
/**
 * The **lossless** snapshot: the same newest frame as `captureJpeg`, encoded as PNG instead.
 *
 * It exists because the evidence that outlives a run must not be re-encoded. Twice on 2026-11-08 a
 * refusal could not be reproduced from the run's own snapshot: the q75 encode smoothed the one ink
 * column that split a digit, and the saved frame parsed where the live raw frame had refused. The JPEG
 * still goes to the model (it reads either); the PNG goes to the ledger, where a triage pass can replay
 * the refusal byte for byte.
 */
export async function capturePng(
  source: FrameSource,
  channel: FrameChannel,
  maxWidth?: number,
): Promise<CapturedJpeg> {
  if (
    maxWidth !== undefined
    && (!Number.isInteger(maxWidth) || maxWidth < MIN_CAPTURE_WIDTH || maxWidth > MAX_CAPTURE_WIDTH)
  ) {
    throw new EngineCaptureError('rejected', 'maxWidth-out-of-range');
  }
  await source.capture();
  const served = latest(channel, { nowMs: Date.now() });
  if (served === null) throw new EngineCaptureError('timeout', 'stale-frame');
  const scaled = maxWidth === undefined
    ? { pixels: served.pixels, width: served.width, height: served.height }
    : scaleBgra(served.pixels, served.width, served.height, maxWidth);
  const bytes = encodePng({ data: toRgba(scaled.pixels), width: scaled.width, height: scaled.height });
  return { bytes: Uint8Array.from(bytes), width: scaled.width, height: scaled.height };
}

export async function captureJpeg(
  source: FrameSource,
  channel: FrameChannel,
  maxWidth?: number,
  quality: number = DEFAULT_SNAPSHOT_QUALITY,
): Promise<CapturedJpeg> {
  if (
    maxWidth !== undefined
    && (!Number.isInteger(maxWidth) || maxWidth < MIN_CAPTURE_WIDTH || maxWidth > MAX_CAPTURE_WIDTH)
  ) {
    throw new EngineCaptureError('rejected', 'maxWidth-out-of-range');
  }
  // A frame stale by the loop's rule is stale for the snapshot too: ask through the source.
  await source.capture();
  const served = latest(channel, { nowMs: Date.now() });
  if (served === null) throw new EngineCaptureError('timeout', 'stale-frame');
  // A request at or above the native width needs no scaling; scaleBgra returns the buffer as-is then.
  const scaled = maxWidth === undefined
    ? { pixels: served.pixels, width: served.width, height: served.height }
    : scaleBgra(served.pixels, served.width, served.height, maxWidth);
  const encoded = jpeg.encode(
    { data: toRgba(scaled.pixels), width: scaled.width, height: scaled.height },
    quality,
  );
  return { bytes: Uint8Array.from(encoded.data), width: encoded.width, height: encoded.height };
}

/** Whether a value is a legal `captureBand` rectangle: four integers, a non-negative origin and a
 *  positive size — the same check `cropBgra` makes, made before the wire so a bad rectangle cannot
 *  become a child request the codec drops. */
function isCropRect(value: unknown): value is PixelRect {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return typeof x === 'number' && Number.isInteger(x) && x >= 0
    && typeof y === 'number' && Number.isInteger(y) && y >= 0
    && typeof width === 'number' && Number.isInteger(width) && width >= 1
    && typeof height === 'number' && Number.isInteger(height) && height >= 1;
}

/** The capture metadata a well-behaved child sends; anything else is the protocol lying. */
function captureOf(reply: EngineReply): EngineCapture {
  if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
  const value: unknown = reply.value;
  if (typeof value !== 'object' || value === null) throw new EngineCaptureError('unavailable', 'malformed-capture');
  const { seq, width, height, ageMs } = value as Partial<EngineCapture>;
  if (
    typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1
    || typeof width !== 'number' || !Number.isInteger(width) || width <= 0
    || typeof height !== 'number' || !Number.isInteger(height) || height <= 0
    || typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0
  ) {
    throw new EngineCaptureError('unavailable', 'malformed-capture');
  }
  return { seq, width, height, ageMs };
}

/** BGRA (the capture's order) to RGBA (the contract's), in one 32-bit pass over a fresh buffer. */
function toRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length);
  out.set(bgra);
  const pixels = new Uint32Array(out.buffer, out.byteOffset, out.length >>> 2);
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index]!;
    pixels[index] = (value & 0xff00ff00) | ((value & 0x00ff0000) >>> 16) | ((value & 0x000000ff) << 16);
  }
  return out;
}

function toRgbaImage(bgra: Uint8Array, width: number, height: number): RgbaImage {
  return { data: toRgba(bgra), width, height };
}
