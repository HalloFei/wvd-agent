import { describe, expect, it } from 'vitest';
import { SCAN } from '../src/actions/automove.ts';
import { DISARM_SCAN } from '../src/actions/chest.ts';
import type {
  ActionResult, Actuator, Frame, Observation, Perceiver, ScriptEnv, TaskDefinition, TaskScript, TravelOutcome,
} from '../src/contracts.ts';
import { createTaskPolicy } from '../src/tasks/policy.ts';
import { createTaskRunner } from '../src/tasks/runner.ts';
import { floorKeyDistance, isExpectedFloor, runSteps, TASK_KEYS } from '../src/tasks/steps.ts';
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

interface Recorder { calls: string[]; tapResult: ActionResult; keyResult: ActionResult; travelResult: TravelOutcome }

function makeEnv(options: {
  observations?: Observation[];
  tapResult?: ActionResult;
  keyResult?: ActionResult;
  travelResult?: TravelOutcome;
  capture?: () => Promise<Frame>;
  abort?: AbortSignal;
} = {}): { env: ScriptEnv; recorder: Recorder } {
  const recorder: Recorder = {
    calls: [],
    tapResult: options.tapResult ?? { ok: true },
    keyResult: options.keyResult ?? { ok: true },
    travelResult: options.travelResult ?? { ok: true },
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
    drag: async (from, to, durationMs) => {
      recorder.calls.push(`drag ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
      return { ok: true };
    },
  };
  const env: ScriptEnv = {
    actuator,
    capture: options.capture ?? (async () => frame()),
    observe,
    sleep: async () => {},
    abort: options.abort ?? new AbortController().signal,
    log: () => {},
    travel: async (to) => {
      recorder.calls.push(`travel ${to}`);
      return recorder.travelResult;
    },
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

  it('runs a travel step through the env and stops at its index on failure', async () => {
    const { env, recorder } = makeEnv();
    const passed = await runSteps(script([{ op: 'travel', to: 'vnh' }]), env, 'k'.repeat(32));
    expect(passed.ok).toBe(true);
    expect(recorder.calls).toEqual(['travel vnh']);

    const failing = makeEnv({ travelResult: { ok: false, reason: 'location-not-found', detail: 'not in view' } });
    const result = await runSteps(script([{ op: 'tap', at: [1, 2] }, { op: 'travel', to: 'vnh' }]), failing.env, 'k'.repeat(32));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe(1);
      expect(result.reason).toBe('location-not-found');
      expect(result.detail).toBe('not in view');
    }
  });

  it('agrees with the automove table on the keys it shares', () => {
    expect(TASK_KEYS.g).toBe(SCAN.destination);
    expect(TASK_KEYS.l).toBe(SCAN.chest);
    expect(TASK_KEYS.f).toBe(SCAN.exit);
    expect(TASK_KEYS.q).toBe(SCAN.mark);
  });

  it('agrees with the chest module on the disarm key', () => {
    expect(TASK_KEYS.space).toBe(DISARM_SCAN);
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

  it('lets a step titleKey override the task floor key, in both directions', async () => {
    const threeF = '0c0280000d6ff0000d7ffc0008c37000';
    const fourF = '000000007f3ffe007ffeff00220bb600';
    // The committed 4F fixture key differs from the live key by three bits; the tolerance accepts it.
    const fourFFixture = '000000007f3ffe007f7efe00220ba600';

    // The 4F step gate accepts the 4F frame even though the task's key is 3F.
    const onFour = makeEnv({ observations: [mapObservation(fourFFixture)] });
    expect(await runSteps(script([{ op: 'expectFloor', titleKey: fourF }]), onFour.env, threeF))
      .toMatchObject({ ok: true });

    // The same 4F frame under the task's 3F gate (no step key) is a mismatch.
    const wrongLeg = makeEnv({ observations: [mapObservation(fourFFixture)] });
    expect(await runSteps(script([{ op: 'expectFloor', timeoutMs: 150 }]), wrongLeg.env, threeF))
      .toMatchObject({ ok: false, reason: 'floor-mismatch' });

    // A 3F step gate reads the 3F frame the other way round.
    const onThree = makeEnv({ observations: [mapObservation(threeF)] });
    expect(await runSteps(script([{ op: 'expectFloor', titleKey: threeF }]), onThree.env, fourF))
      .toMatchObject({ ok: true });
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

  it('survives one stale frame while it probes for the open map', async () => {
    // Live 2026-11-02: a single `stale-frame` reply from the engine made the probe refuse, and the
    // session ended at the exit every cycle. The probe retries like every other capture does.
    const { env, recorder } = makeEnv({ observations: [mapObservation(), screen('dungeon')] });
    let failures = 1;
    const source = {
      capture: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('capture timeout: stale-frame');
        }
        return env.capture();
      },
    };
    const created = createTaskRunner({
      task: task(),
      source,
      perceiver: { observe: env.observe },
      actuator: env.actuator,
      log: () => {},
    });

    expect(await created.runScript('exit')).toMatchObject({ ok: true });
    expect(recorder.calls).toEqual(['key 1 60', 'tap 7,8']);
  });

  it('does nothing for a script the task does not carry', async () => {
    const { created, recorder } = runner([screen('dungeon')], task({ exit: undefined }));
    expect(await created.runScript('exit')).toEqual({ ok: true, steps: 0, ms: 0 });
    expect(recorder.calls).toEqual([]);
  });

  // --- the goal form: the World orients, the task carries the measured climb ---

  const climbKey = '0c0280000d6ff0000d7ffc0008c37000';

  it('runs the climb script, gated on the climb floor rather than the farm floor', async () => {
    const goalTask = task({
      entry: undefined,
      goal: {
        site: 'ffxi-gcn',
        climb: { from: climbKey, script: script([{ op: 'expectFloor', timeoutMs: 5_000 }, { op: 'tap', at: [9, 10] }]) },
      },
    });
    const { created, recorder } = runner([mapObservation(climbKey)], goalTask);

    // The task's own floor is 'k…': the climb's expectFloor would mismatch without its own key.
    expect(await created.runScript('climb')).toMatchObject({ ok: true });
    expect(recorder.calls).toEqual(['tap 9,10']);
  });

  it('refuses the climb on any other floor, before its measured taps', async () => {
    const goalTask = task({
      entry: undefined,
      goal: { site: 'ffxi-gcn', climb: { from: climbKey, script: script([{ op: 'expectFloor', timeoutMs: 150 }, { op: 'tap', at: [9, 10] }]) } },
    });
    const { created, recorder } = runner([mapObservation('b'.repeat(32))], goalTask);

    expect(await created.runScript('climb')).toMatchObject({ ok: false, reason: 'floor-mismatch' });
    expect(recorder.calls).toEqual([]);
  });

  it('hands the World the goal and the farm floor, and nothing for a scripted task', () => {
    const goal = { site: 'ffxi-gcn', zone: 'ffxi-zone3' };
    expect(runner([screen('dungeon')], task({ entry: undefined, goal })).created.orient)
      .toEqual({ goal, floor: 'k'.repeat(32) });
    expect(runner([screen('dungeon')]).created.orient).toBeUndefined();
  });

  it('runs no entry for a goal task: the orientation is the entry', async () => {
    const { created, recorder } = runner([screen('dungeon')], task({ entry: undefined, goal: { site: 'ffxi-gcn' } }));
    expect(await created.enter()).toEqual({ ok: true, steps: 0, ms: 0 });
    expect(recorder.calls).toEqual([]);
  });
});

describe('createTaskPolicy', () => {
  // A real 32-hex fingerprint: 'k' is not a hex digit and would read as a mismatch on its own.
  const KEY = 'a'.repeat(32);
  const state = (id: Observation['screen'], chests: number, mapKey = KEY) => ({
    observation: id === 'dungeonmap' ? mapObservation(mapKey) : screen(id),
    willpower: [100],
    chestsRemaining: chests,
    unreachable: [],
  });

  it('passes every non-exit intent through unchanged on the task floor', () => {
    const withTask = createTaskPolicy(() => ({ id: 't', label: 't', floor: { titleKey: KEY }, entry: script([]) }));
    for (const id of ['dungeon', 'dungeonmap', 'combat', 'chest-qte', 'unknown'] as const) {
      expect(withTask.next(state(id, 2))).toEqual(routePolicy.next(state(id, 2)));
    }
  });

  it('stops on a map that is not the task floor, before the route can act on it', () => {
    const withTask = createTaskPolicy(() => ({ id: 't', label: 't', floor: { titleKey: '0'.repeat(32) }, entry: script([]) }));
    const stopped = withTask.next(state('dungeonmap', 2));
    expect(stopped.kind).toBe('stop');
    if (stopped.kind !== 'stop') return;
    // Both keys are named, so the console says which floor it is standing on.
    expect(stopped.reason).toContain('not the task floor');
    expect(stopped.reason).toContain(KEY);
    expect(stopped.reason).toContain('0'.repeat(32));
  });

  it('accepts the task floor within the tolerance (R27b: 16 bits, measured 2026-11-02)', () => {
    // Two captures of 第三区-城内2F-, with and without the harken's glow behind the map.
    const clean = '0c0280000d6ff0000d7ffc0008c37000';
    const glow = '0c0280000d6ff8000d7ffc0008437000';
    const policy = createTaskPolicy(() => ({ id: 't', label: 't', floor: { titleKey: clean }, entry: script([]) }));
    expect(policy.next(state('dungeonmap', 2, glow)))
      .toEqual(routePolicy.next(state('dungeonmap', 2, glow)));
  });

  it('accepts the live 4F key the same floor produced from another camera, and still refuses 第三区', () => {
    // 2026-11-02: the farm floor's map, re-opened from the menu, read 9 bits from the task's own key
    // (the title strip carries the scene behind the translucent panel). The two collab floors read
    // 30-31 bits apart on the same day, which is the gap the tolerance has to stay under.
    const farm = '000000007f3ffe007ffeff00220bb600';
    const live = '600004007f3ffe007ffefe0002032200';
    const climb = '0c0280000d6ff0000d7ffc0008c37000';
    expect(floorKeyDistance(farm, live)).toBe(9);
    expect(floorKeyDistance(farm, climb)).toBe(31);

    const policy = createTaskPolicy(() => ({ id: 't', label: 't', floor: { titleKey: farm }, entry: script([]) }));
    expect(policy.next(state('dungeonmap', 2, live))).toEqual(routePolicy.next(state('dungeonmap', 2, live)));
    expect(policy.next(state('dungeonmap', 2, climb))).toMatchObject({ kind: 'stop' });
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