import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { EngineReply } from '../src/contracts.ts';
import { connectEngine, type EngineClient } from '../src/engine/child.ts';
import { captureWarm } from './fixtures/warmup-capture.ts';

const CHILD = fileURLToPath(new URL('../src/engine/child.mjs', import.meta.url));
const LOADER = new URL('./fixtures/fake-win32-loader.mjs', import.meta.url).href;

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

/**
 * The child's real protocol loop, render threads and encoder — driven without a window by the
 * fake Win32 module the loader swaps in (and workers inherit). This is the end-to-end path the
 * World's escalation snapshot takes: `capture { maxWidth }` in, a downscaled JPEG and its true size
 * out; the perception request beside it stays native. The QTE sample takes the same threads:
 * `capture { crop }` in, the band's JPEG, its size and the rectangle actually cropped out — or a
 * named refusal when the rectangle does not fit the frame.
 */
describe('engine child snapshot path (no window)', () => {
  it.skipIf(process.platform !== 'win32')('serves a downscaled snapshot and keeps plain captures native', async () => {
    const log: string[] = [];
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connect(child, log);
    try {
      // a fresh child's first frame may still be warming up: retry the contract's no-frame (§5)
      const native = expectOk(await captureWarm(engine), log);
      const nativeValue = native.value as { jpeg: string; width: number; height: number; ageMs: number };
      expect(nativeValue.width).toBe(192);
      expect(nativeValue.height).toBe(108);
      expect(nativeValue.ageMs).toBeGreaterThanOrEqual(0);
      expect(nativeValue.ageMs).toBeLessThanOrEqual(300);
      expect(nativeValue).not.toHaveProperty('crop');

      const snapshot = expectOk(await engine.request({ op: 'capture', maxWidth: 96 }), log);
      const snapshotValue = snapshot.value as { jpeg: string; width: number; height: number; ageMs: number };
      expect(snapshotValue.width).toBe(96);
      expect(snapshotValue.height).toBe(54);
      expect(snapshotValue.ageMs).toBeLessThanOrEqual(300);
      const decoded = jpeg.decode(Buffer.from(snapshotValue.jpeg, 'base64'), { useTArray: true, formatAsRGBA: true });
      expect(decoded.width).toBe(96);
      expect(decoded.height).toBe(54);

      // a request at or above the native width is never upscaled and needs no second encode
      const tooLarge = expectOk(await engine.request({ op: 'capture', maxWidth: 1280 }), log);
      expect(tooLarge.value).toMatchObject({ width: 192, height: 108 });

      // and the perception path is still native afterwards
      const again = expectOk(await engine.request({ op: 'capture' }), log);
      expect(again.value).toMatchObject({ width: 192, height: 108 });
    } finally {
      engine.close();
    }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('serves a crop and nothing else', async () => {
    const log: string[] = [];
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connect(child, log);
    try {
      // warm the render threads; a cold child may reply no-frame (§5)
      expectOk(await captureWarm(engine), log);
      const reply = expectOk(
        await engine.request({ op: 'capture', crop: { x: 96, y: 54, width: 96, height: 54 } }),
        log,
      );
      const value = reply.value as { jpeg: string; width: number; height: number; crop: unknown };
      expect(value.width).toBe(96);
      expect(value.height).toBe(54);
      expect(value.crop).toEqual({ x: 96, y: 54, width: 96, height: 54 });
      // the bottom-right quadrant is yellow; JPEG is lossy, so allow ±3 per channel
      const decoded = jpeg.decode(Buffer.from(value.jpeg, 'base64'), { useTArray: true, formatAsRGBA: true });
      const at = ((27 * 96) + 48) * 4;
      expect(Math.abs(decoded.data[at] - 255)).toBeLessThanOrEqual(3);     // R
      expect(Math.abs(decoded.data[at + 1] - 255)).toBeLessThanOrEqual(3); // G
      expect(Math.abs(decoded.data[at + 2] - 0)).toBeLessThanOrEqual(3);   // B
    } finally {
      engine.close();
    }
  });

  it.skipIf(process.platform !== 'win32')('refuses a crop that does not fit the frame', async () => {
    const log: string[] = [];
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connect(child, log);
    try {
      // warm the render threads; a cold child may reply no-frame (§5)
      expectOk(await captureWarm(engine), log);
      const reply = await engine.request({ op: 'capture', crop: { x: 100, y: 0, width: 100, height: 10 } });
      expect(reply).toMatchObject({ ok: false, error: 'rejected', detail: 'crop-out-of-frame' });
    } finally {
      engine.close();
    }
  });
});
