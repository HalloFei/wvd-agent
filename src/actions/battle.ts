/**
 * The battle opener: cast one configured skill at the start of a battle, then let auto battle run.
 *
 * Operator rule (2026-11-02, revised 2026-11-03): 爱丽丝 opens every battle with the skill in her
 * **bottom-left slot** — 拉巴迪奥斯的秘术, whose 攻击范围 is 全体 — aimed at an enemy: any enemy tap
 * resolves the whole group. Her speed was reordered so she acts first, which is what makes "at the
 * start" the first command phase. Nobody else has an opener today. The party-target form stays for the
 * case it was written for (a skill that covers one row, where the tap names the row); no configured
 * member uses it.
 *
 * Measured live 2026-11-02 on the 1920x1080 battle screen (fixtures testdata/battle-2026-11-02/):
 * the command phase draws four quick slots in a 2x2 grid over the tab row, and tapping one opens the
 * skill's detail panel with the target selection live behind it — so a cast is the slot tap and the
 * target tap, nothing else.
 *
 * The quick slots are the member's own pre-assigned skills (`技能切换`, R), so the level is whatever
 * the party configured: this module never picks a level.
 */
import type { ActionResult, Actuator, BattleOpener, BattleSlot, BattleTarget, Point } from '../contracts.ts';

/** The four quick slots of the command phase, measured 2026-11-02 (their centres). */
export const BATTLE_SLOTS: Readonly<Record<'左上' | '右上' | '左下' | '右下', Point>> = {
  左上: { x: 838, y: 638 },
  右上: { x: 1_080, y: 638 },
  左下: { x: 838, y: 700 },
  右下: { x: 1_080, y: 700 },
};



/**
 * The party side of a party-targeted skill: the front row's leftmost member card, measured from the
 * battle HUD, 2026-11-02. No configured opener uses it today — Alice's is enemy-targeted — but the
 * contract's other target form resolves over this point.
 */
export const PARTY_FRONT_AT: Point = { x: 787, y: 939 };

/**
 * An enemy in the middle of the group the battle opens with — Alice's configured target. The enemies
 * move with the camera, so a hit that misses here is a *target* miss, not an input failure; the
 * caller logs it and falls back to auto, and a named recogniser for the enemy marker is the upgrade.
 */
export const ENEMY_TARGET_AT: Point = { x: 1_000, y: 540 };

/** The operator's configuration: a list of members with their opener. */
export const BATTLE_OPENERS: readonly BattleOpener[] = [
  { name: '爱丽丝', slot: '左下', target: 'enemy' },
];

/**
 * The traditional spellings of the roster's own characters (`src/perception/party.ts`): the game
 * draws simplified names, and the operator may type it in either script. Folding them keeps a config entry
 * written as 愛麗絲 matched to the 爱丽丝 the reader answers.
 */
const VARIANTS: Readonly<Record<string, string>> = {
  愛: '爱', 麗: '丽', 絲: '丝', 賽: '赛', 傑: '杰', 納: '纳', 維: '维',
};

/** The comparison key of a member's name: trimmed, and folded to the roster's own spelling. */
export function memberKey(name: string): string {
  let key = '';
  for (const char of name.trim()) key += VARIANTS[char] ?? char;
  return key;
}

/**
 * The filter: the opener configured for `name`, or null when the name is not on the list. A null answer
 * (the reader could not tell, or the member has no entry) is a miss — the caller takes its default path
 * and checks the next command phase, exactly as the operator asked.
 */
export function openerFor(name: string | null, openers: readonly BattleOpener[]): BattleOpener | null {
  if (name === null) return null;
  const key = memberKey(name);
  return openers.find((opener) => memberKey(opener.name) === key) ?? null;
}

/** How long the detail panel / target selection needs before the target tap lands on it. */
export const OPENER_SETTLE_MS = 700;

const targetAt = (target: BattleTarget): Point => (target === 'enemy' ? ENEMY_TARGET_AT : PARTY_FRONT_AT);

/**
 * The cast's first tap: the member's configured quick slot, and nothing else. The World's battle
 * sequence sends this as one operation and waits out its own pace before the resolving press
 * (operator rule 2026-11-04: never two operations at the same time).
 */
export async function tapOpenerSlot(actuator: Actuator, opener: BattleOpener): Promise<ActionResult> {
  return actuator.tap(BATTLE_SLOTS[opener.slot]);
}

/**
 * The cast's second tap: the skill's own **确认** when the operator configured its point, the target
 * side otherwise. The operator's correction (2026-11-03): *the skill cast is actually pressing 确认,
 * not a tap on the enemy*.
 */
export async function tapOpenerConfirm(actuator: Actuator, opener: BattleOpener): Promise<ActionResult> {
  return actuator.tap(opener.confirm ?? targetAt(opener.target));
}

/**
 * Cast the opener in one call: the slot, a settle, then the press that resolves it. Kept for the
 * scripts and measurements that own no tick loop; the World's battle sequence sends the two taps as
 * two paced operations instead (they are the same two taps). A refused slot press ends the chain and
 * is returned unchanged, never retried.
 */
export async function castBattleOpener(
  actuator: Actuator,
  opener: BattleOpener,
  sleep: (ms: number) => Promise<void>,
): Promise<ActionResult> {
  const slot = await tapOpenerSlot(actuator, opener);
  if (!slot.ok) return slot;
  await sleep(OPENER_SETTLE_MS);
  return tapOpenerConfirm(actuator, opener);
}
