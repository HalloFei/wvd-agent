import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, EngineReply, EngineRequest } from '../src/contracts.ts';
import { MAX_DRAG_MS, MAX_PRESS_HOLD_MS, TEARDOWN_GRACE_MS } from '../src/contracts.ts';
import {
  FRAME_MAX_AGE_MS,
  LineDecoder,
  MAX_CAPTURE_WIDTH,
  MAX_DRAG_MS as PROTOCOL_MAX_DRAG_MS,
  MIN_CAPTURE_WIDTH,
  decodeLine,
  encodeEvent,
  encodeReply,
  encodeRequest,
} from '../src/engine/protocol.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { parseHotkey } from '../src/engine/hotkey.mjs';
import { captureJpeg, focusGame, sendInput, Win32Capture, type EngineRequester } from '../src/engine/win32.ts';

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

describe('focusGame', () => {
  it('does nothing when the window already holds the foreground', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: { foreground: true } });
    expect(await focusGame(engine)).toBe(true);
    expect(engine.seen.map((request) => request.op)).toEqual(['foreground']);
  });

  it('asks the child to focus when it does not, settles, and believes the reply', async () => {
    const replies: Record<string, unknown> = {
      foreground: { id: 1, ok: true, value: { foreground: false } },
      focus: { id: 2, ok: true, value: { foreground: true } },
    };
    const engine = new FakeEngine((request) => replies[request.op] as never);
    const waits: number[] = [];
    expect(await focusGame(engine, { wait: async (ms) => { waits.push(ms); } })).toBe(true);
    expect(engine.seen.map((request) => request.op)).toEqual(['foreground', 'focus']);
    // the window is foreground, but the game gets a beat to arm its input before the press
    expect(waits).toEqual([200]);
  });

  it('takes the focus on a later attempt', async () => {
    let focusCalls = 0;
    const engine = new FakeEngine((request) => {
      if (request.op === 'foreground') return { id: 1, ok: true, value: { foreground: false } } as never;
      focusCalls += 1;
      return { id: 2, ok: true, value: { foreground: focusCalls >= 2 } } as never;
    });
    const waits: number[] = [];
    expect(await focusGame(engine, { attempts: 3, settleMs: 0, wait: async (ms) => { waits.push(ms); } })).toBe(true);
    expect(focusCalls).toBe(2);
    expect(waits).toEqual([200]);
  });

  it('retries a refused focus with the buffer, then reports it', async () => {
    const engine = new FakeEngine((request) => request.op === 'foreground'
      ? { id: 1, ok: true, value: { foreground: false } }
      : { id: 2, ok: true, value: { foreground: false } });
    const waits: number[] = [];
    expect(await focusGame(engine, { attempts: 3, wait: async (ms) => { waits.push(ms); } })).toBe(false);
    expect(engine.seen.map((request) => request.op))
      .toEqual(['foreground', 'focus', 'foreground', 'focus', 'foreground', 'focus']);
    expect(waits).toEqual([200, 200]);
  });

  it('retries a focus request whose window is not up yet', async () => {
    let foregroundQueries = 0;
    const engine = new FakeEngine((request) => {
      if (request.op === 'foreground') {
        foregroundQueries += 1;
        return { id: 1, ok: true, value: { foreground: false } } as never;
      }
      return { id: 2, ok: false, error: 'unavailable', detail: 'window-not-found' } as never;
    });
    const waits: number[] = [];
    expect(await focusGame(engine, { attempts: 2, retryMs: 50, wait: async (ms) => { waits.push(ms); } })).toBe(false);
    expect(foregroundQueries).toBe(2);
    expect(waits).toEqual([50]);
  });
});

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

  it('round-trips a focus request and drops one carrying fields', () => {
    expect(decodeLine(encodeRequest(12, { op: 'focus' }))).toEqual({ request: { id: 12, request: { op: 'focus' } } });
    expect(decodeLine(JSON.stringify({ id: 1, request: { op: 'focus', x: 1 } }))).toEqual({ request: { id: 1, request: { op: 'focus' } } });
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

  it('round-trips a drag request and drops a malformed one', () => {
    const request = { op: 'drag', x1: 10, y1: 20, x2: 300, y2: 40, durationMs: 300 } as const;
    expect(decodeLine(encodeRequest(11, request))).toEqual({ request: { id: 11, request } });

    const malformed = [
      { op: 'drag', x1: 10, y1: 20, x2: 300, y2: 40 },
      { op: 'drag', x1: '10', y1: 20, x2: 300, y2: 40, durationMs: 300 },
      { op: 'drag', x1: 10, y1: 20, x2: 300, y2: 40, durationMs: 0 },
      { op: 'drag', x1: 10, y1: 20, x2: 300, y2: 40, durationMs: MAX_DRAG_MS + 1 },
      { op: 'drag', x1: 10, y1: 20, x2: 300, y2: null, durationMs: 300 },
    ];
    for (const bad of malformed) {
      expect(decodeLine(JSON.stringify({ id: 1, request: bad })), JSON.stringify(bad)).toBeNull();
    }
  });

  it('keeps maxWidth on a capture request (contracts §5)', () => {
    const line = encodeRequest(8, { op: 'capture', maxWidth: 1280 });
    expect(decodeLine(line)).toEqual({ request: { id: 8, request: { op: 'capture', maxWidth: 1280 } } });
  });

  it('drops a capture request whose maxWidth is not a sane integer, rather than guessing', () => {
    for (const maxWidth of [1280.5, '1280', 0, -640, MIN_CAPTURE_WIDTH - 1, MAX_CAPTURE_WIDTH + 1, null, true]) {
      const line = JSON.stringify({ id: 1, request: { op: 'capture', maxWidth } });
      expect(decodeLine(line), `maxWidth ${JSON.stringify(maxWidth)}`).toBeNull();
    }
  });

  it('accepts a capture request at both declared maxWidth bounds', () => {
    for (const maxWidth of [MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH]) {
      expect(decodeLine(JSON.stringify({ id: 2, request: { op: 'capture', maxWidth } })))
        .toEqual({ request: { id: 2, request: { op: 'capture', maxWidth } } });
    }
  });

  it('carries a crop rectangle on capture and drops a malformed one', () => {
    const line = encodeRequest(9, { op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } });
    expect(decodeLine(line)).toEqual({
      request: { id: 9, request: { op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } } },
    });
  });

  it.each([
    ['a missing field', { x: 0, y: 0, width: 10 }],
    ['a fractional value', { x: 0, y: 0, width: 10.5, height: 10 }],
    ['a negative origin', { x: -1, y: 0, width: 10, height: 10 }],
    ['a zero size', { x: 0, y: 0, width: 0, height: 10 }],
    ['a non-object', 42],
  ])('refuses a crop with %s', (_label, crop) => {
    expect(decodeLine(JSON.stringify({ id: 3, request: { op: 'capture', crop } }))).toBeNull();
  });

  it('accepts a band-only crop well under the maxWidth floor, since a crop has bounds of its own', () => {
    const crop = { x: 645, y: 36, width: 10, height: 47 };
    expect(decodeLine(JSON.stringify({ id: 5, request: { op: 'capture', crop } })))
      .toEqual({ request: { id: 5, request: { op: 'capture', crop } } });
  });

  it('drops a capture that asks for both a crop and a maxWidth, since they size the output differently', () => {
    const line = JSON.stringify({
      id: 4,
      request: { op: 'capture', maxWidth: 1280, crop: { x: 0, y: 0, width: 10, height: 10 } },
    });
    expect(decodeLine(line)).toBeNull();
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

describe('escalation snapshot width', () => {
  const CAPTURE = { jpeg: 'AA==', width: 2, height: 1, ageMs: 0 } as const;

  it('rejects an out-of-range maxWidth before the wire, naming the field', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: CAPTURE });

    for (const maxWidth of [MIN_CAPTURE_WIDTH - 1, MAX_CAPTURE_WIDTH + 1, 0, -640, 1280.5, Number.NaN]) {
      await expect(captureJpeg(engine, maxWidth), String(maxWidth)).rejects.toMatchObject({
        name: 'EngineCaptureError',
        reason: 'rejected',
        detail: 'maxWidth-out-of-range',
      });
    }
    // a bad value never reaches the child, where the codec would drop the line and the reply would
    // never come: the World would wait out engineTimeoutMs and never learn why
    expect(engine.seen).toEqual([]);
  });

  it('sends the bounds and the absent/native request unchanged', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: CAPTURE });

    await captureJpeg(engine, MIN_CAPTURE_WIDTH);
    await captureJpeg(engine, MAX_CAPTURE_WIDTH);
    await captureJpeg(engine);

    expect(engine.seen).toEqual([
      { op: 'capture', maxWidth: MIN_CAPTURE_WIDTH },
      { op: 'capture', maxWidth: MAX_CAPTURE_WIDTH },
      { op: 'capture' },
    ]);
  });
});

describe('engine input guard', () => {
  it('asks for the foreground and refuses only after the focus buffer fails', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: { foreground: false } });

    const result = await sendInput(engine, { op: 'tap', x: 10, y: 20, count: 1 }, {
      attempts: 2,
      retryMs: 100,
      settleMs: 0,
      wait: async () => {},
    });

    expect(result).toEqual({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    // the focus was asked for before the refusal, and no input request was sent
    expect(engine.seen.map((request) => request.op))
      .toEqual(['foreground', 'foreground', 'focus', 'foreground', 'focus']);
    expect(engine.seen.some((request) => request.op === 'tap')).toBe(false);
  });

  it('takes the foreground, settles, then sends the input', async () => {
    const engine = new FakeEngine((request) => {
      if (request.op === 'foreground') return { id: 1, ok: true, value: { foreground: false } } as never;
      if (request.op === 'focus') return { id: 2, ok: true, value: { foreground: true } } as never;
      return { id: 3, ok: true, value: { inputMs: 61 } } as never;
    });
    const waits: number[] = [];

    const result = await sendInput(engine, { op: 'key', scan: 0x39, holdMs: 60 }, {
      settleMs: 200,
      wait: async (ms) => { waits.push(ms); },
    });

    expect(result).toEqual({ ok: true, inputMs: 61 });
    expect(waits).toEqual([200]);
    expect(engine.seen.map((request) => request.op)).toEqual(['foreground', 'foreground', 'focus', 'key']);
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

  it('asks for a band and refuses a reply that is not the band it asked for', async () => {
    const engine = new FakeEngine({
      id: 1,
      ok: true,
      value: { jpeg: Buffer.from([0xff, 0xd8]).toString('base64'), width: 1920, height: 1080, ageMs: 4 },
    });
    const source = new Win32Capture(engine, { decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) });
    await expect(source.captureBand({ x: 645, y: 36, width: 631, height: 699 })).rejects.toMatchObject({
      reason: 'unavailable',
      detail: 'malformed-capture',
    });
  });

  it('returns the band when the child echoes the rectangle', async () => {
    const engine = new FakeEngine({
      id: 1,
      ok: true,
      value: {
        jpeg: Buffer.from([0xff, 0xd8]).toString('base64'),
        width: 631,
        height: 699,
        ageMs: 4,
        crop: { x: 645, y: 36, width: 631, height: 699 },
      },
    });
    const source = new Win32Capture(engine, { decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) });
    const frame = await source.captureBand({ x: 645, y: 36, width: 631, height: 699 });
    expect(frame.width).toBe(631);
    expect(frame.height).toBe(699);
    expect(engine.seen[0]).toEqual({ op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } });
  });

  it('refuses a malformed band rectangle before the wire', async () => {
    const engine = new FakeEngine({ id: 1, ok: true, value: { jpeg: 'AA==', width: 2, height: 1, ageMs: 0 } });
    const source = new Win32Capture(engine);

    for (const rect of [
      { x: -1, y: 0, width: 1, height: 1 },
      { x: 0, y: -1, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: 1, height: 0 },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1 },
    ]) {
      await expect(source.captureBand(rect as never), JSON.stringify(rect)).rejects.toMatchObject({
        reason: 'rejected',
        detail: 'crop-out-of-range',
      });
    }
    // a bad rectangle never reaches the child, where the codec would drop the line and no reply
    // would come: the World would wait out engineTimeoutMs and never learn why
    expect(engine.seen).toEqual([]);
  });

  it('refuses a reply that echoes any part of the rectangle differently', async () => {
    const rect = { x: 645, y: 36, width: 631, height: 699 };
    const source = (value: object) => new Win32Capture(
      new FakeEngine({ id: 1, ok: true, value: { jpeg: 'AA==', ageMs: 4, width: 631, height: 699, crop: rect, ...value } }),
      { decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) },
    );

    for (const value of [
      { crop: { ...rect, x: 646 } },
      { crop: { ...rect, y: 37 } },
      { crop: { ...rect, width: 630 } },
      { crop: { ...rect, height: 698 } },
      { width: 1920 },
      { height: 1080 },
    ]) {
      await expect(source(value).captureBand(rect), JSON.stringify(value)).rejects.toMatchObject({
        reason: 'unavailable',
        detail: 'malformed-capture',
      });
    }
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

// ---------------------------------------------------------------------------------------------
// Teardown: a stuck key is worse than a refused press (contracts §4/§5)
// ---------------------------------------------------------------------------------------------

/**
 * The `ChildProcess` surface `connectEngine` touches, with the kill recorded. Every failure mode
 * here is the one that matters: on Windows `kill()` is `TerminateProcess`, so whatever the child
 * had not released when it lands stays down until something else releases it.
 */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  kills = 0;
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (): boolean => true,
    end: (): void => undefined,
  });
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => undefined });

  kill(): boolean {
    this.kills += 1;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('engine teardown', () => {
  it('keeps the maximum hold strictly inside the teardown grace', () => {
    // contracts §4: a press is held at most MAX_PRESS_HOLD_MS. contracts §5: the parent kills the
    // child TEARDOWN_GRACE_MS after closing the pipe, and that kill skips `releaseHeld()`. If the
    // two ever crossed, the World could send a hold the teardown would kill with the key down.
    expect(MAX_PRESS_HOLD_MS).toBeLessThan(TEARDOWN_GRACE_MS);
    // the same rule for a drag: the button is down for the drag's whole duration
    expect(MAX_DRAG_MS).toBeLessThan(TEARDOWN_GRACE_MS);
    // the World's constant and the child's codec constant are one fact
    expect(MAX_DRAG_MS).toBe(PROTOCOL_MAX_DRAG_MS);
  });

  it('does not kill the child while a maximum-length hold could still be finishing', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const engine = connectEngine(child as unknown as ChildProcess, { timeoutMs: 5_000 });

    // The World has asked for the longest hold it can and the session closes while it is in flight.
    void engine.request({ op: 'key', scan: 0x11, holdMs: MAX_PRESS_HOLD_MS });
    engine.close();

    // A maximum-length hold is still within its own duration: the child must still be alive to
    // release the key when the hold ends.
    vi.advanceTimersByTime(MAX_PRESS_HOLD_MS);
    expect(child.kills).toBe(0);

    // Only after the grace — which the hold fits inside — may a child that never exits be killed.
    vi.advanceTimersByTime(TEARDOWN_GRACE_MS - MAX_PRESS_HOLD_MS);
    expect(child.kills).toBe(1);
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
