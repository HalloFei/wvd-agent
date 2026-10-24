import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { connectEngine } from '../src/engine/child.ts';

const CHILD = fileURLToPath(new URL('../src/engine/child.mjs', import.meta.url));
const LOADER = new URL('./fixtures/fake-win32-loader.mjs', import.meta.url).href;

/**
 * The child's real protocol loop, render threads and encoder — driven without a window by the
 * fake Win32 module the loader swaps in (and workers inherit). This is the end-to-end path the
 * World's escalation snapshot takes: `capture { maxWidth }` in, a downscaled JPEG and its true size
 * out; the perception request beside it stays native.
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
      const native = await engine.request({ op: 'capture' });
      expect(native).toMatchObject({ ok: true });
      const nativeValue = (native as { value: { jpeg: string; width: number; height: number; ageMs: number } }).value;
      expect(nativeValue.width).toBe(192);
      expect(nativeValue.height).toBe(108);
      expect(nativeValue.ageMs).toBeGreaterThanOrEqual(0);

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
});
