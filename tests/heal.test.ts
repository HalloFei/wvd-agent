import { describe, expect, it } from 'vitest';
import type { Actuator, Point } from '../src/contracts.ts';
import {
  AUTO_HEAL_AT,
  AUTO_HEAL_CONFIRM_AT,
  CHARACTER_PAGE_AT,
  CHARACTER_PAGE_CLOSE_AT,
  HEAL_CLOSE_SETTLE_MS,
  HEAL_STEP_SETTLE_MS,
  closeCharacterPage,
  confirmAutoHeal,
  openAutoHeal,
  openCharacterPage,
} from '../src/actions/heal.ts';

/**
 * The 一键恢复 flow, measured live 2026-11-01 on the 1920x1080 client: party card -> character
 * page -> the sparkle at the stat panel's right -> 恢复 in the dialog -> X 关闭 back to the view.
 * These four points are measurements; a re-measured flow re-pins them.
 */
function recording(): Actuator & { readonly taps: Point[] } {
  const taps: Point[] = [];
  return {
    taps,
    tap: async (at) => { taps.push(at); return { ok: true }; },
    doubleTap: () => { throw new Error('the heal flow taps once'); },
    holdKey: () => { throw new Error('the heal flow presses no key'); },
    drag: () => { throw new Error('the heal flow does not drag'); },
  };
}

describe('the one-key heal', () => {
  it('runs party card -> sparkle -> 恢复 -> close, the close after its own longer settle', async () => {
    const actuator = recording();
    const sleep = async (): Promise<void> => {};
    await expect(openCharacterPage(actuator)).resolves.toEqual({ ok: true });
    await expect(openAutoHeal(actuator)).resolves.toEqual({ ok: true });
    await expect(confirmAutoHeal(actuator)).resolves.toEqual({ ok: true });
    await expect(closeCharacterPage(actuator)).resolves.toEqual({ ok: true });
    expect(actuator.taps).toEqual([
      { x: 1_009, y: 900 },
      { x: 1_220, y: 574 },
      { x: 1_087, y: 802 },
      { x: 699, y: 1_012 },
    ]);
    // One close tap, and it is the measured one: live 2026-11-03 a second tap at the same point would
    // open another party member's page from the 3-D view.
    expect(HEAL_CLOSE_SETTLE_MS).toBeGreaterThan(HEAL_STEP_SETTLE_MS);
  });

  it('pins the measured points', () => {
    expect(CHARACTER_PAGE_AT).toEqual({ x: 1_009, y: 900 });
    expect(AUTO_HEAL_AT).toEqual({ x: 1_220, y: 574 });
    expect(AUTO_HEAL_CONFIRM_AT).toEqual({ x: 1_087, y: 802 });
    expect(CHARACTER_PAGE_CLOSE_AT).toEqual({ x: 699, y: 1_012 });
  });

  it('returns a foreground refusal unchanged, without retrying', async () => {
    const rejected = { ok: false as const, reason: 'rejected' as const, detail: 'not-foreground' };
    const taps: Point[] = [];
    const actuator: Actuator = {
      tap: async (at) => { taps.push(at); return rejected; },
      doubleTap: async () => rejected,
      holdKey: async () => rejected,
      drag: async () => rejected,
    };
    await expect(openAutoHeal(actuator)).resolves.toBe(rejected);
    expect(taps).toHaveLength(1);
  });
});
