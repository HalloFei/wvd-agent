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
import type { ActionResult, Actuator, BattleOpener, BattleSlot, Point } from '../contracts.ts';

/** The four quick slots of the command phase, measured 2026-11-02 (their centres). */
export const BATTLE_SLOTS: Readonly<Record<'左上' | '右上' | '左下' | '右下', Point>> = {
  左上: { x: 838, y: 638 },
  右上: { x: 1_080, y: 638 },
  左下: { x: 838, y: 700 },
  右下: { x: 1_080, y: 700 },
};



/**
 * The skill detail panel's **確定** is not a constant here: it is located on the frame
 * (`perception/battle-panel.ts`) and the press goes to the located centre. The panel moves between
 * draws — the same 拉巴迪奥斯的秘术 panel was at y 975–1035 on 2026-11-05 and y 976–1037 on
 * 2026-11-07 — so the fixed point this module used to export (1053,1005) landed on the panel's body
 * twice and nothing resolved (live 2026-11-07 22:00 and 22:13, 48 s and 45 s on the panel).
 */

/**
 * The operator's configuration: a list of members with their opener.
 *
 * **Empty since 2026-11-10 — the opener is off until the battle's action order is measured.** Run 9
 * (docs/status.md, `437af0a`) cast 爱丽丝's 左下 opener at a turn her row had not reached: the
 * fastest member is not the configured opener, so the command phase the cast needs did not open
 * where the cast was sent, and the confirm it spawned never resolved inside a frame the loop could
 * name (card `t-mw9jlglv-5pivpl`). The sequence is unchanged and correct for an empty list: no 自動
 * off, no slot, no confirm — the battle just plays itself (battle-sequence.ts, step 2).
 *
 * Restore the entry, pointed at whoever the party's fastest member is, when the order is measured;
 * nothing else needs to change.
 */
export const BATTLE_OPENERS: readonly BattleOpener[] = [];

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

/**
 * The cast's first tap: the member's configured quick slot, and nothing else. The World's battle
 * sequence sends this as one operation and waits out its own pace before the resolving press
 * (operator rule 2026-11-04: never two operations at the same time).
 */
export async function tapOpenerSlot(actuator: Actuator, opener: BattleOpener): Promise<ActionResult> {
  return actuator.tap(BATTLE_SLOTS[opener.slot]);
}

/**
 * The cast's second tap: exactly where the panel's **確定** was located on the frame. The function
 * takes the point, not the opener: the panel's position is perception's answer (live 2026-11-07), and
 * an unknown position is never replaced by a default one here.
 */
export async function tapOpenerConfirm(actuator: Actuator, at: Point): Promise<ActionResult> {
  return actuator.tap(at);
}

/**
 * Cast the opener in one call: the slot, a settle, then the press that resolves it, at the point the
 * caller located. Kept for the scripts and measurements that own no tick loop; the World's battle
 * sequence sends the two taps as two paced operations instead (they are the same two taps). A refused
 * slot press ends the chain and is returned unchanged, never retried.
 */
export async function castBattleOpener(
  actuator: Actuator,
  opener: BattleOpener,
  at: Point,
  sleep: (ms: number) => Promise<void>,
): Promise<ActionResult> {
  const slot = await tapOpenerSlot(actuator, opener);
  if (!slot.ok) return slot;
  await sleep(OPENER_SETTLE_MS);
  return tapOpenerConfirm(actuator, at);
}
