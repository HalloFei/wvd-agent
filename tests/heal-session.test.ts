import { describe, expect, it } from 'vitest';
import { HealSession, type HealFacts } from '../src/policy/heal-session.ts';

/** Every fact at rest: no page, no dialog, an unnamed frame the episode must wait on. */
const idle: HealFacts = {
  settled: false, page: false, pageAt: null, dialog: false, dialogAt: null, dialogCancelAt: null,
  message: false, messageAt: null, pageGone: false, suspended: false,
};
const settled: HealFacts = { ...idle, settled: true };
const page: HealFacts = { ...idle, page: true, pageAt: { x: 699, y: 1_012 } };
const dialog: HealFacts = { ...idle, dialog: true, dialogAt: { x: 1_087, y: 802 }, dialogCancelAt: { x: 850, y: 802 } };
const pageGone: HealFacts = { ...idle, pageGone: true };
const suspended: HealFacts = { ...idle, suspended: true };
const message: HealFacts = { ...idle, message: true, messageAt: { x: 960, y: 570 } };

/** Send the decision's command and advance the pace, as the World does. */
function send(session: HealSession, at: number): void {
  session.sent(at);
}

describe('the heal episode', () => {
  it('runs card, sparkle, 恢复 and close, each gated by its own fact', () => {
    const session = new HealSession();
    session.enter(0);
    // Not settled: the page is owed, but the farm view has not held.
    expect(session.next(idle, 100)).toEqual({ kind: 'wait', why: 'not settled' });
    expect(session.next(settled, 1_000)).toEqual({ kind: 'send', step: 'card' });
    send(session, 1_000);
    // The page is up: the sparkle is the next act, from the page's own fact.
    expect(session.next(page, 2_000)).toEqual({ kind: 'send', step: 'sparkle' });
    send(session, 2_000);
    // The dialog is up: 恢复 goes to the point the dialog reader matched, never a fixed coordinate.
    expect(session.next(dialog, 3_000)).toEqual({ kind: 'send', step: 'restore', at: { x: 1_087, y: 802 } });
    send(session, 3_000);
    // The dialog is gone: the game processed the press (healed or not needed) — that is the fact.
    expect(session.next(page, 4_000)).toEqual({ kind: 'send', step: 'close' });
    send(session, 4_000);
    expect(session.next(pageGone, 5_000)).toEqual({ kind: 'done', unverified: false });
  });

  it('skips the card when a page is already up', () => {
    const session = new HealSession();
    session.enter(0, true);
    expect(session.next(page, 1_000)).toEqual({ kind: 'send', step: 'sparkle' });
  });

  it('treats full health as success: no dialog after the sparkle ends it, unverified', () => {
    // The operator's rule (2026-11-09): the box may say 已恢复。 or 不需要恢复; at full health the
    // sparkle may open no dialog at all. Either way the page is closed and the episode ends — failing
    // would leave the page open, which is the recursion.
    const session = new HealSession();
    session.enter(0, true);
    expect(session.next(page, 1_000)).toEqual({ kind: 'send', step: 'sparkle' });
    send(session, 1_000);
    // The sparkle's answer window is 3 s: the retry waits it out, not the pace.
    expect(session.next(page, 2_000)).toEqual({ kind: 'wait', why: 'waiting for the answer' });
    expect(session.next(page, 4_500)).toEqual({ kind: 'send', step: 'sparkle' });
    send(session, 4_500);
    // Budget spent: close instead of waiting for a dialog that will never come.
    expect(session.next(page, 6_600)).toEqual({ kind: 'send', step: 'close' });
    send(session, 6_600);
    expect(session.next(pageGone, 7_000)).toEqual({ kind: 'done', unverified: true });
  });

  it('suspends on the game s modal screens and keeps its step', () => {
    const session = new HealSession();
    session.enter(0, true);
    expect(session.next(page, 1_000)).toEqual({ kind: 'send', step: 'sparkle' });
    send(session, 1_000);
    expect(session.next(suspended, 2_000)).toEqual({ kind: 'wait', why: 'suspended' });
    // The battle over: the episode resumes where it was, not from the card.
    expect(session.next(dialog, 3_000)).toEqual({ kind: 'send', step: 'restore', at: { x: 1_087, y: 802 } });
  });

  it('advances the result box (either wording) instead of reading it', () => {
    const session = new HealSession();
    session.enter(0, true);
    // The dialog is up and 恢复 was pressed; a result box takes the frame.
    session.next(page, 1_000); send(session, 1_000);
    session.next(dialog, 2_000); send(session, 2_000);
    expect(session.next(message, 3_000)).toEqual({ kind: 'message', at: { x: 960, y: 570 } });
    expect(session.next(page, 4_000)).toEqual({ kind: 'send', step: 'close' });
  });

  it('closes with Esc first, then the page s matched tile, then fails', () => {
    const session = new HealSession();
    session.enter(0, true);
    session.next(page, 1_000); send(session, 1_000);            // sparkle
    session.next(dialog, 2_000); send(session, 2_000);          // restore
    expect(session.next(page, 3_000)).toEqual({ kind: 'send', step: 'close' });      // Esc
    send(session, 3_000);
    // The close's answer window is 2 s: the matched tile is the second attempt, not a pace-retry.
    expect(session.next(page, 4_000)).toEqual({ kind: 'wait', why: 'waiting for the answer' });
    expect(session.next(page, 5_200)).toEqual({ kind: 'send', step: 'close', at: { x: 699, y: 1_012 } }); // the tile
    send(session, 5_200);
    expect(session.next(page, 7_300)).toEqual({ kind: 'failed', why: 'the page would not close' });
  });

  it('fails on the episode s wall clock when nothing settles', () => {
    const session = new HealSession({ deadlineMs: 5_000 });
    session.enter(0);
    expect(session.next(idle, 1_000)).toEqual({ kind: 'wait', why: 'not settled' });
    expect(session.next(idle, 6_000)).toEqual({ kind: 'failed', why: 'deadline' });
  });

  it('paces the sends: the same step is not sent twice inside the pace', () => {
    const session = new HealSession({ stepMs: 900 });
    session.enter(0, true);
    session.next(page, 1_000); send(session, 1_000);
    expect(session.next(page, 1_500)).toEqual({ kind: 'wait', why: 'paced' });
    // Past the pace, still inside the sparkle's answer window: the retry waits for the dialog.
    expect(session.next(page, 2_000)).toEqual({ kind: 'wait', why: 'waiting for the answer' });
    expect(session.next(page, 4_500)).toEqual({ kind: 'send', step: 'sparkle' });
  });
});
