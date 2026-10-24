import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { connectEngine } from '../src/engine/child.ts';
import { captureWarm } from './fixtures/warmup-capture.ts';

const CHILD = fileURLToPath(new URL('../src/engine/child.mjs', import.meta.url));
const LOADER = new URL('./fixtures/fake-win32-loader.mjs', import.meta.url).href;

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
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connectEngine(child, { timeoutMs: 15000, logger: () => {} });
    try {
      // a fresh child's first frame may still be warming up: retry the contract's no-frame (§5)
      const native = await captureWarm(engine);
      expect(native).toMatchObject({ ok: true });
      const nativeValue = (native as { value: { jpeg: string; width: number; height: number; ageMs: number } }).value;
      expect(nativeValue.width).toBe(192);
      expect(nativeValue.height).toBe(108);
      expect(nativeValue.ageMs).toBeGreaterThanOrEqual(0);
      expect(nativeValue.ageMs).toBeLessThanOrEqual(300);
      expect(nativeValue).not.toHaveProperty('crop');

      const snapshot = await engine.request({ op: 'capture', maxWidth: 96 });
      expect(snapshot).toMatchObject({ ok: true });
      const snapshotValue = (snapshot as { value: { jpeg: string; width: number; height: number; ageMs: number } }).value;
      expect(snapshotValue.width).toBe(96);
      expect(snapshotValue.height).toBe(54);
      expect(snapshotValue.ageMs).toBeLessThanOrEqual(300);
      const decoded = jpeg.decode(Buffer.from(snapshotValue.jpeg, 'base64'), { useTArray: true, formatAsRGBA: true });
      expect(decoded.width).toBe(96);
      expect(decoded.height).toBe(54);

      // a request at or above the native width is never upscaled and needs no second encode
      const tooLarge = await engine.request({ op: 'capture', maxWidth: 1280 });
      expect(tooLarge).toMatchObject({ ok: true, value: { width: 192, height: 108 } });

      // and the perception path is still native afterwards
      const again = await engine.request({ op: 'capture' });
      expect(again).toMatchObject({ ok: true, value: { width: 192, height: 108 } });
    } finally {
      engine.close();
    }
  }, 30000);

  it.skipIf(process.platform !== 'win32')('serves a crop and nothing else', async () => {
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connectEngine(child, { timeoutMs: 15000, logger: () => {} });
    try {
      await captureWarm(engine); // warm the render threads; a cold child may reply no-frame (§5)
      const reply = await engine.request({ op: 'capture', crop: { x: 96, y: 54, width: 96, height: 54 } });
      expect(reply).toMatchObject({ ok: true });
      const value = (reply as { value: { jpeg: string; width: number; height: number; crop: unknown } }).value;
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
    const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const engine = connectEngine(child, { timeoutMs: 15000, logger: () => {} });
    try {
      await captureWarm(engine); // warm the render threads; a cold child may reply no-frame (§5)
      const reply = await engine.request({ op: 'capture', crop: { x: 100, y: 0, width: 100, height: 10 } });
      expect(reply).toMatchObject({ ok: false, error: 'rejected', detail: 'crop-out-of-frame' });
    } finally {
      engine.close();
    }
  });
});
