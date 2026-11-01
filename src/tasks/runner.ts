/**
 * The task runner (design §7.7): turns one `TaskDefinition` plus one session's collaborators into
 * the `SessionTask` the loop knows.
 *
 * The loop's whole vocabulary here is three calls — `enter`, `runScript`, `abort` — so nothing above
 * this file reads a step, and nothing below it knows a session exists.
 */
import {
  type Actuator,
  type FrameSource,
  type Perceiver,
  type ScriptEnv,
  type ScriptId,
  type ScriptResult,
  type SessionTask,
  type TaskDefinition,
  type TaskScript,
} from '../contracts.ts';
import { travelTo } from '../actions/worldmap.ts';
import { runSteps, TASK_KEYS } from './steps.ts';

export interface TaskRunnerDeps {
  readonly task: TaskDefinition;
  readonly source: FrameSource;
  readonly perceiver: Perceiver;
  readonly actuator: Actuator;
  readonly log: (line: string) => void;
}

/** How long the exit script waits for the map to close before it refuses to press anything. */
const MAP_CLOSE_TIMEOUT_MS = 2_000;

/** The pause after `esc` before the 3D view is readable again; one loading transition measured ~1 s. */
const MAP_CLOSE_SETTLE_MS = 400;

export function createTaskRunner(deps: TaskRunnerDeps): SessionTask {
  const controller = new AbortController();

  const env = (): ScriptEnv => {
    const shared = {
      actuator: deps.actuator,
      capture: () => deps.source.capture(),
      observe: (frame: Parameters<Perceiver['observe']>[0]) => deps.perceiver.observe(frame),
      sleep: (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }),
      abort: controller.signal,
      log: deps.log,
      // The World travelling a task's node uses the stored atlas; the template spiral is the
      // fallback inside travelTo when the atlas cannot place the destination.
      atlas: true,
    };
    return {
      ...shared,
      travel: (to: string) => travelTo(to, { ...shared, now: () => Date.now() }),
    };
  };

  const screenScan = async (): Promise<string> => {
    const frame = await deps.source.capture();
    const observation = await deps.perceiver.observe(frame);
    return observation.screen;
  };

  /**
   * The policy can return `exit` with the map still open — that is the zero-chest case — but the
   * exit script's first steps assume the 3D view's keys. Normalise here, once, rather than making
   * every exit script start with a screen test the step language cannot express.
   */
  const closeMapIfOpen = async (): Promise<boolean> => {
    try {
      if (await screenScan() !== 'dungeonmap') return true;
      const closed = await deps.actuator.holdKey(TASK_KEYS.esc, 60);
      if (!closed.ok) {
        deps.log(`wvd: the exit script could not close the map (${closed.reason})`);
        return false;
      }
      await env().sleep(MAP_CLOSE_SETTLE_MS);
      const deadline = Date.now() + MAP_CLOSE_TIMEOUT_MS;
      for (;;) {
        if (await screenScan() !== 'dungeonmap') return true;
        if (Date.now() >= deadline) {
          deps.log('wvd: the map stayed open; the exit script will not press its keys blind');
          return false;
        }
        await env().sleep(100);
      }
    } catch {
      // A frame nobody could capture is not "the map is closed"; the script would press blind.
      deps.log('wvd: the exit script could not read the screen');
      return false;
    }
  };

  const runScript = async (name: ScriptId, script: TaskScript | undefined): Promise<ScriptResult> => {
    if (script === undefined) return { ok: true, steps: 0, ms: 0 };
    const startedAt = Date.now();
    if (name === 'exit' && !await closeMapIfOpen()) {
      return { ok: false, step: 0, reason: 'expect-timeout', detail: 'the map did not close' };
    }
    const result = await runSteps(script, env(), deps.task.floor.titleKey);
    deps.log(result.ok
      ? `wvd: ${name} script finished (${result.steps} steps, ${result.ms} ms)`
      : `wvd: ${name} script stopped at step ${result.step} (${result.reason}${result.detail ? `: ${result.detail}` : ''}) after ${Date.now() - startedAt} ms`);
    return result;
  };

  return {
    enter: () => runScript('enter', deps.task.entry),
    runScript: (name: ScriptId) => runScript(name, name === 'enter' ? deps.task.entry : deps.task.exit),
    abort: () => controller.abort(),
  };
}
