/**
 * The task decorator (design §7.9).
 *
 * It changes two decisions:
 *
 * - **The floor gate** (§7.2). The map is the only surface that prints the floor, and the loop reads
 *   it exactly when it is about to steer, so the gate lives here — on the observation the move would
 *   be made from. It cannot live in the entry script: a script is blind and cannot wait out a
 *   game-driven walk, a fight or the 打开 prompt, and the map is opened by the loop after it.
 * - **The exit.** When the inner policy says `exit` and the task carries an exit script, the loop
 *   runs that script instead of pressing the game's own exit command.
 *
 * A map that is not the task's floor (within the 8-bit tolerance the FFXI frames need) stops the
 * session before any farm command is sent from it. Everything else passes through untouched, so the
 * route's behaviour — and every test of it — stays the same with or without a task.
 *
 * Why a decorator and not a second policy: the moment this file knew about chests, willpower or
 * screens beyond the floor key it would be a policy of its own, and the two would drift.
 */
import type { FarmPolicy, Intent, TaskDefinition } from '../contracts.ts';
import { routePolicy } from '../policy/route.ts';
import { isExpectedFloor } from './steps.ts';

export function createTaskPolicy(
  current: () => TaskDefinition | null,
  inner: FarmPolicy = routePolicy,
): FarmPolicy {
  return {
    next(state): Intent {
      const task = current();
      // The floor gate, on the frame the loop would steer from. Every map read is checked, so a
      // session that was steered onto the wrong floor stops here — before the move it authorizes.
      if (task !== null && state.observation.screen === 'dungeonmap'
        && !isExpectedFloor(task.floor.titleKey, state.observation.map.titleKey)) {
        return {
          kind: 'stop',
          reason: `the map is not the task floor: read ${state.observation.map.titleKey}, expected ${task.floor.titleKey}`,
        };
      }
      const intent = inner.next(state);
      if (intent.kind !== 'exit') return intent;
      // Either exit form is a stage the World runs instead of the game's own exit command: a measured
      // script (its cursor), or a leave goal (judged from each frame — policy/leave.ts).
      if (task === null) return intent;
      return task.exit === undefined && task.leave === undefined ? intent : { kind: 'run-script', name: 'exit' };
    },
  };
}
