/**
 * The last reachable-chest check before the exit (operator, 2026-11-09).
 *
 * The farm's map reader draws its chest cells off a frame. On the FFXI floors that read misses them
 * now and then, and a floor whose chests were all skipped reads as empty too — so a leave that trusts
 * "no chest on the map" can walk the party out with chests still standing there.
 *
 * The game answers the question itself: **E is 移動至寶箱** on the dungeon map, and the game walks the
 * party to a reachable chest (measured live 2026-11-09 on the FFXI farm floor: one press, the map
 * closed, the screen came up `chest-prompt`). Before the leave presses F, the loop asks with one E
 * press — only where the answer is meaningful (the farm floor's map, no chest drawn) and only once
 * per floor visit.
 *
 * The probe is bounded: 5 s of the map staying up with no movement means the game has no chest
 * either. Any chest screen, or the map closing (the walk started), is the game answering.
 */
import type { Observation } from '../contracts.ts';
import { isExpectedFloor } from '../tasks/steps.ts';

/** How long the map may stay up after the E press before the game has said it has no chest, ms. */
export const CHEST_PROBE_MS = 5_000;

export type ChestProbeDecision =
  /** Press E now: the farm floor's map shows no chest, and this floor was not asked yet. */
  | { readonly kind: 'start' }
  /** The game answered with a chest screen: the farm continues, the leave yields. */
  | { readonly kind: 'found' }
  /** The map closed: the party is walking to a chest the game knows about. */
  | { readonly kind: 'walking' }
  /** The window is still open, the map still up: keep waiting. */
  | { readonly kind: 'wait' }
  /** The window closed with the map up: the game has no reachable chest, the exit may proceed. */
  | { readonly kind: 'none' }
  /** Nothing to do: not probing, and a probe does not start on this frame. */
  | { readonly kind: 'skip' };

export interface ChestProbeState {
  /** The running probe: the floor it was pressed on and when; null when not probing. */
  readonly probe: { readonly floor: string; readonly atMs: number } | null;
  /** The floor a probe already answered for (a chest found, or none) — never asked twice. */
  readonly done: string | null;
  /** The task's farm floor, or null when the task names none. */
  readonly farmFloor: string | null;
  /** The chest cells the farm's own map read carried for this floor. */
  readonly chestsShown: number;
}

/** The screens a chest's own flow can show: any of them is the probe's "yes". */
const CHEST_SCREENS: ReadonlySet<string> = new Set<string>([
  'chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'drop-item-claim', 'combat',
]);

/** The one decision this frame allows. Pure: one observation and the probe's small book in. */
export function nextChestProbe(
  observation: Observation,
  state: ChestProbeState,
  nowMs: number,
): ChestProbeDecision {
  if (state.probe !== null) {
    if (CHEST_SCREENS.has(observation.screen)) return { kind: 'found' };
    // The map closed: the game took the order and is walking. (A loading frame is the floor's own
    // transition; the walk's arrival says which screen it lands on.)
    if (observation.screen === 'dungeon' || observation.screen === 'loading' || observation.screen === 'unknown') {
      return { kind: 'walking' };
    }
    if (observation.screen === 'dungeonmap') {
      return nowMs - state.probe.atMs >= CHEST_PROBE_MS ? { kind: 'none' } : { kind: 'wait' };
    }
    // A page or the town took the frame: the loop owns it, and the probe is not re-asked blindly.
    return { kind: 'found' };
  }

  // A probe starts only on the farm floor's map, only when the map draws no chest, and only once.
  if (observation.screen !== 'dungeonmap') return { kind: 'skip' };
  if (state.farmFloor === null) return { kind: 'skip' };
  if (!isExpectedFloor(state.farmFloor, observation.map.titleKey)) return { kind: 'skip' };
  if (observation.map.icons.some((icon) => icon.kind === 'chest')) return { kind: 'skip' };
  if (state.chestsShown > 0) return { kind: 'skip' };
  // "Asked already" is the floor, not the string it was read as: the reader's title key drifts by up
  // to 9 bits of 128 on the same floor (src/tasks/steps.ts:44-54), so string equality re-asks a floor
  // every time its map is reopened — a walk the leave did not ask for, 5 s each time.
  if (state.done !== null && isExpectedFloor(state.done, observation.map.titleKey)) return { kind: 'skip' };
  return { kind: 'start' };
}
