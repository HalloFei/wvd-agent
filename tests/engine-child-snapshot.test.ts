import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EngineCapture, EngineReply } from '../src/contracts.ts';
import { connectEngine, type EngineClient } from '../src/engine/child.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import {
  createChannel, heartbeatOf, layoutChannel, latest, type FrameChannel,
} from '../src/engine/vision/frame-channel.ts';
import { captureWarm } from './fixtures/warmup-capture.ts';

const CHILD = fileURLToPath(new URL('../src/engine/child.mjs', import.meta.url));
const LOADER = new URL('./fixtures/fake-win32-loader.mjs', import.meta.url).href;

/** The fake window's client size (tests/fixtures/fake-win32-native.mjs). */
const WINDOW_WIDTH = 192;
const WINDOW_HEIGHT = 108;

/**
 * The channel the test's "host" creates and the child opens, exactly as main.ts does: the region
 * carries the layout header before the child is spawned, and the child publishes into it.
 */
interface TestChannel {
  readonly name: string;
  readonly bytes: number;
  readonly channel: FrameChannel;
  dispose(): void;
}

function openTestChannel(): TestChannel {
  const layout = layoutChannel({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT, slots: 2 });
  const name = `wvd-child-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mapping = openMapping(name, layout.bytes);
  return {
    name,
    bytes: layout.bytes,
    channel: createChannel(mapping.memory, layout),
    dispose: () => mapping.dispose(),
  };
}

function spawnChild(testChannel: TestChannel): ChildProcess {
  return spawn(
    process.execPath,
    [
      '--import', LOADER, CHILD,
      '--title=__wvd_fake_window__',
      '--hotkey=',
      `--channel=${testChannel.name}`,
      `--channel-bytes=${testChannel.bytes}`,
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
}

/**
 * The client, with the child's own log forwarded into `log`. The old `logger: () => {}` silenced the
 * child's startup lines — exactly the evidence a failed capture needs.
 */
function connect(child: ChildProcess, log: string[]): EngineClient {
  return connectEngine(child, { timeoutMs: 15000, logger: (line) => log.push(line) });
}

/**
 * The reply, when it is `ok`, with the whole reply and the child's own log in the failure message.
 * `toMatchObject({ ok: true })` reports only that the object did not match and hides `error` /
 * `detail`, which is why the original load flake took an hour to explain: the reply had the answer.
 */
function expectOk(reply: EngineReply, log: readonly string[]): Extract<EngineReply, { ok: true }> {
  if (reply.ok) return reply;
  const lines =
    log.length === 0 ? '    (the child said nothing)' : log.map((line) => `    ${line}`).join('\n');
  throw new Error(
    `engine child refused the request:\n  reply: ${JSON.stringify(reply)}\n  child log:\n${lines}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The child's capture path without a window: the protocol loop, the capture thread and the real
 * channel writer are the production ones, driven by the fake Win32 module the loader swaps in. What
 * changed with the vision module is the transport — the child publishes raw BGRA into the mapping and
 * the protocol reply carries only the frame's metadata (contracts §5). The test is the one place the
 * child's writer and the World's reader meet, so a layout drift between `channel.mjs` and
 * `frame-channel.ts` is caught here rather than on a live run.
 */
describe('engine child capture over the frame channel (no window)', () => {
  it.skipIf(process.platform !== 'win32')('publishes the captured frame and replies only its metadata', async () => {
    const log: string[] = [];
    const testChannel = openTestChannel();
    const engine = connect(spawnChild(testChannel), log);
    try {
      // a fresh child's first frame may still be warming up: retry the contract's no-frame (§5)
      const reply = expectOk(await captureWarm(engine), log);
      const value = reply.value as EngineCapture;
      expect(value.width).toBe(WINDOW_WIDTH);
      expect(value.height).toBe(WINDOW_HEIGHT);
      expect(value.ageMs).toBeGreaterThanOrEqual(0);
      expect(value.ageMs).toBeLessThanOrEqual(300);
      expect(typeof value.seq).toBe('number');
      // the JPEG and the crop are gone from the reply: the channel is the frame's transport
      expect(value).not.toHaveProperty('jpeg');
      expect(value).not.toHaveProperty('crop');

      const served = latest(testChannel.channel, { nowMs: Date.now() });
      expect(served).not.toBeNull();
      expect(served!.width).toBe(WINDOW_WIDTH);
      expect(served!.height).toBe(WINDOW_HEIGHT);
      // the child keeps publishing, so the slot the reader takes may be newer than the reply's
      expect(served!.seq).toBeGreaterThanOrEqual(value.seq);
      // the fake window's quadrants: top-left blue, bottom-right yellow, in BGRA order
      expect([...served!.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
      const last = ((WINDOW_HEIGHT - 1) * WINDOW_WIDTH + (WINDOW_WIDTH - 1)) * 4;
      expect([...served!.pixels.subarray(last, last + 4)]).toEqual([0, 255, 255, 255]);

      // no encoder exists in the child any more: no quality option, and the channel names itself
      expect(log.some((line) => line.includes('channel='))).toBe(true);
      expect(log.some((line) => line.includes('quality='))).toBe(false);
    } finally {
      engine.close();
      testChannel.dispose();
    }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('keeps its heartbeat running while nothing is captured', async () => {
    const log: string[] = [];
    const testChannel = openTestChannel();
    const engine = connect(spawnChild(testChannel), log);
    try {
      expectOk(await captureWarm(engine), log);
      const first = heartbeatOf(testChannel.channel);
      expect(first).toBeGreaterThan(0);
      // the render thread stops 300 ms after the last demand; the heartbeat must not stop with it,
      // or the supervisor would restart a healthy child
      await sleep(400);
      const later = heartbeatOf(testChannel.channel);
      expect(later).toBeGreaterThan(first);
      expect(Math.abs(Date.now() - later)).toBeLessThan(1000);
    } finally {
      engine.close();
      testChannel.dispose();
    }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('refuses a frame older than the stale window', async () => {
    const log: string[] = [];
    const testChannel = openTestChannel();
    const engine = connect(spawnChild(testChannel), log);
    try {
      expectOk(await captureWarm(engine), log);
      // rendering is gated on demand: 300 ms after the last request it stops, so an idle capture
      // must find a frame older than the three-tick window rather than a stale one that looks new
      await sleep(750);
      const reply = await engine.request({ op: 'capture' });
      expect(reply).toMatchObject({ ok: false, error: 'timeout', detail: 'stale-frame' });
    } finally {
      engine.close();
      testChannel.dispose();
    }
  }, 30000);
});
