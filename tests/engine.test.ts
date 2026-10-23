import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, EngineReply, EngineRequest } from '../src/contracts.ts';
import { FRAME_MAX_AGE_MS, LineDecoder, decodeLine, encodeEvent, encodeReply, encodeRequest } from '../src/engine/protocol.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { parseHotkey } from '../src/engine/hotkey.mjs';
import { sendInput, Win32Capture, type EngineRequester } from '../src/engine/win32.ts';

/** An engine that records what it was asked and answers from a script. */
class FakeEngine implements EngineRequester {
  readonly seen: EngineRequest[] = [];
  atRequest = 0;

  constructor(private readonly reply: EngineReply | ((request: EngineRequest) => EngineReply)) {}

  async request(request: EngineRequest): Promise<EngineReply> {
    this.seen.push(request);
    this.atRequest = performance.now();
    return typeof this.reply === 'function' ? this.reply(request) : this.reply;
  }
}

describe('engine protocol', () => {
  it('round-trips a capture request', () => {
    const line = encodeRequest(7, { op: 'capture' });
    expect(line.endsWith('\n')).toBe(true);
    expect(decodeLine(line)).toEqual({ request: { id: 7, request: { op: 'capture' } } });
  });

  it('round-trips a rejected reply, failure name and all', () => {
    const reply = { id: 3, ok: false, error: 'rejected', detail: 'not-foreground' } as const;
    expect(decodeLine(encodeReply(reply))).toEqual({ reply });
  });

  it('round-trips a successful reply carrying a capture value', () => {
    const reply = { id: 4, ok: true, value: { jpeg: 'AA==', width: 2, height: 1 } } as const;
    expect(decodeLine(encodeReply(reply))).toEqual({ reply });
  });

  it('round-trips the stop-hotkey event', () => {
    expect(decodeLine(encodeEvent({ kind: 'stopHotkey' }))).toEqual({ event: { kind: 'stopHotkey' } });
  });

  it('round-trips an engineProblem event with its detail', () => {
    const event = { kind: 'engineProblem', detail: 'stop-hotkey-unregistered' } as const;
    expect(decodeLine(encodeEvent(event))).toEqual({ event });
  });

  it('drops malformed lines instead of turning them into messages', () => {
    expect(decodeLine('not json')).toBeNull();
    expect(decodeLine('{"id":1,"ok":false,"error":"exploded"}')).toBeNull();
    expect(decodeLine('{"id":1,"request":{"op":"teleport"}}')).toBeNull();
    expect(decodeLine('{"id":1,"request":{"op":"tap","x":1,"y":2,"count":3}}')).toBeNull();
  });

  it('splits a byte stream into lines across chunk boundaries', () => {
    const decoder = new LineDecoder();
    const wire = encodeRequest(1, { op: 'capture' }) + encodeRequest(2, { op: 'foreground' });
    // cut inside the first line, not on a boundary: the decoder must hold the leftover
    const cut = 10;
    expect(decoder.push(wire.slice(0, cut))).toEqual([]);
    expect(decoder.push(wire.slice(cut)).map((line) => decodeLine(line))).toEqual([
      { request: { id: 1, request: { op: 'capture' } } },
      { request: { id: 2, request: { op: 'foreground' } } },
    ]);
  });
});

describe('engine input guard', () => {
  it('refuses with rejected/not-foreground when the engine reports the window is not foreground', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: { foreground: false } });

    const result = await sendInput(engine, { op: 'tap', x: 10, y: 20, count: 1 });

    expect(result).toEqual({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    // the precondition is asserted before anything is sent: only the foreground query went out
    expect(engine.seen).toEqual([{ op: 'foreground' }]);
  });

  it('sends the input once the window is foreground and reports success', async () => {
    const engine = new FakeEngine((request) => request.op === 'foreground'
      ? { id: 1, ok: true, value: { foreground: true } }
      : { id: 2, ok: true, value: null });

    const result = await sendInput(engine, { op: 'key', scan: 0x11, holdMs: 60 });

    expect(result).toEqual({ ok: true });
    expect(engine.seen).toEqual([{ op: 'foreground' }, { op: 'key', scan: 0x11, holdMs: 60 }]);
  });

  it('passes a child-side rejection through unchanged', async () => {
    const engine = new FakeEngine((request) => request.op === 'foreground'
      ? { id: 1, ok: true, value: { foreground: true } }
      : { id: 2, ok: false, error: 'rejected', detail: 'not-foreground' });

    expect(await sendInput(engine, { op: 'tap', x: 1, y: 2, count: 2 }))
      .toEqual({ ok: false, reason: 'rejected', detail: 'not-foreground' });
  });

  it('passes a transport failure through, without inventing a detail', async () => {
    const engine = new FakeEngine((request) => request.op === 'foreground'
      ? { id: 1, ok: true, value: { foreground: true } }
      : { id: 2, ok: false, error: 'timeout' });

    expect(await sendInput(engine, { op: 'tap', x: 1, y: 2, count: 1 }))
      .toEqual({ ok: false, reason: 'timeout' });
  });

  it('carries the child-measured input leg in the outcome (R20b)', async () => {
    const engine = new FakeEngine((request) => request.op === 'foreground'
      ? { id: 1, ok: true, value: { foreground: true } }
      : { id: 2, ok: true, value: { inputMs: 73.5 } });

    expect(await sendInput(engine, { op: 'key', scan: 0x1e, holdMs: 60 }))
      .toEqual({ ok: true, inputMs: 73.5 });
  });
});

describe('Win32Capture', () => {
  const WIDTH = 4;
  const HEIGHT = 3;
  // a colour the JPEG round trip keeps: black/white edges would hide a channel swap
  const RGBA = new Uint8Array(Array.from({ length: WIDTH * HEIGHT }, () => [40, 120, 200, 255]).flat());
  const JPEG = jpeg.encode({ data: RGBA, width: WIDTH, height: HEIGHT }, 95).data;
  const captureReply = (ageMs = 0): EngineReply => ({
    id: 2,
    ok: true,
    value: { jpeg: Buffer.from(JPEG).toString('base64'), width: WIDTH, height: HEIGHT, ageMs },
  });

  it('returns a frame whose atMs precedes the capture and whose size the engine reports', async () => {
    // the frame is 50 ms old when the reply arrives, so its capture instant is before the request
    const engine = new FakeEngine((request) => (request.op === 'capture' ? captureReply(50) : { id: 1, ok: false, error: 'unavailable' }));

    const frame = await new Win32Capture(engine).capture();

    expect(frame.width).toBe(WIDTH);
    expect(frame.height).toBe(HEIGHT);
    expect(frame.atMs).toBeLessThanOrEqual(engine.atRequest);
    expect(engine.seen).toEqual([{ op: 'capture' }]);
  });

  it('decodes the JPEG into RGBA pixels inside the source', async () => {
    const engine = new FakeEngine(captureReply());

    const rgba = await new Win32Capture(engine).capture().then((frame) => frame.toRgba());

    expect(rgba.width).toBe(WIDTH);
    expect(rgba.height).toBe(HEIGHT);
    expect(rgba.data).toBeInstanceOf(Uint8Array);
    expect(rgba.data.length).toBe(WIDTH * HEIGHT * 4);
    // the encoder is lossy, the channel order is not
    expect(Math.abs(rgba.data[0]! - 40)).toBeLessThanOrEqual(6);
    expect(Math.abs(rgba.data[1]! - 120)).toBeLessThanOrEqual(6);
    expect(Math.abs(rgba.data[2]! - 200)).toBeLessThanOrEqual(6);
  });

  it('rejects with the engine failure when the child has no frame', async () => {
    const engine = new FakeEngine({ id: 1, ok: false, error: 'unavailable', detail: 'window-not-found' });

    await expect(new Win32Capture(engine).capture())
      .rejects.toMatchObject({ reason: 'unavailable', detail: 'window-not-found' });
  });

  it('stamps atMs from the reported age at reply time, not from the request time', async () => {
    const AGE_MS = 120;
    const DELAY_MS = 25;
    const before = performance.now();
    const engine: EngineRequester = {
      async request() {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return captureReply(AGE_MS);
      },
    };

    const frame = await new Win32Capture(engine).capture();
    const after = performance.now();

    // atMs = the reply instant minus ageMs, which cannot be the request instant 25 ms earlier
    // (5 ms of slack for timer rounding; request-time semantics would be 25 ms below the bound)
    expect(frame.atMs).toBeGreaterThanOrEqual(before + DELAY_MS - AGE_MS - 5);
    expect(frame.atMs).toBeLessThanOrEqual(after - AGE_MS);
  });

  it('refuses a frame older than three ticks', async () => {
    const engine = new FakeEngine(captureReply(FRAME_MAX_AGE_MS + 1));

    await expect(new Win32Capture(engine).capture())
      .rejects.toMatchObject({ reason: 'timeout', detail: 'stale-frame' });
  });

  it('serves a frame exactly at the three-tick boundary', async () => {
    const engine = new FakeEngine(captureReply(FRAME_MAX_AGE_MS));

    const frame = await new Win32Capture(engine).capture();

    expect(frame.width).toBe(WIDTH);
  });

  it('refuses a capture value that carries no ageMs', async () => {
    const engine = new FakeEngine({
      id: 1,
      ok: true,
      value: { jpeg: Buffer.from(JPEG).toString('base64'), width: WIDTH, height: HEIGHT },
    });

    await expect(new Win32Capture(engine).capture())
      .rejects.toMatchObject({ reason: 'unavailable', detail: 'malformed-capture' });
  });

  it('decodes each frame once even when toRgba is called twice', async () => {
    let calls = 0;
    const decode = () => {
      calls++;
      return { data: new Uint8Array(4), width: 1, height: 1 };
    };
    const frame = await new Win32Capture(new FakeEngine(captureReply()), { decode }).capture();

    const [first, second] = await Promise.all([frame.toRgba(), frame.toRgba()]);

    expect(calls).toBe(1);
    expect(first).toBe(second);
  });

  it('falls back to jpeg-js and reports native-decoder-unavailable once (R23)', async () => {
    const problems: EngineEvent[] = [];
    const capture = new Win32Capture(new FakeEngine(captureReply()), {
      decode: () => {
        throw new Error('no gdiplus here');
      },
      onProblem: (event) => problems.push(event),
    });

    const first = await (await capture.capture()).toRgba();
    const second = await (await capture.capture()).toRgba();

    expect(first.width).toBe(WIDTH);
    expect(second.width).toBe(WIDTH);
    expect(problems).toEqual([{ kind: 'engineProblem', detail: 'native-decoder-unavailable' }]);
  });
});

describe('stop hotkey parser', () => {
  it('requires a modifier, so a bare key cannot be swallowed globally', () => {
    expect(parseHotkey('w')).toBeNull();
    expect(parseHotkey('F5')).toBeNull();
    expect(parseHotkey('Shift')).toBeNull();
  });

  it('parses the default stop key', () => {
    expect(parseHotkey('Ctrl+Alt+W')).toEqual({ mods: 0x1 | 0x2, vk: 0x57 });
  });

  it('rejects two keys and unknown names', () => {
    expect(parseHotkey('Ctrl+W+Q')).toBeNull();
    expect(parseHotkey('Ctrl+What')).toBeNull();
  });
});

describe('engine child process', () => {
  it.skipIf(process.platform !== 'win32')('buffers engineProblem until onEvent subscribes, and forwards stderr', async () => {
    const lines: string[] = [];
    const engine = connectEngine(
      startEngine({ title: `__wvd_no_such_window_${process.pid}__`, hotkey: 'NotAKey' }),
      { timeoutMs: 15000, logger: (line) => lines.push(line) },
    );
    try {
      // the child emits the problem at startup; subscribe long after, so only buffering can save it
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const problem = await new Promise<EngineEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no buffered engineProblem event')), 10000);
        engine.onEvent((event) => {
          if (event.kind !== 'engineProblem') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      expect(problem).toEqual({ kind: 'engineProblem', detail: 'stop-hotkey-unregistered' });
      expect(lines.some((line) => line.startsWith('[wvd-engine] ready'))).toBe(true);
    } finally {
      engine.close();
    }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('starts under this Node and answers the protocol without a window', async () => {
    const engine = connectEngine(
      startEngine({ title: `__wvd_no_such_window_${process.pid}__`, hotkey: '' }),
      { timeoutMs: 15000 },
    );
    try {
      expect(await engine.request({ op: 'foreground' })).toMatchObject({ ok: true, value: { foreground: false } });
      expect(await engine.request({ op: 'capture' }))
        .toMatchObject({ ok: false, error: 'unavailable', detail: 'window-not-found' });
      expect(await engine.request({ op: 'tap', x: 1, y: 2, count: 1 }))
        .toMatchObject({ ok: false, error: 'unavailable', detail: 'window-not-found' });
    } finally {
      engine.close();
    }
  }, 30000);
});
