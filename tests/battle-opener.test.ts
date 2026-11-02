import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, BattleOpener, Point } from '../src/contracts.ts';
import {
  BATTLE_OPENERS, BATTLE_SLOTS, ENEMY_TARGET_AT, OPENER_SETTLE_MS, PARTY_FRONT_AT, castBattleOpener, memberKey,
  openerFor,
} from '../src/actions/battle.ts';

/**
 * The battle opener (operator rule 2026-11-02): a LIST of members with their skill and target. Every
 * command phase filters the ACTIVE member against it; a match casts (slot -> target), a miss takes the
 * default action and the battle carries on.
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
const alice: BattleOpener = { name: '爱丽丝', slot: '右上', target: 'party-front' };

describe('the battle opener filter', () => {
  it('is a list with 爱丽丝 and nobody else', () => {
    expect(BATTLE_OPENERS).toEqual([alice]);
  });

  it('finds the entry for a listed name, and null for anything else', () => {
    expect(openerFor('爱丽丝', BATTLE_OPENERS)).toEqual(alice);
    expect(openerFor('本杰明', BATTLE_OPENERS)).toBeNull();
    // A reader that cannot tell is a miss, never an error.
    expect(openerFor(null, BATTLE_OPENERS)).toBeNull();
  });

  it('folds the traditional spelling the operator may type onto the roster name', () => {
    // The panel draws 爱丽丝 and the operator's own notes sometimes write 愛麗絲.
    expect(memberKey('愛麗絲')).toBe('爱丽丝');
    expect(memberKey(' 爱丽丝 ')).toBe('爱丽丝');
    expect(openerFor('愛麗絲', BATTLE_OPENERS)).toEqual(alice);
    expect(openerFor('愛麗絲', [{ ...alice, name: '愛麗絲' }])).toEqual({ ...alice, name: '愛麗絲' });
    // Folding does not make two different members equal.
    expect(openerFor('艾莉赛', BATTLE_OPENERS)).toBeNull();
  });

  it('reads the slot and target from the entry, not from the member type', () => {
    const enemy: BattleOpener = { name: '本杰明', slot: '左下', target: 'enemy' };
    const list = [alice, enemy];
    expect(openerFor('本杰明', list)).toEqual(enemy);
    expect(openerFor('拉纳维尔', list)).toBeNull();
  });
});

describe('the battle opener cast', () => {
  it('taps the configured slot, waits for its panel, then taps the party side', async () => {
    const actuator = fakeActuator();
    const result = await castBattleOpener(actuator, alice, sleep);

    expect(result).toEqual({ ok: true });
    expect(actuator.taps).toEqual([BATTLE_SLOTS['右上'], PARTY_FRONT_AT]);
  });

  it('aims an enemy-targeted opener at the enemy side', async () => {
    const actuator = fakeActuator();
    await castBattleOpener(actuator, { ...alice, target: 'enemy' }, sleep);

    expect(actuator.taps).toEqual([BATTLE_SLOTS['右上'], ENEMY_TARGET_AT]);
  });

  it('stops at a refused slot press and never taps the target', async () => {
    const actuator = fakeActuator({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    const result = await castBattleOpener(actuator, alice, sleep);

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect(actuator.taps).toHaveLength(1);
  });

  it('keeps the measured geometry: the slot is the top-right one, above the tabs', () => {
    expect(BATTLE_SLOTS['左上'].y).toBe(BATTLE_SLOTS['右上'].y);
    expect(BATTLE_SLOTS['左下'].y).toBe(BATTLE_SLOTS['右下'].y);
    expect(BATTLE_SLOTS['右上'].x).toBeGreaterThan(BATTLE_SLOTS['左上'].x);
    expect(BATTLE_SLOTS['左下'].y).toBeGreaterThan(BATTLE_SLOTS['左上'].y);
    expect(OPENER_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });
});
