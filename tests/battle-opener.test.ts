import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, Point } from '../src/contracts.ts';
import {
  BATTLE_OPENER, BATTLE_SLOTS, ENEMY_TARGET_AT, OPENER_SETTLE_MS, PARTY_FRONT_AT, castBattleOpener,
} from '../src/actions/battle.ts';

/**
 * The battle opener (operator rule 2026-11-02): 爱丽丝's top-right skill, once at the start of a battle,
 * before auto takes over. Two taps and one pause — the slot, then the side the skill resolves over.
 */

function fakeActuator(...results: ActionResult[]): Actuator & { readonly taps: Point[] } {
  const taps: Point[] = [];
  const next = (): ActionResult => results.shift() ?? { ok: true };
  return {
    taps,
    tap: async (at) => { taps.push(at); return next(); },
    doubleTap: () => { throw new Error('the opener must tap, not double-tap'); },
    holdKey: () => { throw new Error('the opener must not press a key'); },
    drag: () => { throw new Error('the opener must not drag'); },
  };
}

const sleep = async (): Promise<void> => {};

describe('the battle opener', () => {
  it('taps the configured slot, waits for its panel, then taps the party side', async () => {
    const actuator = fakeActuator();
    const result = await castBattleOpener(actuator, BATTLE_OPENER, sleep);

    expect(result).toEqual({ ok: true });
    // 爱丽丝's entry: her top-right slot, then the front row's card for a multi-heal.
    expect(actuator.taps).toEqual([BATTLE_SLOTS['右上'], PARTY_FRONT_AT]);
    expect(BATTLE_OPENER).toEqual({ member: '爱丽丝', slot: '右上', target: 'party-front' });
  });

  it('aims an enemy-targeted opener at the enemy side', async () => {
    const actuator = fakeActuator();
    await castBattleOpener(actuator, { ...BATTLE_OPENER, target: 'enemy' }, sleep);

    expect(actuator.taps).toEqual([BATTLE_SLOTS['右上'], ENEMY_TARGET_AT]);
  });

  it('stops at a refused slot press and never taps the target', async () => {
    const actuator = fakeActuator({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    const result = await castBattleOpener(actuator, BATTLE_OPENER, sleep);

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect(actuator.taps).toHaveLength(1);
  });

  it('keeps the measured geometry: the slot is the top-right one, above the tabs', async () => {
    // Measured 2026-11-02 on the command phase: four quick slots in a 2x2 grid.
    expect(BATTLE_SLOTS['左上'].y).toBe(BATTLE_SLOTS['右上'].y);
    expect(BATTLE_SLOTS['左下'].y).toBe(BATTLE_SLOTS['右下'].y);
    expect(BATTLE_SLOTS['右上'].x).toBeGreaterThan(BATTLE_SLOTS['左上'].x);
    expect(BATTLE_SLOTS['左下'].y).toBeGreaterThan(BATTLE_SLOTS['左上'].y);
    expect(OPENER_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });
});
