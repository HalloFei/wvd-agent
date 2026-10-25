/**
 * The World side of Win32 (contracts §1, §4, §5): capture and input realized through the engine
 * child. Capture, input and the stop hotkey happen in that process; JPEG **decoding** happens here
 * through GDI+ (R19), because `toRgba()` runs on the World thread and jpeg-js needs 179–359 ms for a
 * 2 MP frame — the half-tick budget is 50 ms.
 */
import jpeg from 'jpeg-js';
import type {
  ActionFailure,
  ActionResult,
  EngineEvent,
  EngineReply,
  EngineRequest,
  Frame,
  FrameSource,
  PixelRect,
  RgbaImage,
} from '../contracts.ts';
import { decodeJpeg } from './gdiplus.mjs';
import {
  isStaleFrame,
  MAX_CAPTURE_WIDTH,
  MIN_CAPTURE_WIDTH,
  type EngineCapture,
  type EngineForeground,
  type EngineInputAck,
} from './protocol.ts';

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

/** Decodes the base64 JPEG a capture reply carries into RGBA. */
export type JpegDecoder = (bytes: Uint8Array) => RgbaImage | Promise<RgbaImage>;

export interface Win32CaptureOptions {
  /** Defaults to native GDI+ (`decodeJpeg`); tests inject a fake. */
  decode?: JpegDecoder;
  /** A degraded decode path is reported here as `engineProblem` (R23), wired to the World. */
  onProblem?: (event: EngineEvent) => void;
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

/** `FrameSource` over the engine child: the child ships JPEG bytes, never raw BGRA. */
export class Win32Capture implements FrameSource {
  private readonly decode: JpegDecoder;
  private readonly onProblem: (event: EngineEvent) => void;
  private nativeDecodeBroken = false;

  constructor(private readonly engine: EngineRequester, options: Win32CaptureOptions = {}) {
    this.decode = options.decode ?? ((bytes) => decodeJpeg(bytes));
    this.onProblem = options.onProblem
      ?? ((event) => console.error(`[wvd] ${event.kind}${event.kind === 'engineProblem' ? `: ${event.detail}` : ''}`));
  }

  async capture(): Promise<Frame> {
    return this.frameFrom(await this.engine.request({ op: 'capture' }));
  }

  /**
   * The next frame cropped to `rect` (contracts §1). The request is refused here, before the wire,
   * when `rect` is not a legal crop: the codec would drop the line, the child would send no reply,
   * and the World would wait out `engineTimeoutMs` without ever naming the field — the same refusal
   * `captureJpeg` makes for `maxWidth`. A reply that is not the band asked for is refused by
   * `frameFrom`, because a full frame parsed as a band is silently wrong rather than merely missing.
   */
  async captureBand(rect: PixelRect): Promise<Frame> {
    if (!isCropRect(rect)) throw new EngineCaptureError('rejected', 'crop-out-of-range');
    return this.frameFrom(await this.engine.request({ op: 'capture', crop: rect }), rect);
  }

  /**
   * The one body `capture()` and `captureBand()` share — the `atMs` stamp, the stale-frame refusal
   * and the lazy decode — so the two can never drift apart. With a `band` given, the reply must
   * prove it is that band: no echoed `crop` at all is an older child that ignored the request and
   * sent the native frame.
   */
  private frameFrom(reply: EngineReply, band?: PixelRect): Frame {
    // stamped at the reply, before the base64 decode: decoding is work after the observation, and
    // charging it to the frame's age would make every frame older than it is
    const receivedAt = performance.now();
    if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
    const value = captureValue(reply.value);
    if (band !== undefined && !isEchoedBand(value, band)) {
      throw new EngineCaptureError('unavailable', 'malformed-capture');
    }
    const { jpeg: base64, width, height, ageMs } = value;
    if (isStaleFrame(ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
    // the child reports a duration, never a timestamp (§0.4): the World stamps the frame from it
    const atMs = receivedAt - ageMs;
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    let decoded: Promise<RgbaImage> | undefined;
    return {
      atMs,
      width,
      height,
      // toRgba() is once per frame in practice; the contract allows two calls and the second is free
      toRgba: (): Promise<RgbaImage> => {
        decoded ??= this.decodeFrame(bytes);
        return decoded;
      },
    };
  }

  private async decodeFrame(bytes: Uint8Array): Promise<RgbaImage> {
    if (!this.nativeDecodeBroken) {
      try {
        return await this.decode(bytes);
      } catch {
        this.nativeDecodeBroken = true;
        this.onProblem({ kind: 'engineProblem', detail: 'native-decoder-unavailable' });
      }
    }
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { data: image.data, width: image.width, height: image.height };
  }
}

/** A JPEG exactly as the child encoded it, with the size it was encoded at. */
export interface CapturedJpeg {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * The escalation snapshot (contracts §5): the child's newest frame, **re-encoded by nobody**.
 *
 * The World asks for a second capture rather than re-encoding `Frame.toRgba()` — that would spend
 * ~100 ms undoing the encode the child already paid for, and lose a second generation of JPEG. The
 * request carries `maxWidth` (`escalationImageWidth`), and the child box-filters the next frame
 * *before* encoding it: the bytes arrive at or below that width and the returned `width`/`height`
 * describe the JPEG actually returned, not the window. A request at or above the native width comes
 * back native — the snapshot is never upscaled — and the perception path never scales at all.
 *
 * A failure is the same `EngineCaptureError` the plain capture throws: the caller decides whether a
 * question without an image is still worth asking (it is — the text carries the perception line).
 * An out-of-range `maxWidth` is refused here, before the wire: the codec would drop the line as
 * malformed (its convention for `tap`/`key`), the child would send no reply, and the World would
 * wait out `engineTimeoutMs` without ever naming the field.
 */
export async function captureJpeg(engine: EngineRequester, maxWidth?: number): Promise<CapturedJpeg> {
  if (
    maxWidth !== undefined
    && (!Number.isInteger(maxWidth) || maxWidth < MIN_CAPTURE_WIDTH || maxWidth > MAX_CAPTURE_WIDTH)
  ) {
    throw new EngineCaptureError('rejected', 'maxWidth-out-of-range');
  }
  const reply = await engine.request(maxWidth === undefined ? { op: 'capture' } : { op: 'capture', maxWidth });
  if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
  const { jpeg: base64, width, height, ageMs } = captureValue(reply.value);
  // the same freshness rule as a perception capture: an old frame that looks new is worse than none
  if (isStaleFrame(ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
  return { bytes: Uint8Array.from(Buffer.from(base64, 'base64')), width, height };
}

/** Whether a value is a legal `capture.crop`: four integers, a non-negative origin and a positive
 *  size — exactly what the wire codec accepts, so this is the check that keeps a bad rectangle from
 *  becoming a dropped line nobody answers. */
function isCropRect(value: unknown): value is PixelRect {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  return typeof x === 'number' && Number.isInteger(x) && x >= 0
    && typeof y === 'number' && Number.isInteger(y) && y >= 0
    && typeof width === 'number' && Number.isInteger(width) && width >= 1
    && typeof height === 'number' && Number.isInteger(height) && height >= 1;
}

/**
 * Whether a reply is exactly the band that was asked for: the echoed `crop` present and equal field
 * for field, with the reply's own `width`/`height` equal to it too. Anything else — no `crop` (an
 * older child that ignored the request and sent the native frame), a different rectangle, mismatched
 * dimensions — must never be parsed as a band: the crop's coordinates are the whole point, and a
 * full frame read as one is silently wrong rather than merely late.
 */
function isEchoedBand(reply: EngineCapture, rect: PixelRect): boolean {
  const crop: unknown = reply.crop;
  if (typeof crop !== 'object' || crop === null) return false;
  const echoed = crop as Partial<PixelRect>;
  return echoed.x === rect.x && echoed.y === rect.y
    && echoed.width === rect.width && echoed.height === rect.height
    && reply.width === rect.width && reply.height === rect.height;
}

/** The capture value a well-behaved child sends; anything else is the protocol lying. */
function captureValue(value: unknown): EngineCapture {
  if (typeof value !== 'object' || value === null) throw new EngineCaptureError('unavailable', 'malformed-capture');
  const { jpeg: base64, width, height, ageMs, crop } = value as Partial<EngineCapture>;
  if (
    typeof base64 !== 'string'
    || typeof width !== 'number' || !Number.isInteger(width) || width <= 0
    || typeof height !== 'number' || !Number.isInteger(height) || height <= 0
    || typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0
  ) {
    throw new EngineCaptureError('unavailable', 'malformed-capture');
  }
  // the echoed crop is judged only by `captureBand`; a plain capture ignores it, as it always has
  return { jpeg: base64, width, height, ageMs, crop };
}
