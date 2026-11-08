/**
 * The arbiter of the loop's intent-driven stages (operator rule 2026-11-09, plan Task 1).
 *
 * One owner at a time, driven every tick it owns, bounded by its own clock. The registry is the whole
 * of that rule: it knows a name, a start, the last pump and a pump count — never a screen, a command
 * or the World. Every method takes `now`, so the clock stays the loop's and a test states it.
 *
 * The live defect this replaces: the leave and the orientation both "owned" the exit path in the same
 * tick (live run 7, 06:00:02: "leaving: walking to this floor exit with F" and "off the task floor;
 * the orientation is re-armed" on the same frame), and the leave's ownership was a flag nothing
 * pumped while the route waited.
 */
import { describe, expect, it } from 'vitest';
import { StageRegistry, type StageClaim } from '../src/policy/stage-registry.ts';

/** The owner as a plain object, so a test can compare the whole claim in one assertion. */
const claim = (name: StageClaim['name'], sinceMs: number, pumpedAtMs = sinceMs, pumps = 0): StageClaim =>
  ({ name, sinceMs, pumpedAtMs, pumps });

describe('StageRegistry', () => {
  it('is empty and total before anything claims it', () => {
    const registry = new StageRegistry();
    expect(registry.owner).toBeNull();
    // A release and a pump of nobody, and an overdue check with no owner, are answers, not throws.
    expect(registry.release('exit')).toBe(false);
    expect(registry.pump('orient', 10)).toBe(false);
    expect(registry.overdue(10_000, 1_000)).toBe(false);
  });

  it('refuses a second name with the holder, and leaves the first claim untouched', () => {
    const registry = new StageRegistry();
    expect(registry.claim('exit', 1_000)).toEqual({ ok: true });
    expect(registry.owner).toEqual(claim('exit', 1_000));

    expect(registry.claim('orient', 2_000)).toEqual({ ok: false, heldBy: 'exit' });
    expect(registry.claim('stage', 3_000)).toEqual({ ok: false, heldBy: 'exit' });
    // The refusal changed nothing: not the name, not the start, not the pump stamp, not the count.
    expect(registry.owner).toEqual(claim('exit', 1_000));
  });

  it('is idempotent for the owner and re-stamps the pump', () => {
    const registry = new StageRegistry();
    registry.claim('stage', 1_000);
    registry.pump('stage', 1_100);

    expect(registry.claim('stage', 5_000)).toEqual({ ok: true });
    // `sinceMs` is when the owner took the loop, so a re-claim keeps it; the pump stamp moves.
    expect(registry.owner).toEqual(claim('stage', 1_000, 5_000, 1));
  });

  it('releases only for the owner: a release is not a takeover', () => {
    const registry = new StageRegistry();
    registry.claim('exit', 1_000);

    expect(registry.release('orient')).toBe(false);
    expect(registry.owner).toEqual(claim('exit', 1_000));
    // A second name cannot release and re-claim in one step, either.
    expect(registry.claim('orient', 2_000)).toEqual({ ok: false, heldBy: 'exit' });

    expect(registry.release('exit')).toBe(true);
    expect(registry.owner).toBeNull();
    // Releasing twice is a no-op answer, not a throw.
    expect(registry.release('exit')).toBe(false);
  });

  it('pumps only for the owner, and the owner\'s pump stamp and count move together', () => {
    const registry = new StageRegistry();
    registry.claim('orient', 1_000);

    expect(registry.pump('exit', 2_000)).toBe(false);
    expect(registry.pump('stage', 3_000)).toBe(false);
    expect(registry.owner).toEqual(claim('orient', 1_000));

    expect(registry.pump('orient', 4_000)).toBe(true);
    expect(registry.owner).toEqual(claim('orient', 1_000, 4_000, 1));
    expect(registry.pump('orient', 4_100)).toBe(true);
    expect(registry.owner).toEqual(claim('orient', 1_000, 4_100, 2));
  });

  it('is overdue at the deadline and not before it, and only while someone owns the loop', () => {
    const registry = new StageRegistry();
    registry.claim('exit', 1_000);

    expect(registry.overdue(60_999, 60_000)).toBe(false);
    expect(registry.overdue(61_000, 60_000)).toBe(true);
    // The owner\'s own pump does not buy it a new deadline: the bound is the claim\'s, not the pump\'s.
    registry.pump('exit', 61_500);
    expect(registry.overdue(61_500, 60_000)).toBe(true);

    registry.release('exit');
    expect(registry.overdue(9_999_999, 60_000)).toBe(false);
  });

  it('lets any name claim after a release', () => {
    const registry = new StageRegistry();
    registry.claim('exit', 1_000);
    registry.release('exit');

    expect(registry.claim('orient', 2_000)).toEqual({ ok: true });
    expect(registry.owner).toEqual(claim('orient', 2_000));
  });
});
