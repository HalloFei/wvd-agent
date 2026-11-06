import { describe, expect, it } from 'vitest';
import { RunStats, averageOf, formatSpan } from '../src/stats.ts';

describe('the run stats', () => {
  it('counts a chest once, from its first chest-mode tick to the first tick out of it', () => {
    const stats = new RunStats();
    stats.observe('chest', 1_000);
    stats.observe('chest', 2_000);
    stats.observe('chest', 3_000);
    stats.observe('dungeon', 4_000);
    const summary = stats.summary();
    expect(summary.chests).toEqual({ count: 1, totalMs: 3_000 });
    expect(summary.chestAvgMs).toBe(3_000);
    expect(summary.battles).toEqual({ count: 0, totalMs: 0 });
    expect(summary.battleAvgMs).toBeNull();
  });

  it('holds an interval through the frames that name nothing, because the mode does', () => {
    // The caller passes the game's mode, not the screen: a battle's resolution is `unknown` on the
    // frame and still the battle — so one battle, not a fragment per unnamed frame.
    const stats = new RunStats();
    stats.observe('battle', 1_000);
    stats.observe('battle', 1_500);
    stats.observe('battle', 9_000);
    stats.observe('dungeon', 12_000);
    expect(stats.summary().battles).toEqual({ count: 1, totalMs: 11_000 });
  });

  it('counts separate intervals separately and averages them', () => {
    const stats = new RunStats();
    stats.observe('chest', 0);
    stats.observe('dungeon', 2_000);
    stats.observe('chest', 10_000);
    stats.observe('dungeon', 16_000);
    const summary = stats.summary();
    expect(summary.chests).toEqual({ count: 2, totalMs: 8_000 });
    expect(summary.chestAvgMs).toBe(4_000);
    expect(formatSpan(summary.chests)).toBe('2 (avg 4.0 s)');
  });

  it('closes the cycle at its boundary and keeps the totals across cycles', () => {
    const stats = new RunStats();
    stats.observe('chest', 0);
    stats.observe('dungeon', 3_000);
    const first = stats.endCycle(3_000);
    expect(first.cycle).toBe(1);
    expect(first.chests).toEqual({ count: 1, totalMs: 3_000 });
    // The next cycle's counters start clean; the totals do not.
    stats.observe('battle', 20_000);
    stats.observe('dungeon', 25_000);
    const second = stats.endCycle(25_000);
    expect(second.cycle).toBe(2);
    expect(second.chests).toEqual({ count: 0, totalMs: 0 });
    expect(second.battles).toEqual({ count: 1, totalMs: 5_000 });
    const summary = stats.summary();
    expect(summary.cycles).toHaveLength(2);
    expect(summary.chests).toEqual({ count: 1, totalMs: 3_000 });
    expect(summary.battles).toEqual({ count: 1, totalMs: 5_000 });
    expect(summary.chestAvgMs).toBe(3_000);
    expect(summary.battleAvgMs).toBe(5_000);
  });

  it('averages nothing as null, and formats an empty span as zero', () => {
    expect(averageOf({ count: 0, totalMs: 0 })).toBeNull();
    expect(formatSpan({ count: 0, totalMs: 0 })).toBe('0');
  });
});
