import { describe, expect, it } from 'vitest';
import type { EngineRequest, EngineReply } from '../src/contracts.ts';
import type { EngineRequester } from '../src/engine/win32.ts';
import { captureWarm } from './fixtures/warmup-capture.ts';

/** The contract-legal reply a cold child sends when the encoder has not produced a frame yet. */
const noFrame = (id: number): EngineReply => ({ id, ok: false, error: 'timeout', detail: 'no-frame' });
const frame = (id: number): EngineReply => ({
  id,
  ok: true,
  value: { seq: 3, width: 192, height: 108, ageMs: 1 },
});

/**
 * Replays `replies` in order and records every request, so a test can assert both what the helper
 * asked and how many times it asked. Running out of replies is a test bug, not a retry.
 */
function fakeEngine(replies: EngineReply[]): EngineRequester & { requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (reply === undefined) throw new Error(`fake engine got request ${requests.length} with no reply queued`);
      return reply;
    },
  };
}

/** Records an injected sleep instead of waiting, so no test depends on wall time. */
function recordingSleep(log?: string[]): (ms: number) => Promise<void> {
  return async (ms) => {
    log?.push(`sleep:${ms}`);
  };
}

describe('captureWarm (first capture on a fresh engine child)', () => {
  it('retries a no-frame reply until a frame exists, three attempts at most', async () => {
    const replies = [noFrame(1), noFrame(2), frame(3)];
    const engine = fakeEngine(replies);

    const reply = await captureWarm(engine, recordingSleep());

    expect(reply).toBe(replies[2]);
    expect(reply).toMatchObject({ ok: true });
    expect(engine.requests).toEqual([{ op: 'capture' }, { op: 'capture' }, { op: 'capture' }]);
  });

  it('returns the last no-frame after three attempts, so a hung renderer still fails', async () => {
    const replies = [noFrame(1), noFrame(2), noFrame(3)];
    const engine = fakeEngine(replies);

    const reply = await captureWarm(engine, recordingSleep());

    expect(reply).toBe(replies[2]);
    expect(reply).toMatchObject({ ok: false, error: 'timeout', detail: 'no-frame' });
    expect(engine.requests).toHaveLength(3);
  });

  it.each([
    ['rejected', { id: 1, ok: false, error: 'rejected', detail: 'crop-out-of-frame' } as EngineReply],
    ['unavailable', { id: 1, ok: false, error: 'unavailable', detail: 'window-not-found' } as EngineReply],
    ['stale-frame', { id: 1, ok: false, error: 'timeout', detail: 'stale-frame' } as EngineReply],
  ])('returns a %s reply immediately without retrying', async (_name, reply) => {
    const engine = fakeEngine([reply]);

    const result = await captureWarm(engine, recordingSleep());

    expect(result).toBe(reply);
    expect(engine.requests).toHaveLength(1);
  });

  it('stops retrying as soon as a later attempt is not a warm-up miss', async () => {
    const refused: EngineReply = { id: 2, ok: false, error: 'rejected', detail: 'crop-out-of-frame' };
    const engine = fakeEngine([noFrame(1), refused]);

    const reply = await captureWarm(engine, recordingSleep());

    expect(reply).toBe(refused);
    expect(engine.requests).toHaveLength(2);
  });

  it('spaces attempts 200 ms apart through the injected sleep', async () => {
    const log: string[] = [];
    const replies = [noFrame(1), noFrame(2), noFrame(3)];
    const engine = fakeEngine(replies);
    const request = engine.request.bind(engine);
    engine.request = async (ask) => {
      log.push('request');
      return request(ask);
    };

    await captureWarm(engine, recordingSleep(log));

    expect(log).toEqual(['request', 'sleep:200', 'request', 'sleep:200', 'request']);
  });
});
