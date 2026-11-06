import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { bandSampler } from '../src/actions/qte.ts';
import type { EngineReply, EngineRequest } from '../src/contracts.ts';
import { FRAME_MAX_AGE_MS, MAX_CAPTURE_WIDTH, MIN_CAPTURE_WIDTH } from '../src/engine/protocol.ts';
import { captureJpeg, Win32Capture, type EngineRequester } from '../src/engine/win32.ts';
import { memoryOverBuffer } from '../src/engine/vision/channel-memory.ts';
import {
  createChannel, layoutChannel, publish, type FrameChannel,
} from '../src/engine/vision/frame-channel.ts';

/**
 * The World's frame source over the channel (plan Task 4, Task 7): the engine reply is metadata only
 * and the pixels come from the shared slot, so these tests drive a Buffer-backed channel and a fake
 * requester — no window, no child, no decode.
 */
class FakeEngine implements EngineRequester {
  readonly seen: EngineRequest[] = [];

  constructor(private readonly reply: EngineReply) {}

  async request(request: EngineRequest): Promise<EngineReply> {
    this.seen.push(request);
    return this.reply;
  }
}

/** The metadata a well-behaved child replies after publishing a frame (contracts §5). */
function captureOk(width: number, height: number, ageMs = 0, seq = 1): EngineReply {
  return { id: 1, ok: true, value: { seq, width, height, ageMs } };
}

function channelOf(width: number, height: number): FrameChannel {
  const layout = layoutChannel({ width, height, slots: 2 });
  return createChannel(memoryOverBuffer(Buffer.alloc(layout.bytes)), layout);
}

/** A BGRA frame whose every pixel names itself: B = x, G = y, R = x + 10, A = 255. */
function picture(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      pixels[at] = x;
      pixels[at + 1] = y;
      pixels[at + 2] = x + 10;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

const WIDTH = 6;
const HEIGHT = 4;

describe('Win32Capture over the frame channel', () => {
  it('serves the newest slot as RGBA, with the reply\'s size and clock', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    const pixels = picture(WIDTH, HEIGHT);
    const capturedAtMs = Date.now();
    publish(channel, pixels, { capturedAtMs });
    const engine = new FakeEngine(captureOk(WIDTH, HEIGHT, 20, 7));

    const before = performance.now();
    const frame = await new Win32Capture(engine, channel).capture();

    expect(engine.seen).toEqual([{ op: 'capture' }]);
    expect(frame.width).toBe(WIDTH);
    expect(frame.height).toBe(HEIGHT);
    // the child reports durations, never timestamps: the World stamps atMs from the reply's age
    expect(frame.atMs).toBeGreaterThanOrEqual(before - 20);
    expect(frame.atMs).toBeLessThanOrEqual(performance.now() - 20);

    const image = await frame.toRgba();
    expect(image.width).toBe(WIDTH);
    expect(image.height).toBe(HEIGHT);
    expect(image.data.length).toBe(WIDTH * HEIGHT * 4);
    // BGRA in the slot, RGBA out: every pixel, so a channel or stride slip is visible
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const at = (y * WIDTH + x) * 4;
        expect([...image.data.subarray(at, at + 4)]).toEqual([x + 10, y, x, 255]);
      }
    }
  });

  it('stamps atMs from the reported age at reply time, not from the request time', async () => {
    const AGE_MS = 120;
    const DELAY_MS = 25;
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });
    const engine: EngineRequester = {
      async request() {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return captureOk(WIDTH, HEIGHT, AGE_MS);
      },
    };

    const before = performance.now();
    const frame = await new Win32Capture(engine, channel).capture();
    const after = performance.now();

    // atMs = the reply instant minus ageMs, which cannot be the request instant 25 ms earlier
    // (5 ms of slack for timer rounding; request-time semantics would be 25 ms below the bound)
    expect(frame.atMs).toBeGreaterThanOrEqual(before + DELAY_MS - AGE_MS - 5);
    expect(frame.atMs).toBeLessThanOrEqual(after - AGE_MS);
  });

  it('hands out a copy: a later publish never rewrites a frame already taken', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });
    const source = new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT)), channel);

    const frame = await source.capture();
    const first = await frame.toRgba();
    // the writer reuses the slot on the next publish; the reader's copy must not change
    publish(channel, new Uint8Array(WIDTH * HEIGHT * 4).fill(0xab), { capturedAtMs: Date.now() });
    const second = await frame.toRgba();

    expect([...first.data]).toEqual([...second.data]);
    expect(second.data[0]).toBe(0 + 10);
  });

  it('refuses when nothing has been published yet', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    const source = new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT)), channel);

    await expect(source.capture()).rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });

  it('refuses a slot older than the channel\'s stale window', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() - 5_000 });

    await expect(new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT)), channel).capture())
      .rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });

  it('refuses a reply whose age is past the three-tick window', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });

    await expect(new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT, FRAME_MAX_AGE_MS + 1)), channel).capture())
      .rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });

  it('passes the engine failure through unchanged', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    const engine = new FakeEngine({ id: 1, ok: false, error: 'unavailable', detail: 'window-not-found' });

    await expect(new Win32Capture(engine, channel).capture())
      .rejects.toMatchObject({ reason: 'unavailable', detail: 'window-not-found' });
  });

  it('refuses a capture value that is not the contract\'s metadata', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });
    const engine = new FakeEngine({ id: 1, ok: true, value: { width: WIDTH, height: HEIGHT, ageMs: 0 } });

    await expect(new Win32Capture(engine, channel).capture())
      .rejects.toMatchObject({ reason: 'unavailable', detail: 'malformed-capture' });
  });
});

describe('Win32Capture.captureBand over the frame channel', () => {
  const RECT = { x: 2, y: 1, width: 3, height: 2 };

  it('crops the rectangle out of the served slot, without a second capture', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });
    const engine = new FakeEngine(captureOk(WIDTH, HEIGHT));

    const frame = await new Win32Capture(engine, channel).captureBand(RECT);

    expect(engine.seen).toEqual([{ op: 'capture' }]);
    expect(frame.width).toBe(RECT.width);
    expect(frame.height).toBe(RECT.height);
    const image = await frame.toRgba();
    expect(image.width).toBe(RECT.width);
    expect(image.height).toBe(RECT.height);
    for (let y = 0; y < RECT.height; y += 1) {
      for (let x = 0; x < RECT.width; x += 1) {
        const at = (y * RECT.width + x) * 4;
        expect([...image.data.subarray(at, at + 4)]).toEqual([RECT.x + x + 10, RECT.y + y, RECT.x + x, 255]);
      }
    }
  });

  it('refuses a malformed rectangle before the wire', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });
    const engine = new FakeEngine(captureOk(WIDTH, HEIGHT));
    const source = new Win32Capture(engine, channel);

    for (const rect of [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: -1, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: 1, height: 0 },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1 },
    ]) {
      await expect(source.captureBand(rect as never), JSON.stringify(rect))
        .rejects.toMatchObject({ reason: 'rejected', detail: 'crop-out-of-range' });
    }
    // a bad rectangle never becomes a request: the engine is asked nothing at all
    expect(engine.seen).toEqual([]);
  });

  it('refuses a rectangle that reaches past the frame', async () => {
    const channel = channelOf(WIDTH, HEIGHT);
    publish(channel, picture(WIDTH, HEIGHT), { capturedAtMs: Date.now() });

    await expect(new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT)), channel)
      .captureBand({ x: WIDTH - 1, y: 0, width: 2, height: 1 }))
      .rejects.toMatchObject({ reason: 'rejected', detail: 'crop-out-of-frame' });
  });

  it('refuses a band when the channel has no fresh frame', async () => {
    const channel = channelOf(WIDTH, HEIGHT);

    await expect(new Win32Capture(new FakeEngine(captureOk(WIDTH, HEIGHT)), channel).captureBand(RECT))
      .rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });
});


describe('the escalation snapshot (plan Task 5)', () => {
  /** Four BGRA quadrants, so a scaled frame's decoded corners still say which source quadrant they came from. */
  function quadrants(width: number, height: number): Uint8Array {
    const colours = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255]];
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const colour = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!;
        pixels.set([...colour, 255], (y * width + x) * 4);
      }
    }
    return pixels;
  }

  const SNAPSHOT_WIDTH = 192;
  const SNAPSHOT_HEIGHT = 108;

  function snapshotSource(reply: EngineReply = captureOk(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)) {
    const channel = channelOf(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
    publish(channel, quadrants(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT), { capturedAtMs: Date.now() });
    const engine = new FakeEngine(reply);
    return { source: new Win32Capture(engine, channel), channel, engine };
  }

  /** The decoded RGBA centre of one quadrant. */
  function centre(decoded: { width: number; height: number; data: Uint8Array }, quadrant: number): number[] {
    const x = Math.floor(decoded.width / 4) + (quadrant % 2) * Math.floor(decoded.width / 2);
    const y = Math.floor(decoded.height / 4) + Math.floor(quadrant / 2) * Math.floor(decoded.height / 2);
    const at = (y * decoded.width + x) * 4;
    return [...decoded.data.subarray(at, at + 4)];
  }

  it('crops nothing from perception: a native request encodes the frame at its own size', async () => {
    const { source, channel } = snapshotSource();

    const snapshot = await captureJpeg(source, channel);

    expect(snapshot.width).toBe(SNAPSHOT_WIDTH);
    expect(snapshot.height).toBe(SNAPSHOT_HEIGHT);
    expect([...snapshot.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    const decoded = jpeg.decode(snapshot.bytes, { useTArray: true, formatAsRGBA: true });
    expect([decoded.width, decoded.height]).toEqual([SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT]);
  });

  it('downscales the frame to maxWidth, in the World, and keeps the quadrants', async () => {
    const { source, channel } = snapshotSource();

    const snapshot = await captureJpeg(source, channel, 96);

    expect(snapshot.width).toBe(96);
    expect(snapshot.height).toBe(54);
    const decoded = jpeg.decode(snapshot.bytes, { useTArray: true, formatAsRGBA: true });
    expect([decoded.width, decoded.height]).toEqual([96, 54]);
    // The quadrants are written as BGRA, so in the decoded RGBA: blue, red, green, yellow. JPEG is
    // lossy and the box filter averages; the channel order and the quadrant placement are not.
    const expected = [[0, 0, 255, 255], [255, 0, 0, 255], [0, 255, 0, 255], [255, 255, 0, 255]];
    for (let quadrant = 0; quadrant < 4; quadrant += 1) {
      const actual = centre(decoded, quadrant);
      for (let channelIndex = 0; channelIndex < 3; channelIndex += 1) {
        expect(Math.abs(actual[channelIndex]! - expected[quadrant]![channelIndex]!)).toBeLessThanOrEqual(12);
      }
    }
  });

  it('never upscales: a maxWidth at or above the frame comes back native', async () => {
    const { source, channel } = snapshotSource();

    const atNative = await captureJpeg(source, channel, SNAPSHOT_WIDTH);
    const above = await captureJpeg(source, channel, 1280);

    expect([atNative.width, atNative.height]).toEqual([SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT]);
    expect([above.width, above.height]).toEqual([SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT]);
  });

  it('refuses an out-of-range maxWidth before the wire, naming the field', async () => {
    const { source, channel, engine } = snapshotSource();

    for (const maxWidth of [MIN_CAPTURE_WIDTH - 1, MAX_CAPTURE_WIDTH + 1, 0, -640, 1280.5, Number.NaN]) {
      await expect(captureJpeg(source, channel, maxWidth), String(maxWidth)).rejects.toMatchObject({
        name: 'EngineCaptureError',
        reason: 'rejected',
        detail: 'maxWidth-out-of-range',
      });
    }
    // a bad value never reaches the child, and never pays for a capture: the loop's rule is the
    // request's own refusal, not a reply that never comes
    expect(engine.seen).toEqual([]);
  });

  it('refuses a snapshot when the channel has no fresh frame', async () => {
    const channel = channelOf(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

    await expect(captureJpeg(new Win32Capture(new FakeEngine(captureOk(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)), channel), channel))
      .rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });
});

describe('the QTE band (plan Task 7)', () => {
  it('samples the QTE window off the channel instead of a full frame', async () => {
    // The QTE window is a 631x699 rectangle of a 1920x1080 frame; the band sampler asks for that
    // rectangle and parses it at its origin. A uniform slot has no bar, so the sampler must answer
    // `bar-gone`: pixels arrived (not `capture-failed`) and the full frame was never asked for.
    const width = 1920;
    const height = 1080;
    const channel = channelOf(width, height);
    publish(channel, new Uint8Array(width * height * 4), { capturedAtMs: Date.now() });
    const engine = new FakeEngine(captureOk(width, height));
    const source = new Win32Capture(engine, channel);

    let fullCaptures = 0;
    const guarded = {
      capture: async () => {
        fullCaptures += 1;
        return source.capture();
      },
      captureBand: (rect: { x: number; y: number; width: number; height: number }) => source.captureBand(rect),
    };

    const sample = await bandSampler(guarded).sample();

    expect(sample).toEqual({ ok: false, reason: 'bar-gone' });
    expect(fullCaptures).toBe(0);
    expect(engine.seen).toEqual([{ op: 'capture' }]);
  });
});
