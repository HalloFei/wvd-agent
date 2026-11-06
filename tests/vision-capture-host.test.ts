import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, EngineReply, EngineRequest } from '../src/contracts.ts';
import { connectEngine, type EngineClient } from '../src/engine/child.ts';
import { CaptureHost } from '../src/engine/vision/capture-host.ts';
import { memoryOverBuffer } from '../src/engine/vision/channel-memory.ts';
import {
  createChannel, heartbeatOf, layoutChannel, latest, publish, touchHeartbeat, type FrameChannel,
} from '../src/engine/vision/frame-channel.ts';

/**
 * The supervisor (plan Task 6): a child that dies, or a heartbeat that stops, is restarted once per
 * session and reported as `engineProblem`; the capture past the cap is `capture-unavailable` and the
 * World is never ended by the supervisor itself. The child is a tiny scripted node process — no game.
 */

/** A scripted child: `process.exit(0)` at once, or a beat later so a test can observe the restart. */
function scriptChild(source: string): ChildProcess {
  return spawn(process.execPath, ['-e', source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

const EXITS_NOW = 'process.exit(0)';
/** Stays alive long enough to be a restarted child, then leaves on its own so nothing leaks. */
const EXITS_LATER = 'setTimeout(() => process.exit(0), 1500)';

/** Collects the host's reports and lets a test await the n-th one. */
function reports(host: CaptureHost): { events: EngineEvent[]; waitFor(count: number): Promise<void> } {
  const events: EngineEvent[] = [];
  let wake: (() => void) | null = null;
  host.onEvent((event) => {
    events.push(event);
    wake?.();
    wake = null;
  });
  return {
    events,
    async waitFor(count: number) {
      const deadline = Date.now() + 8000;
      while (events.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(events)}`);
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('CaptureHost over scripted children', () => {
  it('restarts a dead child once and forwards requests to the new one', async () => {
    const launched: ChildProcess[] = [];
    const host = new CaptureHost({
      launch: () => {
        // the first child dies at once; the restarted one stays long enough to answer nothing
        const child = scriptChild(launched.length === 0 ? EXITS_NOW : EXITS_LATER);
        launched.push(child);
        return connectEngine(child, { timeoutMs: 300, logger: () => {} });
      },
      logger: () => {},
    });
    const heard = reports(host);
    try {
      // the first request gives the host its reason to start the child
      await host.request({ op: 'foreground' });
      await heard.waitFor(1);
      expect(heard.events[0]).toEqual({ kind: 'engineProblem', detail: 'capture-restarted' });
      expect(launched.length).toBe(2);
      // the restarted child is the one being asked: it never speaks the protocol, so the request
      // times out rather than being answered by the child that is already gone
      expect(await host.request({ op: 'foreground' })).toMatchObject({ ok: false, error: 'timeout' });
      expect(heard.events.filter((event) => event.kind === 'engineProblem')).toHaveLength(1);
    } finally {
      host.close();
    }
  }, 20000);

  it('reports capture-unavailable past the cap and starts no third child', async () => {
    let launches = 0;
    const host = new CaptureHost({
      launch: () => {
        launches += 1;
        return connectEngine(scriptChild(EXITS_NOW), { timeoutMs: 300, logger: () => {} });
      },
      logger: () => {},
    });
    const heard = reports(host);
    try {
      await host.request({ op: 'foreground' });
      await heard.waitFor(2);
      expect(heard.events).toEqual([
        { kind: 'engineProblem', detail: 'capture-restarted' },
        { kind: 'engineProblem', detail: 'capture-unavailable' },
      ]);
      expect(launches).toBe(2);
      // past the cap a request is a value, not a throw: the World keeps running on its own terms
      expect(await host.request({ op: 'capture' }))
        .toMatchObject({ ok: false, error: 'unavailable', detail: 'capture-unavailable' });
    } finally {
      host.close();
    }
  }, 20000);
});

describe('CaptureHost over the channel and fake clients', () => {
  /** An engine client whose child is an emitter, so a death is a test's own event. */
  class FakeClient implements EngineClient {
    readonly child = new EventEmitter() as unknown as ChildProcess;
    readonly requests: EngineRequest[] = [];
    closed = false;
    constructor(private readonly reply: EngineReply = { id: 1, ok: true, value: { foreground: true } }) {}
    async request(request: EngineRequest): Promise<EngineReply> {
      this.requests.push(request);
      return this.reply;
    }
    onEvent(): () => void {
      return () => {};
    }
    close(): void {
      this.closed = true;
    }
    die(): void {
      this.child.emit('exit', 1, null);
    }
  }

  function channelOf(width = 4, height = 2): FrameChannel {
    const layout = layoutChannel({ width, height, slots: 2 });
    return createChannel(memoryOverBuffer(Buffer.alloc(layout.bytes)), layout);
  }

  it('restarts a child whose heartbeat stops', async () => {
    const channel = channelOf();
    // the last sign of life is five seconds old: no child of ours is publishing any more
    touchHeartbeat(channel, Date.now() - 5_000);
    const clients: FakeClient[] = [];
    const host = new CaptureHost({
      launch: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      channel,
      heartbeatStaleMs: 20,
      healthIntervalMs: 5,
      maxRestarts: 1,
      logger: () => {},
    });
    const heard = reports(host);
    try {
      await host.request({ op: 'foreground' });
      await heard.waitFor(1);
      expect(heard.events[0]).toEqual({ kind: 'engineProblem', detail: 'capture-restarted' });
      expect(clients).toHaveLength(2);
    } finally {
      host.close();
    }
  }, 20000);

  it('does not restart a child whose heartbeat is moving', async () => {
    const channel = channelOf();
    const clients: FakeClient[] = [];
    const host = new CaptureHost({
      launch: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      channel,
      heartbeatStaleMs: 1_000,
      healthIntervalMs: 5,
      maxRestarts: 1,
      logger: () => {},
    });
    const heard = reports(host);
    try {
      await host.request({ op: 'foreground' });
      for (let tick = 0; tick < 6; tick += 1) {
        touchHeartbeat(channel, Date.now());
        await sleep(10);
      }
      expect(heard.events).toEqual([]);
      expect(clients).toHaveLength(1);
    } finally {
      host.close();
    }
  }, 20000);

  it('holds a capture through a restart until the new child publishes a newer frame', async () => {
    const channel = channelOf();
    publish(channel, new Uint8Array(32), { capturedAtMs: Date.now() });
    const clients: FakeClient[] = [];
    const order: string[] = [];
    const host = new CaptureHost({
      launch: () => {
        const client = new FakeClient({ id: 1, ok: true, value: { seq: 2, width: 4, height: 2, ageMs: 0 } });
        clients.push(client);
        return client;
      },
      channel,
      heartbeatStaleMs: 1_000,
      healthIntervalMs: 5,
      maxRestarts: 1,
      logger: () => {},
    });
    try {
      await host.request({ op: 'foreground' });
      clients[0]!.die(); // the child that published the frame the World already served is gone
      const pending = host.request({ op: 'capture' }).then((reply) => {
        order.push('answered');
        return reply;
      });
      await sleep(60);
      // the old slot is still inside the channel's stale window, but it is the dead child's frame:
      // handing it out again would let the World read a frozen screen as a live one
      expect(order).toEqual([]);
      publish(channel, new Uint8Array(32), { capturedAtMs: Date.now() });
      order.push('published');
      expect(await pending).toMatchObject({ ok: true, value: { seq: 2 } });
      expect(order).toEqual(['published', 'answered']);
      expect(clients).toHaveLength(2);
    } finally {
      host.close();
    }
  }, 20000);

  it('serves the newest slot to a plain capture once the child is healthy', async () => {
    const channel = channelOf();
    publish(channel, new Uint8Array(32), { capturedAtMs: Date.now() });
    const client = new FakeClient();
    const host = new CaptureHost({
      launch: () => client,
      channel,
      logger: () => {},
    });
    try {
      expect(await host.request({ op: 'capture' })).toMatchObject({ ok: true });
      expect(client.requests).toEqual([{ op: 'capture' }]);
      expect(latest(channel, { nowMs: Date.now() })).not.toBeNull();
      expect(heartbeatOf(channel)).toBeGreaterThan(0);
    } finally {
      host.close();
      expect(client.closed).toBe(true);
    }
  }, 20000);
});
