import { describe, expect, it } from 'vitest';
import { SCAN } from '../src/actions/automove.ts';
import type {
  ActionResult, Actuator, Frame, Observation, Perceiver, ScriptEnv, TaskDefinition, TaskScript,
} from '../src/contracts.ts';
import { createTaskPolicy } from '../src/tasks/policy.ts';
import { createTaskRunner } from '../src/tasks/runner.ts';
import { isExpectedFloor, runSteps, TASK_KEYS } from '../src/tasks/steps.ts';
import { routePolicy } from '../src/policy/route.ts';

const frame = (atMs = 0): Frame => ({
  atMs,
  width: 1,
  height: 1,
  toRgba: async () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
});

const mapObservation = (titleKey = 'k'.repeat(32)): Observation => ({
  screen: 'dungeonmap',
  atMs: 0,
  confidence: 0.9,
  map: { floorTitle: '', titleKey, player: { x: 1, y: 1 }, origin: { x: 960, y: 540 }, icons: [] },
});

const screen = (id: Observation['screen']): Observation => ({ screen: id, atMs: 0, confidence: 0.9 } as Observation);

interface Recorder { calls: string[]; tapResult: ActionResult; keyResult: ActionResult }

function makeEnv(options: {
  observations?: Observation[];
  tapResult?: ActionResult;
  keyResult?: ActionResult;
  capture?: () => Promise<Frame>;
  abort?: AbortSignal;
} = {}): { env: ScriptEnv; recorder: Recorder } {
  const recorder: Recorder = {
    calls: [],
    tapResult: options.tapResult ?? { ok: true },
    keyResult: options.keyResult ?? { ok: true },
  };
  const queue = options.observations !== undefined ? [...options.observations] : [screen('dungeon')];
  const observe = async (): Promise<Observation> => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const actuator: Actuator = {
    tap: async (at) => {
      recorder.calls.push(`tap ${at.x},${at.y}`);
      return recorder.tapResult;
    },
    doubleTap: async (at) => {
      recorder.calls.push(`double ${at.x},${at.y}`);
      return recorder.tapResult;
    },
    holdKey: async (scan, hold) => {
      recorder.calls.push(`key ${scan} ${hold}`);
      return recorder.keyResult;
    },
  };
  const env: ScriptEnv = {
    actuator,
    capture: options.capture ?? (async () => frame()),
    observe,
    sleep: async () => {},
    abort: options.abort ?? new AbortController().signal,
    log: () => {},
  };
  return { env, recorder };
}

const script = (steps: TaskScript['steps'], timeoutMs = 5_000): TaskScript => ({ timeoutMs, steps });

describe('runSteps', () => {
  it('runs the steps in order through the actuator', async () => {
    const { env, recorder } = makeEnv();
    const result = await runSteps(script([
      { op: 'tap', at: [10, 20] },
      { op: 'key', key: 'g' },
      { op: 'tap', at: [30, 40], count: 2 },
    ]), env, 'k'.repeat(32));

    expect(result.ok).toBe(true);
    expect(recorder.calls).toEqual(['tap 10,20', 'key 34 60', 'double 30,40']);
  });

  it('agrees with the automove table on the keys it shares', () => {
    expect(TASK_KEYS.g).toBe(SCAN.destination);
    expect(TASK_KEYS.l).toBe(SCAN.chest);
    expect(TASK_KEYS.f).toBe(SCAN.exit);
    expect(TASK_KEYS.q).toBe(SCAN.mark);
  });

  it('clamps a hold to the press ceiling', async () => {
    const { env, recorder } = makeEnv();
    await runSteps(script([{ op: 'key', key: 'g', holdMs: 9_999 }]), env, 'k'.repeat(32));
    expect(recorder.calls).toEqual(['key 34 500']);
  });

  it('ends the script at a refused press, with the step index', async () => {
    const { env } = makeEnv({ tapResult: { ok: false, reason: 'rejected', detail: 'not-foreground' } });
    const result = await runSteps(script([
      { op: 'wait', ms: 1 },
      { op: 'tap', at: [1, 2] },
      { op: 'tap', at: [3, 4] },
    ]), env, 'k'.repeat(32));

    expect(result).toMatchObject({ ok: false, step: 1, reason: 'rejected' });
  });

  it('waits for a screen and times out with its name', async () => {
    const { env } = makeEnv({ observations: [screen('dungeon')] });
    const result = await runSteps(script([{ op: 'expect', screen: 'dungeonmap', timeoutMs: 200 }]), env, 'k');

    expect(result).toMatchObject({ ok: false, step: 0, reason: 'expect-timeout' });
  });

  it('passes expectFloor only when the key matches', async () => {
    const good = makeEnv({ observations: [mapObservation('a'.repeat(32))] });
    expect(await runSteps(script([{ op: 'expectFloor' }]), good.env, 'a'.repeat(32))).toMatchObject({ ok: true });

    const bad = makeEnv({ observations: [mapObservation('b'.repeat(32))] });
    expect(await runSteps(script([{ op: 'expectFloor', timeoutMs: 150 }]), bad.env, 'a'.repeat(32)))
      .toMatchObject({ ok: false, reason: 'floor-mismatch' });
  });

  it('fails the step when the camera cannot produce a frame', async () => {
    const { env } = makeEnv({ capture: async () => { throw new Error('no-frame'); } });
    const result = await runSteps(script([{ op: 'expect', screen: 'dungeon', timeoutMs: 100 }]), env, 'k');

    expect(result).toMatchObject({ ok: false, reason: 'capture-unavailable' });
  });

  it('stops at once when the script is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { env, recorder } = makeEnv({ abort: controller.signal });
    const result = await runSteps(script([{ op: 'tap', at: [1, 1] }]), env, 'k');

    expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(recorder.calls).toEqual([]);
  });
});

describe('createTaskRunner', () => {
  const task = (overrides: Partial<TaskDefinition> = {}): TaskDefinition => ({
    id: 't',
    label: 't',
    floor: { titleKey: 'k'.repeat(32) },
    entry: script([{ op: 'tap', at: [5, 6] }]),
    exit: script([{ op: 'tap', at: [7, 8] }]),
    ...overrides,
  });

  function runner(observations: Observation[], taskDef = task()) {
    const { env, recorder } = makeEnv({ observations });
    const perceiver: Perceiver = { observe: env.observe };
    const created = createTaskRunner({
      task: taskDef,
      source: { capture: env.capture },
      perceiver,
      actuator: env.actuator,
      log: () => {},
    });
    return { created, recorder };
  }

  it('runs the entry script', async () => {
    const { created, recorder } = runner([screen('dungeon')]);
    expect(await created.enter()).toMatchObject({ ok: true });
    expect(recorder.calls).toEqual(['tap 5,6']);
  });

  it('closes an open map before the exit script presses anything', async () => {
    const { created, recorder } = runner([mapObservation(), screen('dungeon')]);
    expect(await created.runScript('exit')).toMatchObject({ ok: true });
    expect(recorder.calls).toEqual(['key 1 60', 'tap 7,8']);
  });

  it('refuses the exit script when the map will not close', async () => {
    const { created, recorder } = runner([mapObservation()]);
    expect(await created.runScript('exit')).toMatchObject({ ok: false, reason: 'expect-timeout' });
    expect(recorder.calls).toEqual(['key 1 60']);
  });

  it('does nothing for a script the task does not carry', async () => {
    const { created, recorder } = runner([screen('dungeon')], task({ exit: undefined }));
    expect(await created.runScript('exit')).toEqual({ ok: true, steps: 0, ms: 0 });
    expect(recorder.calls).toEqual([]);
  });
});

describe('createTaskPolicy', () => {
  const state = (id: Observation['screen'], chests: number) => ({
    observation: id === 'dungeonmap' ? mapObservation() : screen(id),
    willpower: [100],
    chestsRemaining: chests,
  });

  it('passes every non-exit intent through unchanged', () => {
    const withTask = createTaskPolicy(() => ({ id: 't', label: 't', floor: { titleKey: 'k' }, entry: script([]) }));
    for (const id of ['dungeon', 'dungeonmap', 'combat', 'chest-qte', 'unknown'] as const) {
      expect(withTask.next(state(id, 2))).toEqual(routePolicy.next(state(id, 2)));
    }
  });

  it('turns the exit intent into the task script when there is one', () => {
    const task: TaskDefinition = {
      id: 't', label: 't', floor: { titleKey: 'k'.repeat(32) },
      entry: script([{ op: 'wait', ms: 1 }]),
      exit: script([{ op: 'wait', ms: 1 }]),
    };
    const policy = createTaskPolicy(() => task);
    expect(policy.next(state('dungeon', 0))).toEqual({ kind: 'run-script', name: 'exit' });
  });

  it('leaves exit alone when the task has no exit script', () => {
    const policy = createTaskPolicy(() => ({
      id: 't', label: 't', floor: { titleKey: 'k'.repeat(32) }, entry: script([{ op: 'wait', ms: 1 }]),
    }));
    expect(policy.next(state('dungeon', 0))).toEqual({ kind: 'exit' });
  });
});

describe('isExpectedFloor', () => {
  it('accepts the same floor within tolerance and refuses another floor', () => {
    // Two captures of 第三区-城内2F- with and without the harken glow behind the map.
    const clean = '0c0280000d6ff0000d7ffc0008c37000';
    const glow = '0c0280000d6ff8000d7ffc0008437000';
    const other = '000000007f3ffe007f7efe00220ba600';

    expect(isExpectedFloor(clean, glow)).toBe(true);
    expect(isExpectedFloor(glow, clean)).toBe(true);
    expect(isExpectedFloor(clean, other)).toBe(false);
    expect(isExpectedFloor(clean, 'not-hex')).toBe(false);
  });
});
