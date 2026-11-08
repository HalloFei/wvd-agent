import { describe, expect, it } from 'vitest';
import { HealSchedule, type HealScheduleOptions } from '../src/policy/heal-schedule.ts';

const schedule = (overrides: Partial<HealScheduleOptions> = {}): HealSchedule =>
  new HealSchedule({ afterBattles: 1, afterChests: 1, onEntry: false, afterRest: false, ...overrides });

describe('the heal schedule', () => {
  it('owes a heal after a completed battle, and pays it on completion', () => {
    const heal = schedule();
    expect(heal.due(0)).toEqual({ due: false });

    heal.battleCompleted();
    expect(heal.due(0)).toEqual({ due: true, cause: 'battles' });
    heal.completed();
    expect(heal.due(0)).toEqual({ due: false });
  });

  it('counts every Nth completed battle, and 0 never heals', () => {
    const everyTwo = schedule({ afterBattles: 2, afterChests: 0 });
    everyTwo.battleCompleted();
    expect(everyTwo.due(0)).toEqual({ due: false });
    everyTwo.battleCompleted();
    expect(everyTwo.due(0)).toEqual({ due: true, cause: 'battles' });

    const off = schedule({ afterBattles: 0, afterChests: 0 });
    for (let index = 0; index < 5; index += 1) off.battleCompleted();
    off.chestCompleted();
    expect(off.due(0)).toEqual({ due: false });
  });

  it('owes a heal after every Nth chest, and the two counters are independent', () => {
    const heal = schedule({ afterBattles: 3, afterChests: 2 });
    heal.battleCompleted();
    heal.chestCompleted();
    expect(heal.due(0)).toEqual({ due: false });
    heal.chestCompleted();
    expect(heal.due(0)).toEqual({ due: true, cause: 'chests' });
    // Paying the chest's debt clears the battle count too: the heal covers the party, one episode.
    heal.completed();
    heal.battleCompleted();
    expect(heal.due(0)).toEqual({ due: false });
    heal.battleCompleted();
    heal.battleCompleted();
    expect(heal.due(0)).toEqual({ due: true, cause: 'battles' });
  });

  it('arms the entry and rest flags only when the matrix asks for them', () => {
    const off = schedule({ afterBattles: 0, afterChests: 0 });
    off.enteredFloor();
    off.rested();
    expect(off.due(0)).toEqual({ due: false });

    const on = schedule({ afterBattles: 0, afterChests: 0, onEntry: true, afterRest: true });
    on.enteredFloor();
    expect(on.due(0)).toEqual({ due: true, cause: 'entry' });
    on.completed();

    on.rested();
    expect(on.due(0)).toEqual({ due: true, cause: 'rest' });
  });

  it('re-arms a given-up heal once after the backoff, then spends the debt', () => {
    const heal = schedule({ retryBackoffMs: 1_500 });
    heal.battleCompleted();
    expect(heal.due(0)).toEqual({ due: true, cause: 'battles' });

    // The first give-up keeps the debt: it is due again only after the backoff.
    expect(heal.gaveUp(10_000)).toBe(true);
    expect(heal.due(10_000)).toEqual({ due: false });
    expect(heal.due(11_499)).toEqual({ due: false });
    expect(heal.due(11_500)).toEqual({ due: true, cause: 'battles' });

    // The second give-up is the last: the episode's debt is spent, so an unfixable page cannot hold
    // the farm. The next completed event arms a fresh episode.
    expect(heal.gaveUp(12_000)).toBe(false);
    expect(heal.due(99_999)).toEqual({ due: false });
    heal.battleCompleted();
    expect(heal.due(99_999)).toEqual({ due: true, cause: 'battles' });
  });

  it('keeps the debt when another screen takes the frame, and cancels it on a trip or a cycle', () => {
    const heal = schedule();
    heal.chestCompleted();
    heal.abandoned();
    expect(heal.due(0)).toEqual({ due: true, cause: 'chests' });

    heal.cancel();
    expect(heal.due(0)).toEqual({ due: false });

    heal.battleCompleted();
    heal.resetCycle();
    expect(heal.due(0)).toEqual({ due: false });
  });
});
