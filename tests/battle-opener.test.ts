import { describe, expect, it } from 'vitest';
import type { ActionResult, Actuator, BattleOpener, Point } from '../src/contracts.ts';
import {
  BATTLE_OPENERS, BATTLE_SLOTS, OPENER_SETTLE_MS, castBattleOpener, memberKey, openerFor,
  tapOpenerConfirm, tapOpenerSlot,
} from '../src/actions/battle.ts';

/**
 * The battle opener (operator rule 2026-11-02): a LIST of members with their skill and target side.
 * Every command phase filters the ACTIVE member against it; a match casts (slot -> the panel's
 * located 確定), a miss takes the default action and the battle carries on.
 *
 * The resolving press is **located on the frame** (`perception/battle-panel.ts`, the operator's rule of
 * 2026-11-07: *read the panel and tap the confirmation once you see it*). This module therefore presses
 * exactly the point its caller gives it — a fixed default here is what failed live (the same panel was
 * drawn at two different heights, and the fixed point landed on the panel's body).
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
/**
 * The operator's entry (2026-11-03): Alice's bottom-left slot is 拉巴迪奥斯的秘术, a 攻击范围=全体
 * damage spell, so the skill resolves over the enemy side.
 */
const alice: BattleOpener = { name: '爱丽丝', slot: '左下', target: 'enemy' };
/** What the filter is tested against. The shipped list is empty (opener disabled 2026-11-10). */
const OPENERS: readonly BattleOpener[] = [alice];
/** The panel's 確定 as the locator would answer it on the live 1920 client, 2026-11-07. */
const PANEL_CONFIRM: Point = { x: 1_053, y: 1_006 };

describe('the battle opener filter', () => {
  it('ships no opener while the battle action order is unmeasured', () => {
    // Disabled 2026-11-10 (run 9): the fastest member is not the configured opener, and the cast's
    // confirm never resolved. The sequence is still wired; an empty list is "no cast is ever owed".
    expect(BATTLE_OPENERS).toEqual([]);
  });

  it('finds the entry for a listed name, and null for anything else', () => {
    expect(openerFor('爱丽丝', OPENERS)).toEqual(alice);
    expect(openerFor('本杰明', OPENERS)).toBeNull();
    // A reader that cannot tell is a miss, never an error.
    expect(openerFor(null, OPENERS)).toBeNull();
  });

  it('folds the traditional spelling the operator may type onto the roster name', () => {
    // The panel draws 爱丽丝 and the operator's own notes sometimes write 愛麗絲.
    expect(memberKey('愛麗絲')).toBe('爱丽丝');
    expect(memberKey(' 爱丽丝 ')).toBe('爱丽丝');
    expect(openerFor('愛麗絲', OPENERS)).toEqual(alice);
    expect(openerFor('愛麗絲', [{ ...alice, name: '愛麗絲' }])).toEqual({ ...alice, name: '愛麗絲' });
    // Folding does not make two different members equal.
    expect(openerFor('艾莉赛', OPENERS)).toBeNull();
  });

  it('reads the slot and target from the entry, not from the member type', () => {
    const healer: BattleOpener = { name: '本杰明', slot: '右上', target: 'party-front' };
    const list = [alice, healer];
    expect(openerFor('本杰明', list)).toEqual(healer);
    expect(openerFor('拉纳维尔', list)).toBeNull();
  });
});

describe('the battle opener cast', () => {
  it('taps the configured slot, waits for its panel, then presses the located 確定', async () => {
    const actuator = fakeActuator();
    const result = await castBattleOpener(actuator, alice, PANEL_CONFIRM, sleep);

    expect(result).toEqual({ ok: true });
    expect(actuator.taps).toEqual([BATTLE_SLOTS['左下'], PANEL_CONFIRM]);
  });

  it('presses exactly the point it is given, and never a default one', async () => {
    // The panel moves between draws (the live client put the same panel at y 975–1035 and y 976–1037),
    // so a press at a fixed point lands on the panel's body and nothing resolves. The located point is
    // the only point this module presses.
    const actuator = fakeActuator();
    const moved: Point = { x: 1_048, y: 1_046 };
    await tapOpenerConfirm(actuator, moved);
    expect(actuator.taps).toEqual([moved]);
  });

  it('stops at a refused slot press and never presses the panel', async () => {
    const actuator = fakeActuator({ ok: false, reason: 'rejected', detail: 'not-foreground' });
    const result = await castBattleOpener(actuator, alice, PANEL_CONFIRM, sleep);

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect(actuator.taps).toHaveLength(1);
  });

  it('splits the cast into its two taps, each its own operation', async () => {
    // The World's battle sequence paces the slot and the resolving press as two operations, one per
    // step (operator rule 2026-11-04: never two operations at the same time). The combined
    // `castBattleOpener` stays for scripts and measurements.
    const slot = fakeActuator();
    await tapOpenerSlot(slot, alice);
    expect(slot.taps).toEqual([BATTLE_SLOTS['左下']]);

    const confirm = fakeActuator();
    await tapOpenerConfirm(confirm, PANEL_CONFIRM);
    expect(confirm.taps).toEqual([PANEL_CONFIRM]);
  });

  it('keeps the measured 2x2 quick-slot grid and the cast settle', () => {
    expect(BATTLE_SLOTS['左上'].y).toBe(BATTLE_SLOTS['右上'].y);
    expect(BATTLE_SLOTS['左下'].y).toBe(BATTLE_SLOTS['右下'].y);
    expect(BATTLE_SLOTS['左下'].x).toBe(BATTLE_SLOTS['左上'].x);
    expect(BATTLE_SLOTS['右上'].x).toBeGreaterThan(BATTLE_SLOTS['左上'].x);
    expect(BATTLE_SLOTS['左下'].y).toBeGreaterThan(BATTLE_SLOTS['左上'].y);
    expect(OPENER_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });
});
