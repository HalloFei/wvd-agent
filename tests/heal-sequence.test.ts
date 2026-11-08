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

  it('starts its bound at the card, and the page s own arrival does not spend it', () => {
    // Live 2026-11-09 04:39-04:40: the heal started, the card went 5 s later (the loop waited for a
    // stable view), the page was named 11 s after the card under the chest's HUD-less camera, and the
    // old bound — counted from `enter` — expired 4 s later with the sparkle owed. The rate is the
    // game's; the heal's budget is the wait for the page, and it starts at the tap.
    const s = make(12_000);
    s.enter(0);
    expect(s.next(dungeon(1), 2_000)).toEqual({ kind: 'wait', why: 'unstable' });
    expect(s.next(dungeon(2), 5_000)).toEqual({ kind: 'card', at: 'dungeon' });
    s.completed(5_000);
    // The page is opening: unnamed frames are the game's time.
    for (let at = 6_000; at <= 11_000; at += 1_000) {
      expect(s.next({ screen: 'unknown', stable: 1, page: false, blank: true }, at)).toEqual({ kind: 'wait', why: 'settle' });
    }
    // The page is named 11 s after the card but still settling: the game has answered, and the page's
    // own frames are not the deadline's either.
    for (let at = 12_000; at <= 17_000; at += 1_000) {
      expect(s.next(page(1), at)).toEqual({ kind: 'wait', why: 'unstable' });
    }
    expect(s.next(page(2), 18_000)).toEqual({ kind: 'sparkle', at: 'page' });
  });

  it('still gives up on a card that opened no page, past its retry', () => {
    const s = make(12_000);
    s.enter(0);
    expect(s.next(dungeon(2), 1_000)).toEqual({ kind: 'card', at: 'dungeon' });
    s.completed(1_000);
    // The card did not open the page: the one retry is spent, and the dungeon staying on screen then
    // counts — that is the wait the soft bound is for.
    expect(s.next(dungeon(2), 2_000)).toEqual({ kind: 'card', at: 'dungeon', redo: true });
    s.retried(2_000);
    for (let at = 3_000; at < 13_000; at += 1_000) {
      expect(s.next(dungeon(2), at)).toEqual({ kind: 'wait', why: 'settle' });
    }
    expect(s.next(dungeon(2), 13_000)).toEqual({ kind: 'done', why: 'gave-up' });
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
