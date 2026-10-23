/**
 * The World side of Win32 (contracts §1, §4, §5): capture and input realized through the engine
 * child. Every native call happens in `./child.mjs`; what lives here only speaks the protocol, so
 * the untestable part stays in one process and one file.
 */
import jpeg from 'jpeg-js';
import type {
  ActionFailure,
  ActionResult,
  EngineReply,
  EngineRequest,
  Frame,
  FrameSource,
  RgbaImage,
} from '../contracts.ts';
import { isStaleFrame, type EngineCapture, type EngineForeground } from './protocol.ts';

/** The part of the engine the World needs; `EngineClient` (./child.ts) satisfies it, tests fake it. */
export interface EngineRequester {
  request(request: EngineRequest): Promise<EngineReply>;
}

/** A request that carries input; capture and foreground are reads. */
export type InputRequest = Extract<EngineRequest, { op: 'tap' } | { op: 'key' }>;

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
 * change between the query and the input is still refused.
 */
export async function sendInput(engine: EngineRequester, request: InputRequest): Promise<ActionResult> {
  const foreground = await engine.request({ op: 'foreground' });
  if (!foreground.ok) return failure(foreground);
  const value = foreground.value as Partial<EngineForeground> | null;
  if (value?.foreground !== true) return { ...NOT_FOREGROUND };
  const sent = await engine.request(request);
  return sent.ok ? { ok: true } : failure(sent);
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
  constructor(private readonly engine: EngineRequester) {}

  async capture(): Promise<Frame> {
    const reply = await this.engine.request({ op: 'capture' });
    if (!reply.ok) throw new EngineCaptureError(reply.error, reply.detail);
    const { jpeg: base64, width, height, ageMs } = captureValue(reply.value);
    if (isStaleFrame(ageMs)) throw new EngineCaptureError('timeout', 'stale-frame');
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    // the child reports a duration, never a timestamp (§0.4): the World stamps the frame from it
    const atMs = performance.now() - ageMs;
    return {
      atMs,
      width,
      height,
      toRgba: async (): Promise<RgbaImage> => {
        const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
        return { data: image.data, width: image.width, height: image.height };
      },
    };
  }
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
