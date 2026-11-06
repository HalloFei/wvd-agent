import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, EngineReply, EngineRequest } from '../src/contracts.ts';
import { MAX_DRAG_MS, MAX_PRESS_HOLD_MS, TEARDOWN_GRACE_MS } from '../src/contracts.ts';
import {
  LineDecoder,
  MAX_DRAG_MS as PROTOCOL_MAX_DRAG_MS,
  decodeLine,
  encodeEvent,
  encodeReply,
  encodeRequest,
} from '../src/engine/protocol.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { parseHotkey } from '../src/engine/hotkey.mjs';
import { focusGame, sendInput, type EngineRequester } from '../src/engine/win32.ts';

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

  it('sends a capture request as its op alone: the pixels travel on the channel (contracts §5)', () => {
    expect(decodeLine(encodeRequest(8, { op: 'capture' })))
      .toEqual({ request: { id: 8, request: { op: 'capture' } } });
  });

  it('drops the JPEG-era capture fields instead of carrying them to a child that cannot read them', () => {
    // The crop and the downscale were the JPEG path's; they are World-side now, and a stale caller
    // must not be able to make the child do something the contract no longer promises.
    for (const legacy of [
      { maxWidth: 1280 },
      { crop: { x: 645, y: 36, width: 631, height: 699 } },
      { maxWidth: 1280, crop: { x: 0, y: 0, width: 10, height: 10 } },
    ]) {
      expect(decodeLine(JSON.stringify({ id: 1, request: { op: 'capture', ...legacy } })), JSON.stringify(legacy))
        .toEqual({ request: { id: 1, request: { op: 'capture' } } });
    }
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
