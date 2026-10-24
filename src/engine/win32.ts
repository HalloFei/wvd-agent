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
  RgbaImage,
} from '../contracts.ts';
import { decodeJpeg } from './gdiplus.mjs';
import {
  isStaleFrame,
  type EngineCapture,
  type EngineForeground,
  type EngineInputAck,
} from './protocol.ts';

/** The part of the engine the World needs; `EngineClient` (./child.ts) satisfies it, tests fake it. */
export interface EngineRequester {
  request(request: EngineRequest): Promise<EngineReply>;
}

/** A request that carries input; capture and foreground are reads. */
export type InputRequest = Extract<EngineRequest, { op: 'tap' } | { op: 'key' }>;

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
 * Sends one input to the game after asserting its precondition. When the window is not foreground
 * nothing but the query is sent. The child asserts again immediately before `SendInput`, so a focus
 * change between the query and the input is still refused; and when it did send, it reports how long
 * the input leg took, which the planner uses instead of assuming one.
 */
export async function sendInput(engine: EngineRequester, request: InputRequest): Promise<InputOutcome> {
  const foreground = await engine.request({ op: 'foreground' });
  if (!foreground.ok) return failure(foreground);
  const value = foreground.value as Partial<EngineForeground> | null;
  if (value?.foreground !== true) return { ...NOT_FOREGROUND };
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
    const reply = await this.engine.request({ op: 'capture' });
    // stamped at the reply, before the base64 decode: decoding is work after the observation, and
    // charging it to the frame's age would make every frame older than it is
    const receivedAt = performance.now();
    if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
    const { jpeg: base64, width, height, ageMs } = captureValue(reply.value);
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
 */
export async function captureJpeg(engine: EngineRequester, maxWidth?: number): Promise<CapturedJpeg> {
  const reply = await engine.request(maxWidth === undefined ? { op: 'capture' } : { op: 'capture', maxWidth });
  if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
  const { jpeg: base64, width, height, ageMs } = captureValue(reply.value);
  // the same freshness rule as a perception capture: an old frame that looks new is worse than none
  if (isStaleFrame(ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
  return { bytes: Uint8Array.from(Buffer.from(base64, 'base64')), width, height };
}

/** The capture value a well-behaved child sends; anything else is the protocol lying. */
function captureValue(value: unknown): EngineCapture {
  if (typeof value !== 'object' || value === null) throw new EngineCaptureError('unavailable', 'malformed-capture');
  const { jpeg: base64, width, height, ageMs } = value as Partial<EngineCapture>;
  if (
    typeof base64 !== 'string'
    || typeof width !== 'number' || !Number.isInteger(width) || width <= 0
    || typeof height !== 'number' || !Number.isInteger(height) || height <= 0
    || typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0
  ) {
    throw new EngineCaptureError('unavailable', 'malformed-capture');
  }
  return { jpeg: base64, width, height, ageMs };
}
