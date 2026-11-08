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
  type Observation,
  type ScriptResult,
  type SessionTask,
  type TaskDefinition,
  type TaskScript,
} from '../contracts.ts';
import { travelTo } from '../actions/worldmap.ts';
import { advanceSteps, CAPTURE_ATTEMPTS, CAPTURE_RETRY_MS, runSteps, TASK_KEYS, type StepCursor } from './steps.ts';

export interface TaskRunnerDeps {
  readonly task: TaskDefinition;
  readonly source: FrameSource;
  readonly perceiver: Perceiver;
  readonly actuator: Actuator;
  readonly log: (line: string) => void;
  /**
   * Every floor of the site this deployment runs, the farm floor included: the leave goal judges a
   * map against them (policy/leave.ts). Absent means the task's own floor only — an entry floor then
   * reads as unknown and the leave stops rather than presses, which is the safe side.
   */
  readonly knownFloors?: readonly string[];
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

  /**
   * One screen probe. The capture is retried on the same policy every step uses: the engine answers
   * `stale-frame` while its worker recovers, and a single such reply must not refuse the exit (live
   * 2026-11-02: it ended a session at the exit on one stale frame).
   */
  const screenScan = async (): Promise<string> => {
    let failure: unknown = null;
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const frame = await deps.source.capture();
        const observation = await deps.perceiver.observe(frame);
        return observation.screen;
      } catch (error) {
        failure = error;
        await env().sleep(CAPTURE_RETRY_MS);
      }
    }
    throw failure instanceof Error ? failure : new Error(String(failure));
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
        if (await screenScan() !== 'dungeonmap') {
          // The map's closing fade is still running on the frames the script is about to press
          // into: a minimap tap right after the esc is swallowed, and the exit then stops at its
          // first `expect dungeonmap` (live 2026-11-02). Give the fade the same settle the steps use.
          await env().sleep(MAP_CLOSE_SETTLE_MS);
          return true;
        }
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

  /** The script a name stands for: the climb's floor gate is its own key, not the farm floor's. */
  const scriptFor = (name: ScriptId): { script: TaskScript | undefined; floor: string } => {
    if (name === 'enter') return { script: deps.task.entry, floor: deps.task.floor.titleKey };
    if (name === 'exit') return { script: deps.task.exit, floor: deps.task.floor.titleKey };
    return { script: deps.task.goal?.climb?.script, floor: deps.task.goal?.climb?.from ?? deps.task.floor.titleKey };
  };

  /**
   * The stage in progress: its name, the floor its `expectFloor` falls back to, and its cursor. A
   * per-tick stage keeps this across ticks; a completed or failed stage clears it, so a later script
   * starts from its first step.
   */
  let active: { readonly name: ScriptId; readonly floor: string; readonly cursor: StepCursor } | null = null;

  /**
   * One tick of a stage (operator rule 2026-11-05). The loop hands in the frame it just observed:
   * the stage runs at most one operation and yields, so the loop can dispatch a battle, the chest it
   * leaves behind, or the death scene between steps — and the stage resumes from its cursor.
   */
  const pumpScript = async (name: ScriptId, observation: Observation | null): Promise<ScriptResult> => {
    const { script, floor } = scriptFor(name);
    if (script === undefined) return { ok: true, steps: 0, ms: 0 };
    if (active === null || active.name !== name) {
      if (name === 'exit' && !await closeMapIfOpen()) {
        return { ok: false, step: 0, reason: 'expect-timeout', detail: 'the map did not close' };
      }
      active = { name, floor, cursor: { script, index: 0, untilMs: null, startedAtMs: Date.now() } };
    }
    const stage = active;
    const advance = await advanceSteps(stage.cursor, env(), stage.floor, observation);
    switch (advance.kind) {
      case 'done': {
        active = null;
        const ms = Date.now() - stage.cursor.startedAtMs;
        deps.log(`wvd: ${name} script finished (${advance.steps} steps, ${ms} ms)`);
        return { ok: true, steps: advance.steps, ms, complete: true };
      }
      case 'waiting':
        return { ok: true, steps: stage.cursor.index, ms: Date.now() - stage.cursor.startedAtMs, complete: false };
      case 'interrupted':
        return { ok: false, step: stage.cursor.index, reason: 'interrupted', detail: advance.screen };
      case 'failed':
        active = null;
        deps.log(`wvd: ${name} script stopped at step ${advance.stop.step} (${advance.stop.reason}${advance.stop.detail ? `: ${advance.stop.detail}` : ''})`);
        return advance.stop;
    }
  };

  const runScript = async (name: ScriptId, script: TaskScript | undefined, floor: string): Promise<ScriptResult> => {
    if (script === undefined) return { ok: true, steps: 0, ms: 0 };
    const startedAt = Date.now();
    if (name === 'exit' && !await closeMapIfOpen()) {
      return { ok: false, step: 0, reason: 'expect-timeout', detail: 'the map did not close' };
    }
    const result = await runSteps(script, env(), floor);
    deps.log(result.ok
      ? `wvd: ${name} script finished (${result.steps} steps, ${result.ms} ms)`
      : `wvd: ${name} script stopped at step ${result.step} (${result.reason}${result.detail ? `: ${result.detail}` : ''}) after ${Date.now() - startedAt} ms`);
    return result;
  };

  return {
    enter: () => {
      const { script, floor } = scriptFor('enter');
      return runScript('enter', script, floor);
    },
    runScript: (name: ScriptId, observation?: Observation | null) => {
      // No frame means no tick to hand the stage to: the climb and the entry run blocking, as before
      // (the World calls them outside its own dispatch). A frame means the exit stage's per-tick pump.
      if (observation === undefined) {
        const { script, floor } = scriptFor(name);
        return runScript(name, script, floor);
      }
      return pumpScript(name, observation);
    },
    abort: () => controller.abort(),
    ...(deps.task.goal === undefined
      ? {}
      : { orient: { goal: deps.task.goal, floor: deps.task.floor.titleKey } }),
    // The cycle's rest (operator rule 2026-11-06): the task's measured inn control, handed to the
    // World unchanged — the World owns the tap and the end-of-cycle condition.
    ...(deps.task.rest === undefined ? {} : { rest: deps.task.rest }),
    // The leave goal (2026-11-09): the World judges the exit from each frame, so what crosses to it
    // is the destination, the farm floor and the floors the site can recognise — never a cursor.
    ...(deps.task.leave === undefined
      ? {}
      : {
        leave: {
          to: deps.task.leave.to,
          farmFloor: deps.task.floor.titleKey,
          knownFloors: deps.knownFloors ?? [deps.task.floor.titleKey],
        },
      }),
  };
}