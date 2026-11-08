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
/** The game's blank frame (a load or a battle's fade), which perception now names `loading`. */
const blank = (): HealPhase => ({ screen: 'loading' as ScreenId, stable: 30, page: false, blank: true });
const make = (deadlineMs = 12_000): HealSequence =>
  new HealSequence({ stableFrames: 2, stepMs: 900, graceMs: 2_500, escapeGraceMs: 2_500, deadlineMs });

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

  it('does not spend the heal s bound on frames the game blanked', () => {
    // Live 2026-11-08 20:44 and 20:46: the card opened the page, the battle's fade blanked the screen,
    // the frames answered `unknown` and the sequence sat out its 12 s bound on a page that was open the
    // whole time — then gave up, and the recovery branch closed the page without healing. The bound is
    // measured on the frames the heal could see.
    const s = make(12_000);
    s.enter(0);
    expect(s.next(dungeon(2), 1_000)).toEqual({ kind: 'card', at: 'dungeon' });
    s.completed(1_000);
    for (let at = 2_000; at <= 32_000; at += 1_000) {
      expect(s.next(blank(), at)).toEqual({ kind: 'wait', why: 'settle' });
    }
    // The screen comes back on the page: the owed step is sent, 30 s after the card.
    expect(s.next(page(2), 33_000)).toEqual({ kind: 'sparkle', at: 'page' });
  });

  it('still stops on the wall clock when the screen never comes back', () => {
    const s = make(12_000);                        // the hard bound is three deadlines
    s.enter(0);
    s.next(dungeon(2), 1_000); s.completed(1_000);
    for (let at = 2_000; at < 36_000; at += 1_000) s.next(blank(), at);
    expect(s.next(blank(), 37_000)).toEqual({ kind: 'done', why: 'gave-up' });
  });

  it('sends the card again when the tap was swallowed and the page never came', () => {
    const s = make(12_000);
    s.enter(0);
    expect(s.next(dungeon(2), 1_000)).toEqual({ kind: 'card', at: 'dungeon' });
    s.completed(1_000);
    // The 3-D view again, named and stable: the tap was swallowed, so the owed step is the card.
    expect(s.next(dungeon(2), 2_000)).toEqual({ kind: 'card', at: 'dungeon', redo: true });
    s.retried(2_000);
    // One retry, not a loop of them.
    expect(s.next(dungeon(2), 3_000)).toEqual({ kind: 'wait', why: 'settle' });
    // And the page that arrives late still gets its steps, from the step that was owed.
    expect(s.next(page(2), 4_000)).toEqual({ kind: 'sparkle', at: 'page' });
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
