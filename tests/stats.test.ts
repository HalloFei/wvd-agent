import { describe, expect, it } from 'vitest';
import { RunStats, averageOf, formatSpan } from '../src/stats.ts';

describe('the run stats', () => {
  it('counts a chest once, from its first chest screen to the screen the chest is over on', () => {
    const stats = new RunStats();
    stats.observe('chest-prompt', 'chest', 1_000);
    stats.observe('chest-opening', 'chest', 2_000);
    stats.observe('drop-item-claim', 'chest', 3_000);
    stats.observe('dungeon', 'dungeon', 4_000);
    const summary = stats.summary();
    expect(summary.chests).toEqual({ count: 1, totalMs: 3_000 });
    expect(summary.chestAvgMs).toBe(3_000);
    expect(summary.battles).toEqual({ count: 0, totalMs: 0 });
    expect(summary.battleAvgMs).toBeNull();
  });

  it('does not let a screen between the chest frames split the interval', () => {
    // Live 2026-11-07 01:05: the chest mode left and re-entered between the loot card's frames and one
    // chest was counted six times. The chest's screens only end when the loop is back on the map/view.
    const stats = new RunStats();
    stats.observe('chest-prompt', 'chest', 0);
    stats.observe('unknown', 'chest', 1_000);
    stats.observe('drop-item-claim', 'chest', 2_000);
    stats.observe('message', 'chest', 2_500);
    stats.observe('dungeon', 'dungeon', 6_000);
    expect(stats.summary().chests).toEqual({ count: 1, totalMs: 6_000 });
  });

  it('holds a battle through the frames that name nothing, because the mode does', () => {
    const stats = new RunStats();
    stats.observe('combat', 'battle', 1_000);
    stats.observe('unknown', 'battle', 1_500);
    stats.observe('combat', 'battle', 9_000);
    stats.observe('dungeon', 'dungeon', 12_000);
    expect(stats.summary().battles).toEqual({ count: 1, totalMs: 11_000 });
  });

  it('counts separate intervals separately and averages them', () => {
    const stats = new RunStats();
    stats.observe('chest-prompt', 'chest', 0);
    stats.observe('dungeon', 'dungeon', 2_000);
    stats.observe('chest-prompt', 'chest', 10_000);
    stats.observe('dungeon', 'dungeon', 16_000);
    const summary = stats.summary();
    expect(summary.chests).toEqual({ count: 2, totalMs: 8_000 });
    expect(summary.chestAvgMs).toBe(4_000);
    expect(formatSpan(summary.chests)).toBe('2 (avg 4.0 s)');
  });

  it('closes the cycle at its boundary and keeps the totals across cycles', () => {
    const stats = new RunStats();
    stats.observe('chest-prompt', 'chest', 0);
    stats.observe('dungeon', 'dungeon', 3_000);
    const first = stats.endCycle(3_000);
    expect(first.cycle).toBe(1);
    expect(first.chests).toEqual({ count: 1, totalMs: 3_000 });
    stats.observe('combat', 'battle', 20_000);
    stats.observe('dungeon', 'dungeon', 25_000);
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

  it('counts the battle a stalled run died inside, instead of losing it', () => {
    // Live 2026-11-07 01:06: the loop stalled in a battle and the summary said `battles 0`.
    const stats = new RunStats();
    stats.observe('combat', 'battle', 1_000);
    stats.observe('unknown', 'battle', 9_000);
    stats.finish(10_000);
    expect(stats.summary().battles).toEqual({ count: 1, totalMs: 9_000 });
  });

  it('averages nothing as null, and formats an empty span as zero', () => {
    expect(averageOf({ count: 0, totalMs: 0 })).toBeNull();
    expect(formatSpan({ count: 0, totalMs: 0 })).toBe('0');
  });
});
