import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { QteState } from '../src/contracts.ts';
import {
  geometryProblem,
  readRecordedBar,
  replay,
  replayTools,
  type RecordedBar,
} from '../scripts/replay.ts';

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
 * The tally is pinned **exactly** (`250 / 199 / 51`), because the fixture is fixed and h264 decode
 * is deterministic. A loose `≥ 200` would stay green if the parser regressed from 199 parsed frames
 * to 191, or if refusals migrated from `unknown` into `dungeon` — exactly the numbers this harness
 * exists to report. `sum(screens) ≤ frames` is the structural half of the same assertion: every
 * frame may claim at most one screen, and a frame with no observation cannot inflate the total.
 *
 * `bandCheck` adds the scale half of the crop proof: each of the 199 `chest-qte` frames is also cut
 * to `qteWindow` and re-parsed, and its `QteState` must equal the one the composite read from the
 * full frame. `bandFrames` is pinned to exactly those 199 and `bandMismatches` to 0; a second replay
 * without the option pins both to 0, so the cross-check cannot be left on by accident or silently
 * off.
 *
 * `planCheck` is design acceptance 5: every `chest-qte` observation feeds the last three readings,
 * `qteVelocity` and `planTap` at the recording's own timestamps, and every returned plan is judged
 * against `measurements.json` — target inside a recorded zone, delay finite and inside the horizon,
 * no reversal crossed. `planViolations` is pinned to empty and `planned` to at least 25: many triples
 * refuse legitimately (one that straddles a bounce, or the easing near one, carries no velocity), so
 * the floor is deliberately conservative rather than a chased count.
 */
const RECORDING = fileURLToPath(
  new URL('../testdata/chest/2026-10-24-qte-recorded/', import.meta.url),
);

const tools = replayTools();
if (!tools.ok) console.warn(`replay test skipped: ${tools.reason}`);
const playing = tools.ok ? it : it.skip;

/** `measurements.json`'s bar for the integration fixture, as the harness reads it. */
const RECORDED_BAR: RecordedBar = {
  left: [694, 922],
  right: [997, 1223],
  gap: [922, 997],
  // The recording's `marker.bounceAt`: the left zone's first column and one past the right zone's
  // last, which is where the marker turns around.
  bounce: [694, 1224],
};

function qteWith(zones: Array<{ from: number; to: number }>): QteState {
  return { zones, markerX: 800, button: { x: 960, y: 662 }, attempts: null };
}

describe('replay harness', () => {
  playing(
    'replays the recorded chest through the real recognisers',
    async () => {
      const started = performance.now();
      const report = await replay(RECORDING, { bandCheck: true, planCheck: true });
      const wallMs = Math.round(performance.now() - started);

      console.log(
        `replay: ${report.frames} frames, ${JSON.stringify(report.screens)}, ` +
          `${report.failures.length} failures, band ${report.bandFrames} frames / ` +
          `${report.bandMismatches} mismatches, plan ${report.planned} plans / ` +
          `${report.planViolations.length} violations, ${wallMs} ms`,
      );

      expect(report.frames).toBe(250);
      expect(report.screens['chest-qte']).toBe(199);
      // Frames 124–127 are the light burst over the marker; 203–249 have no bar at all.
      expect(report.screens.unknown).toBe(51);
      const claimed = Object.values(report.screens).reduce((sum, count) => sum + count, 0);
      expect(claimed).toBeLessThanOrEqual(report.frames);
      // Refusals are allowed — the QTE screen genuinely goes away — but nothing inconsistent is.
      expect(report.failures).toEqual([]);
      // Every parsed frame was also cropped to `qteWindow` and re-parsed; the crop must be the same
      // observation the composite made of the full frame (design acceptance 2).
      expect(report.bandFrames).toBe(199);
      expect(report.bandMismatches).toBe(0);
      // Design acceptance 5: the planning model, fed the recording's own readings at their own
      // timestamps, planned presses that land inside the recorded zones and cross no reversal.
      expect(report.planViolations).toEqual([]);
      expect(report.planned).toBeGreaterThanOrEqual(25);
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

        expect(report.frames).toBe(250);
        expect(report.screens['chest-qte']).toBe(199);
        // The band cross-check is off by default: a caller that did not ask for it pays nothing and
        // its report says so, rather than silently looking checked.
        expect(report.bandFrames).toBe(0);
        expect(report.bandMismatches).toBe(0);
        // `planCheck` is off by default too, and its fields say so rather than looking checked.
        expect(report.planned).toBe(0);
        expect(report.planViolations).toEqual([]);
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

/**
 * The geometry cross-check on its own. It is pure, so it keeps its coverage on a machine without
 * `ffmpeg`: the integration tests above are the only ones that skip.
 */
describe('geometryProblem', () => {
  it('accepts the zones the recording actually produced', () => {
    const qte = qteWith([
      { from: 696, to: 919 },
      { from: 1000, to: 1223 },
    ]);

    expect(geometryProblem(qte, RECORDED_BAR)).toBeNull();
  });

  it('names a zone that lies outside the recorded rectangle', () => {
    const qte = qteWith([
      { from: 380, to: 527 }, // the lit wall's 148 px run (research-qte-parser §4)
      { from: 1000, to: 1223 },
    ]);

    expect(geometryProblem(qte, RECORDED_BAR)).toMatch(
      /^left zone \[380, 527\] lies outside the recorded \[694, 922\]/,
    );
  });

  it('names a zone pair that is not two zones', () => {
    expect(geometryProblem(qteWith([{ from: 696, to: 919 }]), RECORDED_BAR)).toBe(
      'has 1 zones, expected 2',
    );
  });

  it('names a hazard gap that does not match the recording', () => {
    // Both fills sit inside their recorded rectangles, but stop 102 px apart against the recorded
    // 74: the "truncated zone makes a fake gap" failure research-qte-parser §4 measured.
    const qte = qteWith([
      { from: 694, to: 908 },
      { from: 1011, to: 1223 },
    ]);

    expect(geometryProblem(qte, RECORDED_BAR)).toBe(
      'hazard gap is 102 px, the recorded one 74 px ± 14',
    );
  });

  it('refuses a payload with no readable zones instead of throwing', () => {
    expect(geometryProblem(undefined, RECORDED_BAR)).toBe('observation carries no readable zones');
    expect(geometryProblem({}, RECORDED_BAR)).toBe('observation carries no readable zones');
    expect(geometryProblem({ zones: [{ from: '696', to: 919 }] }, RECORDED_BAR)).toBe(
      'observation carries no readable zones',
    );
    expect(geometryProblem({ zones: [null, { from: 1000, to: 1223 }] }, RECORDED_BAR)).toBe(
      'observation carries no readable zones',
    );
  });
});

/**
 * Reading the recording's own measurements. A missing or malformed file disables only the cross-
 * check, so it must say so: silent absence would let "the check was off" look like "the check
 * passed", which is the failure mode this instrument exists to rule out.
 */
describe('readRecordedBar', () => {
  it('reads the recorded bar without warning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeFile(
        join(dir, 'measurements.json'),
        JSON.stringify({
          bar: { leftZone: [694, 922], hazardGap: [922, 997], rightZone: [997, 1223] },
        }),
      );

      await expect(readRecordedBar(dir)).resolves.toEqual(RECORDED_BAR);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns that the cross-check is off when measurements.json is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(readRecordedBar(dir)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no measurements.json'));
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names every check it disables when the plan check asked for the bar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(readRecordedBar(dir, { planCheck: true })).resolves.toBeNull();

      // `planCheck` on with no bar yields `planned: 0` and `planViolations: []`; the warning is
      // the only thing that can stop that from reading as a clean check. It must name the plan
      // check as well as the geometry cross-check.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no measurements.json'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('plan check'));
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the marker's bounce when the recording states it", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    try {
      await writeFile(
        join(dir, 'measurements.json'),
        JSON.stringify({
          bar: { leftZone: [694, 922], hazardGap: [922, 997], rightZone: [997, 1223] },
          marker: { bounceAt: [650, 1270] },
        }),
      );

      // The recording's own reversal points win over the bar's edges; the plan check refuses a
      // target past them.
      const bar = await readRecordedBar(dir);
      expect(bar?.bounce).toEqual([650, 1270]);
      expect(bar?.left).toEqual([694, 922]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns that the cross-check is off when measurements.json cannot be read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeFile(join(dir, 'measurements.json'), '{ this is not json');

      await expect(readRecordedBar(dir)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no readable bar'));
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the plan check too when the bar itself is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-replay-bar-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await writeFile(join(dir, 'measurements.json'), JSON.stringify({ bar: {} }));

      await expect(readRecordedBar(dir, { planCheck: true })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no readable bar'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('plan check'));
    } finally {
      warn.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
