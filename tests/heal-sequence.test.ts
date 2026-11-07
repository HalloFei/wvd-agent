import { describe, expect, it } from 'vitest';
import type { ScreenId } from '../src/contracts.ts';
import { HealSequence, type HealPhase } from '../src/policy/heal-sequence.ts';

/**
 * The heal as a sequence (operator rule 2026-11-07: only the next order, from the current stable frame).
 * Live 2026-11-07 23:39-23:42: the old composite cleared #healDue before its close left the window, the
 * route asked open-map on the page's own frame, and the two alternated seven times before a stall.
 */
const dungeon = (stable = 2): HealPhase => ({ screen: 'dungeon' as ScreenId, stable, page: false });
const page = (stable = 2): HealPhase => ({ screen: 'character-page' as ScreenId, stable, page: true });
const make = (): HealSequence => new HealSequence({ stableFrames: 2, stepMs: 900, graceMs: 2_500, escapeGraceMs: 2_500 });

describe('the heal sequence', () => {
  it('runs card → sparkle → 恢复 → close, one step per paced tick, each from a stable frame', () => {
    const s = make();
    s.enter(0);
    expect(s.next(dungeon(1), 1_000)).toEqual({ kind: 'wait', why: 'unstable' });   // one frame is not a decision
    expect(s.next(dungeon(2), 1_000)).toEqual({ kind: 'card', at: 'dungeon' });
    s.completed(1_000);
    expect(s.next(page(2), 1_100)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next(page(2), 2_000)).toEqual({ kind: 'sparkle', at: 'page' });
    s.completed(2_000);
    expect(s.next(page(2), 2_899)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next(page(2), 3_000)).toEqual({ kind: 'restore', at: 'page' });
    s.completed(3_000);
    expect(s.next(page(2), 4_000)).toEqual({ kind: 'close', at: 'page' });
    s.completed(4_000);
  });

  it('is done only when a stable frame is not the page — the close is verified, not hoped for', () => {
    const s = make();
    s.enter(0);
    for (const [index, at] of [['card', 1_000], ['sparkle', 2_000], ['restore', 3_000], ['close', 4_000]] as const) {
      void index;
      s.next(index === 'card' ? dungeon(2) : page(2), at);
      s.completed(at);
    }
    // Right after the close the page is still there and still animating: that is a wait, not a finish.
    expect(s.next(page(2), 5_000)).toEqual({ kind: 'wait', why: 'page-closing' });
    // The page leaves, but the first frame of the dungeon is one frame, not a decision.
    expect(s.next(dungeon(1), 5_100)).toEqual({ kind: 'wait', why: 'unstable' });
    expect(s.next(dungeon(2), 5_200)).toEqual({ kind: 'done', why: 'closed' });
  });

  it('gives the page one Esc at the grace window, then gives up rather than pressing again', () => {
    const s = make();
    s.enter(0);
    s.next(dungeon(2), 1_000); s.completed(1_000);
    s.next(page(2), 2_000); s.completed(2_000);
    s.next(page(2), 3_000); s.completed(3_000);
    s.next(page(2), 4_000); s.completed(4_000);
    expect(s.next(page(2), 6_000)).toEqual({ kind: 'wait', why: 'page-closing' });
    expect(s.next(page(2), 6_600)).toEqual({ kind: 'escape' });
    s.escaped(6_600);
    expect(s.next(page(2), 7_600)).toEqual({ kind: 'wait', why: 'page-closing' });
    expect(s.next(page(2), 9_200)).toEqual({ kind: 'done', why: 'gave-up' });
  });
});
