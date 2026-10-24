/**
 * The task decorator (design §7.9).
 *
 * It changes exactly one decision: when the inner policy says `exit` and the task carries an exit
 * script, the loop runs that script instead of pressing the game's own exit command. Every other
 * intent passes through untouched, so the route's behaviour — and every test of it — stays the
 * same with or without a task.
 *
 * Why a decorator and not a second policy: the moment this file knew about floors, chests or
 * screens it would be a policy of its own, and the two would drift.
 */
import type { FarmPolicy, Intent, TaskDefinition } from '../contracts.ts';
import { routePolicy } from '../policy/route.ts';

export function createTaskPolicy(
  current: () => TaskDefinition | null,
  inner: FarmPolicy = routePolicy,
): FarmPolicy {
  return {
    next(state): Intent {
      const intent = inner.next(state);
      if (intent.kind !== 'exit') return intent;
      const task = current();
      return task?.exit === undefined ? intent : { kind: 'run-script', name: 'exit' };
    },
  };
}
