/**
 * Record the game window through the engine child — the one capture path that works while the game
 * is behind another window.
 *
 * gdigrab `-i title=` returns the **DWM-composited desktop** for an obscured window (measured
 * 2026-10-31: a 120 s "recording" of the game window is entirely the editor on top of it), so the
 * stop this module exists to measure was lost in the first attempt. The engine's worker capture
 * reads the window's own surface, which is why every `status`/`shot` in this session worked while
 * the game was in the background.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/live-record.ts [seconds]
 *
 * One native 1920x1080 JPEG per iteration into `.tmp/record/<stamp>/`, numbered in capture order;
 * the child's own encode (~60-100 ms) sets the rate, which is 10-15 fps rather than a bar's 30. That
 * is still three to five samples per braking glide, and the fit only needs the marker's positions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg } from '../src/engine/win32.ts';

const seconds = Number(process.argv[2] ?? 60);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = '.tmp/record/' + stamp;
mkdirSync(dir, { recursive: true });

const child = startEngine({ title: 'WizardryVariantsDaphne', jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
const startedAt = performance.now();
let frames = 0;
try {
  while (performance.now() - startedAt < seconds * 1000) {
    let shot: { bytes: Uint8Array; width: number; height: number };
    try {
      shot = await captureJpeg(client);
    } catch (error) {
      console.error('wvd record: capture stopped:', error instanceof Error ? error.message : String(error));
      break;
    }
    writeFileSync(dir + '/' + String(frames).padStart(5, '0') + '.jpg', shot.bytes);
    frames += 1;
  }
} finally {
  client.close();
}
const elapsed = (performance.now() - startedAt) / 1000;
console.log(JSON.stringify({ dir, frames, seconds: Number(elapsed.toFixed(1)), fps: Number((frames / elapsed).toFixed(1)) }));
