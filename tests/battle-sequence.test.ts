import { describe, expect, it } from 'vitest';
import type { BattleOpener } from '../src/contracts.ts';
import { BattleSequence, type BattlePhase } from '../src/policy/battle-sequence.ts';

/**
 * The battle's operation sequence (operator rule 2026-11-04): a battle is turn-based, not real time,
 * so one decision can be slow. The loop does its operations in order, one at a time, on a settled
 * frame, paced in units of at least 700 ms (config default 1 s). Design:
 * `docs/specs/2026-11-04-battle-sequencing-design.md`.
 */
const alice: BattleOpener = { name: '爱丽丝', slot: '左下', target: 'enemy' };
const off: BattlePhase = { speedOn: false, autoOn: false, activeMember: null };
const aliceTurn: BattlePhase = { speedOn: false, autoOn: false, activeMember: '爱丽丝' };
const speedUp: BattlePhase = { speedOn: true, autoOn: false, activeMember: '爱丽丝' };

function make(openers: readonly BattleOpener[] = [alice]): BattleSequence {
  return new BattleSequence({ settleMs: 1_000, stepMs: 1_000, readWindowMs: 3_000, toggleAttempts: 3, openers });
}

describe('the battle operation sequence', () => {
  it('presses nothing before the settle window', () => {
    const s = make();
    s.enter(0);
    expect(s.next(aliceTurn, 999)).toEqual({ kind: 'wait', why: 'settle' });
    expect(s.next(aliceTurn, 1_000)).toEqual({ kind: 'speed' });
  });

  it('runs speed -> slot -> confirm -> auto, one operation per pace', () => {
    const s = make();
    s.enter(0);
    expect(s.next(aliceTurn, 1_000)).toEqual({ kind: 'speed' });
    s.completed(1_000);
    expect(s.next(speedUp, 1_999)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next(speedUp, 2_000)).toEqual({ kind: 'slot', opener: alice });
    s.completed(2_000);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 2_999)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 3_000)).toEqual({ kind: 'confirm', opener: alice });
    s.completed(3_000);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 4_000)).toEqual({ kind: 'auto' });
    s.completed(4_000);
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 5_000)).toEqual({ kind: 'done' });
  });

  it('measures the pace from the tap\'s return, not its start', () => {
    // The defect this pins: the old World stamped the pace with the frame the cast STARTED on, so
    // 自動 could follow the confirming tap ~100 ms later, inside the skill's resolution.
    const s = make();
    s.enter(0);
    expect(s.next(aliceTurn, 1_000)).toEqual({ kind: 'speed' });
    s.completed(1_700);
    expect(s.next(speedUp, 2_400)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next(speedUp, 2_700)).toEqual({ kind: 'slot', opener: alice });
  });

  it('waits for a readable turn card, and gives the cast up when the window expires', () => {
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 1_000)).toEqual({ kind: 'wait', why: 'unreadable' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 3_999)).toEqual({ kind: 'wait', why: 'unreadable' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 4_000)).toEqual({ kind: 'auto' });
  });

  it('does not cast a member that is not on the list', () => {
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: '本杰明' }, 1_000)).toEqual({ kind: 'auto' });
  });

  it('a battle already on auto gets 倍速 only, and is never cast into', () => {
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: false, autoOn: true, activeMember: null }, 1_000)).toEqual({ kind: 'speed' });
    s.completed(1_000);
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 2_000)).toEqual({ kind: 'done' });
  });

  it('an unreadable toggle is a wait, not a blind press', () => {
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: null, autoOn: null, activeMember: null }, 1_000)).toEqual({ kind: 'wait', why: 'no-evidence' });
  });

  it('a refused tap is paced and does not spend an attempt', () => {
    // A refused tap (the game window is not foreground) sent nothing: it must not consume one of the
    // configured attempts, and the step stays owed.
    const s = make();
    s.enter(0);
    expect(s.next(off, 1_000)).toEqual({ kind: 'speed' });
    s.refused(1_000);
    expect(s.next(off, 1_500)).toEqual({ kind: 'wait', why: 'paced' });
    expect(s.next(off, 2_000)).toEqual({ kind: 'speed' });
  });

  it('stops at the configured attempts with one cap wait', () => {
    const s = make();
    s.enter(0);
    for (let n = 0; n < 3; n += 1) {
      expect(s.next(off, 1_000 + n * 1_000)).toEqual({ kind: 'speed' });
      s.completed(1_000 + n * 1_000);
    }
    expect(s.next(off, 4_000)).toEqual({ kind: 'wait', why: 'speed-capped' });
    expect(s.next(off, 5_000)).toEqual({ kind: 'wait', why: 'speed-capped' });
  });

  it('does not read the panel when no opener is configured', () => {
    const s = new BattleSequence({ settleMs: 0, stepMs: 1_000, readWindowMs: 3_000, toggleAttempts: 3, openers: [] });
    s.enter(0);
    expect(s.needsMemberRead({ speedOn: null, autoOn: null, activeMember: null }, 0)).toBe(false);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 0)).toEqual({ kind: 'auto' });
  });
});
