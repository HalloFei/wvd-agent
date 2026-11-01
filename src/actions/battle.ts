/**
 * The battle opener: cast one configured skill at the start of a battle, then let auto battle run.
 *
 * Operator rule 2026-11-02: 爱丽丝 opens every battle with the skill in her **top-right slot** — a
 * multi-heal, so one tap on a party member heals the whole party — and nobody else has an opener. Her
 * speed was reordered so she acts first, which is what makes "at the start" the first command phase.
 * For other skills the target is an enemy (one tap, the skill hits many), and the operator names them
 * case by case.
 *
 * Measured live 2026-11-02 on the 1920x1080 battle screen (fixtures testdata/battle-2026-11-02/):
 * the command phase draws four quick slots in a 2x2 grid over the tab row, and tapping one opens the
 * skill's detail panel with the target selection live behind it — so a cast is the slot tap and the
 * target tap, nothing else.
 *
 * The quick slots are the member's own pre-assigned skills (`技能切换`, R), so the level is whatever
 * the party configured: this module never picks a level.
 */
import type { ActionResult, Actuator, Point } from '../contracts.ts';

/** The four quick slots of the command phase, measured 2026-11-02 (their centres). */
export const BATTLE_SLOTS: Readonly<Record<'左上' | '右上' | '左下' | '右下', Point>> = {
  左上: { x: 838, y: 638 },
  右上: { x: 1_080, y: 638 },
  左下: { x: 838, y: 700 },
  右下: { x: 1_080, y: 700 },
};

/**
 * Where a cast is aimed. A multi-target skill resolves over its own targets, so the tap only says
 * "this side": the party (any member card — the `front` line is the front row's leftmost card) or an
 * enemy (the enemy the skill is anchored on).
 */
export type BattleTarget = 'party-front' | 'enemy';

/** The front row's leftmost member card: measured from the battle HUD, 2026-11-02. */
export const PARTY_FRONT_AT: Point = { x: 787, y: 939 };

/**
 * An enemy in the middle of the group the battle opens with. The enemies move with the camera, so a
 * hit that misses here is a *target* miss, not an input failure — the caller logs it and falls back to
 * auto, and a named recogniser for the enemy marker is the upgrade.
 */
export const ENEMY_TARGET_AT: Point = { x: 1_000, y: 540 };

export type BattleSlot = keyof typeof BATTLE_SLOTS;

export interface BattleOpener {
  /** The member the opener belongs to; the World logs it, and the ACTIVE check is the caller's. */
  readonly member: string;
  readonly slot: BattleSlot;
  readonly target: BattleTarget;
}

/**
 * The operator's configuration, for now as one constant: 爱丽丝's top-right skill, aimed at the party.
 * A second opener is a second entry when the config seam arrives (the console's config group).
 */
export const BATTLE_OPENER: BattleOpener = { member: '爱丽丝', slot: '右上', target: 'party-front' };

/** How long the detail panel / target selection needs before the target tap lands on it. */
export const OPENER_SETTLE_MS = 700;

const targetAt = (target: BattleTarget): Point => (target === 'enemy' ? ENEMY_TARGET_AT : PARTY_FRONT_AT);

/**
 * Cast the opener: the slot, a settle, the target. Two taps and one pause; a refused press ends the
 * chain and is returned unchanged, never retried — the caller logs it and lets auto battle run.
 */
export async function castBattleOpener(
  actuator: Actuator,
  opener: BattleOpener,
  sleep: (ms: number) => Promise<void>,
): Promise<ActionResult> {
  const slot = await actuator.tap(BATTLE_SLOTS[opener.slot]);
  if (!slot.ok) return slot;
  await sleep(OPENER_SETTLE_MS);
  return actuator.tap(targetAt(opener.target));
}
