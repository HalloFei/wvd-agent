import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TRAVEL_IDS } from '../src/perception/locations.ts';
import { parseTask } from '../src/tasks/schema.ts';

const valid = {
  id: 'ffxi-4f',
  label: '[Chest] FFXI 4F',
  floor: { titleKey: '000000007f3ffe007f7efe00220ba600' },
  entry: { steps: [{ op: 'tap', at: [1200, 1030] }] },
  exit: { steps: [{ op: 'key', key: 'esc' }] },
};

const text = (value: unknown) => JSON.stringify(value);

describe('parseTask', () => {
  it('parses the committed FFXI 4F goal and its measured route', async () => {
    const raw = await readFile(new URL('../tasks/ffxi-4f.json', import.meta.url), 'utf8');
    const loaded = parseTask(raw, TRAVEL_IDS);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { task } = loaded;
    expect(task.id).toBe('ffxi-4f');
    // The live 2026-10-31 4F key; the older fixture key differs by three bits and is also accepted.
    expect(task.floor.titleKey).toBe('000000007f3ffe007ffeff00220bb600');

    // A goal task has no entry: the World orients from any screen to 北穿幽冥城's third zone, and
    // the farm sits behind the measured stair up from 第三区.
    expect(task.entry).toBeUndefined();
    expect(task.goal?.site).toBe('ffxi-gcn');
    expect(task.goal?.zone).toBe('ffxi-zone3');
    // No climb script any more (operator rule 2026-11-03): the farm's area is beside the **stair
    // entrance**, so the climb is the map's 楼梯-门 icon — the orientation taps it and the game walks
    // the party there from wherever it stands. The harken is *not* a way to the farm: it teleports far
    // from the farm area, and its list is not fixed (a harken offers a floor only once it is restored).
    expect(task.goal?.climb).toBeUndefined();

    // The exit is a **goal**, not a script (operator rule 2026-11-09): the World judges the frame and
    // the floor every tick, so an interrupted exit is re-derived instead of resuming a cursor. The
    // only data is where the cycle returns to.
    expect(task.exit).toBeUndefined();
    expect(task.leave).toEqual({ to: 'vnh' });

    // The cycle ends asleep at the inn (operator rule 2026-11-06): the rest town's 旅店 control,
    // measured 2026-11-06, and the visit's bound (the whole visit measured 23 s).
    expect(task.rest).toEqual({ at: { x: 916, y: 488 }, timeoutMs: 90000 });
  });

  it('parses a leave goal, and refuses the two exit forms at once', () => {
    const goal = {
      id: 't', label: 't', floor: { titleKey: 'a'.repeat(32) },
      goal: { site: 'vnh' }, leave: { to: 'vnh' },
    };
    const loaded = parseTask(text(goal), TRAVEL_IDS);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.task.leave).toEqual({ to: 'vnh' });
    expect(loaded.task.exit).toBeUndefined();

    // Two answers to one question.
    expect(parseTask(text({ ...goal, exit: { steps: [{ op: 'wait', ms: 1 }] } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'exclusive-field' });

    // The leave belongs to the goal form; a scripted task keeps its measured exit.
    const { goal: _goal, ...scripted } = goal;
    expect(parseTask(text({ ...scripted, entry: { steps: [{ op: 'wait', ms: 1 }] } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'missing-field' });

    // A destination the catalog does not know refuses at load, not mid-leave.
    expect(parseTask(text({ ...goal, leave: { to: 'nowhere' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'unknown-location' });

    // An unknown field in the leave is refused, never ignored.
    expect(parseTask(text({ ...goal, leave: { to: 'vnh', when: 'after' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('accepts a task without an exit script', () => {
    const { exit: _exit, ...withoutExit } = valid;
    const loaded = parseTask(text(withoutExit));

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.task.exit).toBeUndefined();
  });

  it('refuses JSON that does not parse', () => {
    expect(parseTask('{nope')).toEqual({ ok: false, reason: 'not-json' });
  });

  it('refuses a non-object', () => {
    expect(parseTask('[]')).toEqual({ ok: false, reason: 'not-an-object' });
  });

  it('refuses an unknown field at the top level', () => {
    expect(parseTask(text({ ...valid, extra: 1 }))).toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('refuses an unknown op', () => {
    const bad = { ...valid, entry: { steps: [{ op: 'jump', at: [1, 1] }] } };
    expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'unknown-op' });
  });

  it('refuses an unknown field inside a step', () => {
    const bad = { ...valid, entry: { steps: [{ op: 'tap', at: [1, 1], delay: 5 }] } };
    expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('refuses a coordinate outside the window', () => {
    const bad = { ...valid, entry: { steps: [{ op: 'tap', at: [99999, 1] }] } };
    expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'bad-coordinate' });
  });

  it('refuses a malformed floor key', () => {
    const bad = { ...valid, floor: { titleKey: 'xyz' } };
    expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'bad-title-key' });
  });

  it('parses an expectFloor that gates one leg with its own titleKey', () => {
    const key = '0c0280000d6ff0000d7ffc0008c37000';
    const withKey = { ...valid, entry: { steps: [{ op: 'expectFloor', titleKey: key, timeoutMs: 5000 }] } };
    const loaded = parseTask(text(withKey));

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.task.entry!.steps[0]).toEqual({ op: 'expectFloor', titleKey: key, timeoutMs: 5000 });
    }
  });

  it('refuses a per-step titleKey that is not 32 lowercase hex', () => {
    for (const badKey of ['xyz', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 42]) {
      const bad = { ...valid, entry: { steps: [{ op: 'expectFloor', titleKey: badKey }] } };
      expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'bad-title-key' });
    }
  });

  it('refuses titleKey on every step op but expectFloor', () => {
    const key = 'a'.repeat(32);
    for (const step of [
      { op: 'tap', at: [1, 1], titleKey: key },
      { op: 'key', key: 'g', titleKey: key },
      { op: 'wait', ms: 1, titleKey: key },
      { op: 'expect', screen: 'dungeon', titleKey: key },
      { op: 'travel', to: 'vnh', titleKey: key },
    ]) {
      expect(parseTask(text({ ...valid, entry: { steps: [step] } }), new Set(['vnh'])))
        .toMatchObject({ ok: false, reason: 'unknown-field' });
    }
  });

  it('refuses an empty step list and a zero timeout', () => {
    expect(parseTask(text({ ...valid, entry: { steps: [] } })))
      .toMatchObject({ ok: false, reason: 'missing-field' });
    expect(parseTask(text({ ...valid, entry: { timeoutMs: 0, steps: [{ op: 'wait', ms: 5 }] } })))
      .toMatchObject({ ok: false, reason: 'bad-timeout' });
  });

  it('parses a travel step and refuses a destination the catalog does not know', () => {
    const travel = { ...valid, entry: { steps: [{ op: 'travel', to: 'vnh' }] } };
    const loaded = parseTask(text(travel), new Set(['vnh']));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.task.entry!.steps[0]).toEqual({ op: 'travel', to: 'vnh' });

    expect(parseTask(text(travel), new Set(['ffxi-gcn']))).toMatchObject({ ok: false, reason: 'unknown-location' });
    expect(parseTask(text({ ...valid, entry: { steps: [{ op: 'travel' }] } }), new Set(['vnh'])))
      .toMatchObject({ ok: false, reason: 'missing-field' });
    expect(parseTask(text({ ...valid, entry: { steps: [{ op: 'travel', to: 'vnh', at: [1, 1] }] } }), new Set(['vnh'])))
      .toMatchObject({ ok: false, reason: 'unknown-field' });
    expect(parseTask(text({ ...valid, entry: { steps: [{ op: 'travel', to: '' }] } }), new Set(['vnh'])))
      .toMatchObject({ ok: false, reason: 'missing-field' });
  });

  it('refuses a key name it does not know', () => {
    const bad = { ...valid, exit: { steps: [{ op: 'key', key: 'enter' }] } };
    expect(parseTask(text(bad))).toMatchObject({ ok: false, reason: 'missing-field' });
  });

  // --- the goal form (contracts §10): a task that says where to farm instead of how to drive ---

  const goalTask = {
    id: 'ffxi-4f',
    label: '[Chest] FFXI 4F',
    floor: { titleKey: '000000007f3ffe007ffeff00220bb600' },
    goal: { site: 'ffxi-gcn', zone: 'ffxi-zone3' },
  };

  it('accepts a goal task with no entry, and a scripted task with no goal', () => {
    const goal = parseTask(text(goalTask), TRAVEL_IDS);
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    expect(goal.task.entry).toBeUndefined();
    expect(goal.task.goal).toEqual({ site: 'ffxi-gcn', zone: 'ffxi-zone3' });

    const scripted = parseTask(text(valid));
    expect(scripted.ok).toBe(true);
    if (scripted.ok) expect(scripted.task.goal).toBeUndefined();
  });

  it('refuses a task that carries both a goal and an entry, and one that carries neither', () => {
    expect(parseTask(text({ ...valid, goal: { site: 'ffxi-gcn' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'exclusive-field' });
    const { entry: _entry, ...noEntry } = valid;
    expect(parseTask(text(noEntry))).toMatchObject({ ok: false, reason: 'missing-field' });
  });

  it('refuses a goal site or zone the catalog does not know', () => {
    expect(parseTask(text({ ...goalTask, goal: { site: 'atlantis' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'unknown-location' });
    expect(parseTask(text({ ...goalTask, goal: { site: 'ffxi-gcn', zone: 'nowhere' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'unknown-location' });
    // a goal is validated only when the caller has a catalog to validate against
    expect(parseTask(text({ ...goalTask, goal: { site: 'atlantis' } })).ok).toBe(true);
  });

  it('parses the climb: its from-floor key and a script under the same rules', () => {
    const climb = {
      ...goalTask,
      goal: {
        site: 'ffxi-gcn',
        zone: 'ffxi-zone3',
        climb: {
          from: '0c0280000d6ff0000d7ffc0008c37000',
          script: { timeoutMs: 60000, steps: [{ op: 'key', key: 'r' }, { op: 'expectFloor', timeoutMs: 5000 }] },
        },
      },
    };
    const loaded = parseTask(text(climb), TRAVEL_IDS);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.task.goal?.climb?.from).toBe('0c0280000d6ff0000d7ffc0008c37000');
    expect(loaded.task.goal?.climb?.script.steps).toEqual([
      { op: 'key', key: 'r' },
      { op: 'expectFloor', timeoutMs: 5000 },
    ]);
  });

  // --- the cycle's rest (operator rule 2026-11-06): a cycle ends asleep at the inn ---

  it('parses the rest: the town\'s inn control and the visit\'s bound', () => {
    // The control is measured (the rest town's 旅店 entry at 916,488) and the bound is the whole
    // visit — three dialogs, the rest scene, the after-rest box and the way out: 23 s live.
    const loaded = parseTask(text({ ...goalTask, rest: { at: [916, 488], timeoutMs: 90000 } }), TRAVEL_IDS);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.task.rest).toEqual({ at: { x: 916, y: 488 }, timeoutMs: 90000 });
    // A task whose floor cycle has no inn simply has no rest block.
    const bare = parseTask(text(goalTask), TRAVEL_IDS);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.task.rest).toBeUndefined();
  });

  it('refuses a rest the World could not drive', () => {
    // No guessed bounds and no silent extra fields: a rest with a missing part would end a cycle
    // without resting and without saying so.
    expect(parseTask(text({ ...goalTask, rest: {} }), TRAVEL_IDS)).toMatchObject({ ok: false, reason: 'missing-field' });
    expect(parseTask(text({ ...goalTask, rest: { at: [916, 488] } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'bad-timeout' });
    expect(parseTask(text({ ...goalTask, rest: { at: [916], timeoutMs: 1 } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'missing-field' });
    expect(parseTask(text({ ...goalTask, rest: { at: [-1, 488], timeoutMs: 1 } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'bad-coordinate' });
    expect(parseTask(text({ ...goalTask, rest: { at: [916, 488], timeoutMs: 1, label: '旅店' } }), TRAVEL_IDS))
      .toMatchObject({ ok: false, reason: 'unknown-field' });
  });

  it('refuses a malformed climb key and a bad step inside the climb script', () => {
    const badKey = { ...goalTask, goal: { site: 'ffxi-gcn', climb: { from: 'xyz', script: { steps: [{ op: 'tap', at: [1, 1] }] } } } };
    expect(parseTask(text(badKey), TRAVEL_IDS)).toMatchObject({ ok: false, reason: 'bad-title-key' });
    const badStep = { ...goalTask, goal: { site: 'ffxi-gcn', climb: { from: 'a'.repeat(32), script: { steps: [{ op: 'jump' }] } } } };
    expect(parseTask(text(badStep), TRAVEL_IDS)).toMatchObject({ ok: false, reason: 'unknown-op' });
    const noSteps = { ...goalTask, goal: { site: 'ffxi-gcn', climb: { from: 'a'.repeat(32), script: { steps: [] } } } };
    expect(parseTask(text(noSteps), TRAVEL_IDS)).toMatchObject({ ok: false, reason: 'missing-field' });
  });
});
