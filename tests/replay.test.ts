import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replay, replayTools } from '../scripts/replay.ts';

/**
 * The integration fixture: one real chest, recorded by the operator 2026-10-24 01:52 and described
 * by `measurements.json` beside it — 250 frames, 30 fps, 1920×1080, one QTE bar. The harness decodes
 * it through `ffmpeg` and drives the real recognisers (`chest.ts`, `map.ts`, `hud.ts`) through
 * `CompositePerceiver`; nothing is mocked, which is the point: the tally is a measurement, not a
 * claim about a stub.
 *
 * `ffmpeg` is a process, not a dependency, so the test is the only place that may need it. Where it
 * (or `ffprobe`) is missing the test prints why and skips: a skip is not a pass, and the task report
 * says so rather than counting it as one.
 *
 * `chest-qte ≥ 190` rather than merely `> 0`: research §11 measured 199 of 250 frames parsed
 * (frames 124–127 are the light burst that covers the marker; 203–249 have no bar at all). Zero
 * failures already pins the refusals as honest, but a count near zero would also pass a "non-zero"
 * assertion while the recognisers silently refused almost everything.
 */
const RECORDING = fileURLToPath(
  new URL('../testdata/chest/2026-10-24-qte-recorded/', import.meta.url),
);

const tools = replayTools();
if (!tools.ok) console.warn(`replay test skipped: ${tools.reason}`);
const playing = tools.ok ? it : it.skip;

describe('replay harness', () => {
  playing(
    'replays the recorded chest through the real recognisers',
    async () => {
      const started = performance.now();
      const report = await replay(RECORDING);
      const wallMs = Math.round(performance.now() - started);

      console.log(
        `replay: ${report.frames} frames, ${JSON.stringify(report.screens)}, ` +
          `${report.failures.length} failures, ${wallMs} ms`,
      );

      expect(report.frames).toBeGreaterThanOrEqual(200);
      expect(report.screens['chest-qte']).toBeGreaterThanOrEqual(190);
      expect(report.screens.unknown).toBeGreaterThan(0);
      // Refusals are allowed — the QTE screen genuinely goes away — but nothing inconsistent is.
      expect(report.failures).toEqual([]);
    },
    60_000,
  );

  /**
   * The failure path, without mocking perception: the same recording, replayed from a temp dir whose
   * `measurements.json` describes a bar nowhere near the one on screen. Every parsed frame must then
   * be named in `failures` — a harness that always returned an empty list would pass the happy test
   * above and fail this one. The temp dir is the test's own and is removed in `finally`; it holds a
   * copy of the encoded recording, never decoded frames.
   */
  playing(
    'names every chest-qte frame whose zones miss the recorded geometry',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-'));
      try {
        await copyFile(join(RECORDING, 'qte.mp4'), join(dir, 'qte.mp4'));
        await writeFile(
          join(dir, 'measurements.json'),
          JSON.stringify({
            bar: { leftZone: [100, 300], hazardGap: [300, 1100], rightZone: [1100, 1300] },
          }),
        );

        const report = await replay(dir);

        expect(report.frames).toBeGreaterThanOrEqual(200);
        expect(report.screens['chest-qte']).toBeGreaterThan(0);
        // One failure per parsed frame, and each names the frame and the contradiction.
        expect(report.failures).toHaveLength(report.screens['chest-qte']);
        for (const failure of report.failures) {
          expect(failure).toMatch(/^frame \d+: chest-qte .*(outside the recorded|centre)/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
