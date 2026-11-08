/**
 * The five step primitives a task file can name (design §7.5).
 *
 * This module is the whole vocabulary of a task script, and it is small on purpose. It takes a
 * `TaskScript` — never a `TaskDefinition` — and talks to the machine through `ScriptEnv` only:
 * input through `Actuator`, sight through `FrameSource` + `Perceiver`. It has no opinion about
 * farming; a step that is not listed here is not a step.
 *
 * Failure is a value (§0.6). The first failing step ends the script with its index, so the console
 * can say exactly where the run stopped.
 */
import {
  MAX_PRESS_HOLD_MS,
  type ScriptEnv,
  type ScriptResult,
  type TaskKeyName,
  type TaskScript,
  type Frame,
  type Observation,
  type ScreenId,
  type TaskStep,
} from '../contracts.ts';

/**
 * The game keys a task may press, as Windows set-1 scan codes. G/L/F/Q are the dungeon map's own
 * commands and appear here only because a script may need to open the map; `tests/task-steps.test.ts`
 * asserts the four agree with `actions/automove.ts`'s `SCAN`, which stays authoritative for them.
 */
export const TASK_KEYS: Readonly<Record<TaskKeyName, number>> = {
  g: 0x22,
  l: 0x26,
  q: 0x10,
  f: 0x21,
  r: 0x13,
  tab: 0x0f,
  esc: 0x01,
  space: 0x39,
};

/**
 * How many of the fingerprint's 128 bits may differ and still be the same floor (R27b).
 *
 * The FFXI collab draws its map translucent over a lit 3D scene, and the title strip carries the
 * scene behind it, so the profile moves with the camera and the room. Measured 2026-11-02 on the
 * farm floor itself: the 第四区-城内2F深处- map, re-opened from the menu, read
 * `600004007f3ffe007ffefe0002032200` against the task's `000000007f3ffe007ffeff00220bb600` —
 * **9 bits** on the same floor. Two *different* collab floors measured 30 and 31 bits apart on the
 * same day, and the Latin floors of the base game differ in roughly half of the 128 bits. 16 keeps
 * the observed noise with a 2× margin to the nearest different floor.
 */
const FLOOR_KEY_TOLERANCE_BITS = 16;

/** Hamming distance over the 32-hex fingerprint. A malformed key matches nothing. */
export function floorKeyDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = Number.parseInt(a[index]!, 16);
    const right = Number.parseInt(b[index]!, 16);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
    let xor = left ^ right;
    while (xor !== 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** Is this the floor the task expects? Same key within tolerance (R27b). */
export function isExpectedFloor(expected: string, observed: string): boolean {
  return floorKeyDistance(expected, observed) <= FLOOR_KEY_TOLERANCE_BITS;
}

/** A press is held at least 60 ms (contracts §4): a 0 ms press is dropped at 30 fps. */
const DEFAULT_HOLD_MS = 60;

/** How often `expect` / `expectFloor` looks again. Three samples per contract tick (§0.5). */
const OBSERVE_INTERVAL_MS = 100;

/** When a step does not say how long to wait for its screen. One loading screen measured ~12 s. */
const DEFAULT_EXPECT_TIMEOUT_MS = 8_000;

/**
 * A warming child misses its first frame; three attempts is what the loop itself allows (§5).
 * Exported because `tests/fixtures/warmup-capture.ts` replays this policy against the real child:
 * one constant, so a change here moves the fixture too instead of leaving a second copy to drift.
 */
export const CAPTURE_ATTEMPTS = 3;

/** The wait between those attempts, exported for the same reason. */
export const CAPTURE_RETRY_MS = 200;

/** Resolve after `ms`, or as soon as the script is aborted — a stop never waits out a `wait`. */
function sleepUnlessAborted(env: ScriptEnv, ms: number): Promise<void> {
  if (env.abort.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      env.abort.removeEventListener('abort', finish);
      resolve();
    }
    env.abort.addEventListener('abort', finish, { once: true });
  });
}

type Stop = Extract<ScriptResult, { ok: false }>;

const stopped = (step: number, reason: Stop['reason'], detail?: string): Stop =>
  detail === undefined ? { ok: false, step, reason } : { ok: false, step, reason, detail };

/** One frame through the session's own source; a warm-up miss is retried, a real one is a stop. */
async function captureWithRetry(env: ScriptEnv): Promise<Frame | Stop> {
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      return await env.capture();
    } catch {
      await sleepUnlessAborted(env, CAPTURE_RETRY_MS);
    }
  }
  return stopped(0, 'capture-unavailable');
}

function isStop(value: unknown): value is Stop {
  return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok: unknown }).ok === false;
}

/**
 * Run one script. The steps run in order; the first failure returns immediately. `floorKey` is the
 * key an `expectFloor` step falls back to when it names none — a plain string, so this module never
 * needs the task object.
 */
export async function runSteps(
  script: TaskScript,
  env: ScriptEnv,
  floorKey: string,
): Promise<ScriptResult> {
  const startedAt = Date.now();
  for (let index = 0; index < script.steps.length; index += 1) {
    if (env.abort.aborted) return stopped(index, 'cancelled');
    if (Date.now() - startedAt > script.timeoutMs) return stopped(index, 'script-timeout');
    const step = script.steps[index]!;
    const outcome = await runStep(step, index, env, floorKey);
    if (outcome !== null) return outcome;
  }
  return { ok: true, steps: script.steps.length, ms: Date.now() - startedAt };
}

/** `null` means the step finished; a `Stop` means the script ends here. */
async function runStep(step: TaskStep, index: number, env: ScriptEnv, floorKey: string): Promise<Stop | null> {
  switch (step.op) {
    case 'tap': {
      const at = step.at!;
      const result = step.count === 2
        ? await env.actuator.doubleTap({ x: at[0], y: at[1] })
        : await env.actuator.tap({ x: at[0], y: at[1] });
      if (result.ok) return null;
      return stopped(index, result.reason, result.detail);
    }
    case 'key': {
      const scan = TASK_KEYS[step.key!];
      const hold = Math.min(MAX_PRESS_HOLD_MS, Math.max(1, step.holdMs ?? DEFAULT_HOLD_MS));
      const result = await env.actuator.holdKey(scan, hold);
      if (result.ok) return null;
      return stopped(index, result.reason, result.detail);
    }
    case 'open-map': {
      // "The map is open" is the step's meaning, so it looks before it presses: one `G` opens it from
      // the walking view (8 of 8 live, 2026-11-08), and a `G` on an already-open map is 移動至目的地.
      const captured = await captureWithRetry(env);
      if (isStop(captured)) return stopped(index, captured.reason, captured.detail);
      const observation = await env.observe(captured);
      if (observation.screen === 'dungeonmap') return null;
      const pressed = await env.actuator.holdKey(TASK_KEYS.g, DEFAULT_HOLD_MS);
      if (pressed.ok) return null;
      return stopped(index, pressed.reason, pressed.detail);
    }
    case 'wait':
      await sleepUnlessAborted(env, step.ms!);
      return env.abort.aborted ? stopped(index, 'cancelled') : null;
    case 'harken': {
      // The harken's list is not fixed (operator rule 2026-11-03): read the menu, tap the row the task
      // names, else 归还 to back out. Polls for the menu exactly as an expect step polls a screen.
      const deadline = Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
      for (;;) {
        if (env.abort.aborted) return stopped(index, 'cancelled');
        const captured = await captureWithRetry(env);
        if (isStop(captured)) return stopped(index, captured.reason, captured.detail);
        const observation = await env.observe(captured);
        if (observation.screen === 'harken-menu') {
          const wanted = step.destination === undefined
            ? undefined
            : observation.rows.find((row) => row.label === step.destination);
          const row = wanted ?? observation.rows.find((row) => row.label === '归还');
          if (row === undefined) return stopped(index, 'unknown-location', 'the harken menu offers no row to take');
          const tapped = await env.actuator.tap(row.at);
          if (!tapped.ok) return stopped(index, tapped.reason, tapped.detail);
          env.log(`harken: tapped ${row.label ?? '归还'} (${row.at.x},${row.at.y})`);
          return null;
        }
        if (Date.now() >= deadline) return stopped(index, 'expect-timeout', `screen stayed ${observation.screen}`);
        await sleepUnlessAborted(env, OBSERVE_INTERVAL_MS);
      }
    }
    case 'expect':
      return await pollScreen(step, index, env);
    case 'expectFloor':
      return await pollFloor(step, index, env, floorKey);
    case 'travel': {
      const result = await env.travel(step.to!);
      if (result.ok) return null;
      return stopped(index, result.reason, result.detail);
    }
    default:
      // The parser rejects an unknown op; a hand-built script with one is not runnable either.
      return stopped(index, 'expect-timeout', 'unknown-op');
  }
}

async function pollScreen(step: TaskStep, index: number, env: ScriptEnv): Promise<Stop | null> {
  const deadline = Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
  for (;;) {
    if (env.abort.aborted) return stopped(index, 'cancelled');
    const captured = await captureWithRetry(env);
    if (isStop(captured)) return stopped(index, captured.reason, captured.detail);
    const observation = await env.observe(captured);
    if (observation.screen === step.screen) return null;
    if (Date.now() >= deadline) {
      return stopped(index, 'expect-timeout', `screen stayed ${observation.screen}`);
    }
    await sleepUnlessAborted(env, OBSERVE_INTERVAL_MS);
  }
}

async function pollFloor(step: TaskStep, index: number, env: ScriptEnv, floorKey: string): Promise<Stop | null> {
  // A step may gate one leg (3F on the way up, 4F on arrival) with its own key.
  const expected = step.titleKey ?? floorKey;
  const deadline = Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
  let seen = 'no observation';
  for (;;) {
    if (env.abort.aborted) return stopped(index, 'cancelled');
    const captured = await captureWithRetry(env);
    if (isStop(captured)) return stopped(index, captured.reason, captured.detail);
    const observation = await env.observe(captured);
    if (observation.screen === 'dungeonmap') {
      if (isExpectedFloor(expected, observation.map.titleKey)) return null;
      seen = `floor ${observation.map.titleKey}`;
    } else {
      seen = `screen ${observation.screen}`;
    }
    if (Date.now() >= deadline) return stopped(index, 'floor-mismatch', seen);
    await sleepUnlessAborted(env, OBSERVE_INTERVAL_MS);
  }
}

/**
 * The screens the **loop** owns, not a stage: a battle, the chest it leaves behind, the death scene.
 * A per-tick stage never presses into one (operator rule 2026-11-05): it yields and keeps its cursor,
 * and the loop dispatches the plug-in the screen belongs to.
 */
export const WORLD_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'combat', 'chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'drop-item-claim',
  'main-character-dead', 'revive-qte', 'inn', 'message',
  // A page the knowledge base named (2026-11-06): the loop closes it by the catalog's exit, so a stage
  // must yield instead of pressing into it.
  'ui-menu',
]);

/** Where a per-tick stage is: the next step, and the clock its wait / expect is on. */
export interface StepCursor {
  readonly script: TaskScript;
  /** The next step to run. */
  index: number;
  /** `wait`: the earliest time it may finish; `expect`: the deadline it polls within. */
  untilMs: number | null;
  /** The stage's start, for `script.timeoutMs`. */
  startedAtMs: number;
}

/** One tick of a stage: done, waiting for the game, interrupted by a loop-owned screen, or failed. */
export type StepAdvance =
  | { readonly kind: 'done'; readonly steps: number }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'interrupted'; readonly screen: ScreenId }
  | { readonly kind: 'failed'; readonly stop: Stop };

/**
 * Run at most one **operation** of a stage per call (operator rule 2026-11-05). The loop hands in the
 * frame it just observed, so nothing polls the game here: a `wait` keeps a clock, an `expect` is
 * re-checked on the next frame, and an actuator step returns as soon as it is sent — the next tick
 * answers it. A loop-owned screen yields with the cursor untouched, so a battle in the middle of the
 * exit is dispatched by the loop and the stage resumes afterwards.
 */
export async function advanceSteps(
  cursor: StepCursor,
  env: ScriptEnv,
  floorKey: string,
  observation: Observation | null,
): Promise<StepAdvance> {
  const { script } = cursor;
  const screen = observation?.screen ?? null;
  for (let guard = 0; guard < 32; guard += 1) {
    if (env.abort.aborted) return { kind: 'failed', stop: stopped(cursor.index, 'cancelled') };
    if (Date.now() - cursor.startedAtMs > script.timeoutMs) {
      return { kind: 'failed', stop: stopped(cursor.index, 'script-timeout') };
    }
    if (cursor.index >= script.steps.length) return { kind: 'done', steps: script.steps.length };
    const step = script.steps[cursor.index]!;
    if (screen !== null && WORLD_SCREENS.has(screen)) return { kind: 'interrupted', screen };
    switch (step.op) {
      case 'tap': {
        const at = step.at!;
        const result = step.count === 2
          ? await env.actuator.doubleTap({ x: at[0], y: at[1] })
          : await env.actuator.tap({ x: at[0], y: at[1] });
        if (!result.ok) return { kind: 'failed', stop: stopped(cursor.index, result.reason, result.detail) };
        cursor.index += 1;
        return { kind: 'waiting' };
      }
      case 'key': {
        const scan = TASK_KEYS[step.key!];
        const hold = Math.min(MAX_PRESS_HOLD_MS, Math.max(1, step.holdMs ?? DEFAULT_HOLD_MS));
        const result = await env.actuator.holdKey(scan, hold);
        if (!result.ok) return { kind: 'failed', stop: stopped(cursor.index, result.reason, result.detail) };
        cursor.index += 1;
        return { kind: 'waiting' };
      }
      case 'open-map': {
        // Already open: the step is satisfied without a press (a press here would walk the party).
        if (screen === 'dungeonmap') {
          cursor.untilMs = null;
          cursor.index += 1;
          continue;
        }
        if (screen === null) return { kind: 'waiting' };
        const pressed = await env.actuator.holdKey(TASK_KEYS.g, DEFAULT_HOLD_MS);
        if (!pressed.ok) return { kind: 'failed', stop: stopped(cursor.index, pressed.reason, pressed.detail) };
        cursor.untilMs = null;
        cursor.index += 1;
        return { kind: 'waiting' };
      }
      case 'wait': {
        cursor.untilMs ??= Date.now() + (step.ms ?? 0);
        if (Date.now() < cursor.untilMs) return { kind: 'waiting' };
        cursor.untilMs = null;
        cursor.index += 1;
        continue;
      }
      case 'expect': {
        if (screen === null) return { kind: 'waiting' };
        if (screen === step.screen) {
          cursor.untilMs = null;
          cursor.index += 1;
          continue;
        }
        cursor.untilMs ??= Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
        if (Date.now() >= cursor.untilMs) {
          return { kind: 'failed', stop: stopped(cursor.index, 'expect-timeout', `screen stayed ${screen}`) };
        }
        return { kind: 'waiting' };
      }
      case 'expectFloor': {
        const expected = step.titleKey ?? floorKey;
        if (observation !== null && observation.screen === 'dungeonmap'
          && isExpectedFloor(expected, observation.map.titleKey)) {
          cursor.untilMs = null;
          cursor.index += 1;
          continue;
        }
        cursor.untilMs ??= Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
        if (Date.now() >= cursor.untilMs) {
          const seen = observation === null
            ? 'no observation'
            : observation.screen === 'dungeonmap'
              ? `floor ${observation.map.titleKey}`
              : `screen ${observation.screen}`;
          return { kind: 'failed', stop: stopped(cursor.index, 'floor-mismatch', seen) };
        }
        return { kind: 'waiting' };
      }
      case 'harken': {
        if (observation === null || observation.screen !== 'harken-menu') {
          cursor.untilMs ??= Date.now() + (step.timeoutMs ?? DEFAULT_EXPECT_TIMEOUT_MS);
          if (Date.now() >= cursor.untilMs) {
            return { kind: 'failed', stop: stopped(cursor.index, 'expect-timeout', `screen stayed ${screen ?? 'unknown'}`) };
          }
          return { kind: 'waiting' };
        }
        const wanted = step.destination === undefined
          ? undefined
          : observation.rows.find((row) => row.label === step.destination);
        const row = wanted ?? observation.rows.find((row) => row.label === '归还');
        if (row === undefined) {
          return { kind: 'failed', stop: stopped(cursor.index, 'unknown-location', 'the harken menu offers no row to take') };
        }
        const tapped = await env.actuator.tap(row.at);
        if (!tapped.ok) return { kind: 'failed', stop: stopped(cursor.index, tapped.reason, tapped.detail) };
        env.log(`harken: tapped ${row.label ?? '归还'} (${row.at.x},${row.at.y})`);
        cursor.untilMs = null;
        cursor.index += 1;
        return { kind: 'waiting' };
      }
      case 'travel': {
        const result = await env.travel(step.to!);
        if (!result.ok) return { kind: 'failed', stop: stopped(cursor.index, result.reason, result.detail) };
        cursor.index += 1;
        return { kind: 'waiting' };
      }
      default:
        return { kind: 'failed', stop: stopped(cursor.index, 'expect-timeout', 'unknown-op') };
    }
  }
  return { kind: 'waiting' };
}
