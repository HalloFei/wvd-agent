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
  return new BattleSequence({ settleMs: 1_000, stepMs: 1_000, openerTimeoutMs: 10_000, toggleAttempts: 3, openers });
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

  it('keeps checking an unreadable state, and gives the cast up only at the timeout', () => {
    // The caller confirms the state across consecutive frames; the sequence's bound on the whole wait
    // is `openerTimeoutMs` (10 s by default), not a short window from the first miss.
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 1_000)).toEqual({ kind: 'wait', why: 'unreadable' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 5_000)).toEqual({ kind: 'wait', why: 'unreadable' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 10_999)).toEqual({ kind: 'wait', why: 'unreadable' });
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 11_000)).toEqual({ kind: 'auto' });
  });

  it('casts a confirmed state the caller hands it, with no extra settle', () => {
    // The two-frame confirmation is the caller's (the World's); the sequence trusts what it is given.
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: '爱丽丝' }, 1_000)).toEqual({ kind: 'slot', opener: alice });
  });

  it('does not cast a member that is not on the list', () => {
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: '本杰明' }, 1_000)).toEqual({ kind: 'auto' });
  });

  it('turns 自動 off to cast the opener, then back on', () => {
    // Operator rule 2026-11-04: a battle entered with 自動 on is disengaged — 自動 off, the opener cast
    // once by hand, 自動 back on. An auto battle draws no command phase, so it cannot be cast into.
    const s = make();
    s.enter(0);
    expect(s.next({ speedOn: false, autoOn: true, activeMember: null }, 1_000)).toEqual({ kind: 'speed' });
    s.completed(1_000);
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 2_000)).toEqual({ kind: 'auto-off' });
    s.completed(2_000);
    // The command phase is the loop's now: the card is read and the cast runs, still one tap per pace.
    expect(s.next({ speedOn: true, autoOn: false, activeMember: '爱丽丝' }, 3_000)).toEqual({ kind: 'slot', opener: alice });
    s.completed(3_000);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 4_000)).toEqual({ kind: 'confirm', opener: alice });
    s.completed(4_000);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 5_000)).toEqual({ kind: 'auto' });
    s.completed(5_000);
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 6_000)).toEqual({ kind: 'done' });
  });

  it('leaves an auto battle alone when no opener is configured', () => {
    // There is nothing to cast, so there is nothing to disengage: 自動 is never touched.
    const s = new BattleSequence({ settleMs: 0, stepMs: 1_000, openerTimeoutMs: 10_000, toggleAttempts: 3, openers: [] });
    s.enter(0);
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 0)).toEqual({ kind: 'done' });
  });

  it('gives the cast up when 自動 will not turn off', () => {
    const s = make();
    s.enter(0);
    for (let n = 0; n < 3; n += 1) {
      expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 1_000 + n * 1_000)).toEqual({ kind: 'auto-off' });
      s.completed(1_000 + n * 1_000);
    }
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 4_000)).toEqual({ kind: 'wait', why: 'auto-stuck' });
    expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 5_000)).toEqual({ kind: 'done' });
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
    const s = new BattleSequence({ settleMs: 0, stepMs: 1_000, openerTimeoutMs: 10_000, toggleAttempts: 3, openers: [] });
    s.enter(0);
    expect(s.needsMemberRead({ speedOn: null, autoOn: null, activeMember: null }, 0)).toBe(false);
    expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 0)).toEqual({ kind: 'auto' });
  });
});
