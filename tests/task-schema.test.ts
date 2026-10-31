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
  it('parses the committed FFXI 4F task and its measured route', async () => {
    const raw = await readFile(new URL('../tasks/ffxi-4f.json', import.meta.url), 'utf8');
    const loaded = parseTask(raw, TRAVEL_IDS);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { task } = loaded;
    expect(task.id).toBe('ffxi-4f');
    // The live 2026-10-31 4F key; the older fixture key differs by three bits and is also accepted.
    expect(task.floor.titleKey).toBe('000000007f3ffe007ffeff00220bb600');

    // The stair-up leg is gated on 第三区's key, the arrival on 第四区's.
    const threeF = '0c0280000d6ff0000d7ffc0008c37000';
    const fourF = '000000007f3ffe007ffeff00220bb600';
    expect(task.entry.steps).toContainEqual({ op: 'expectFloor', titleKey: threeF, timeoutMs: 5000 });
    expect(task.entry.steps.at(-1)).toEqual({ op: 'expectFloor', titleKey: fourF, timeoutMs: 15000 });

    // The exit walks back through both floors, harkens out, then returns to town.
    expect(task.exit).toBeDefined();
    const exit = task.exit!.steps;
    expect(exit).toContainEqual({ op: 'tap', at: [1787, 96], count: 1 });
    expect(exit).toContainEqual({ op: 'tap', at: [960, 714], count: 1 });
    expect(exit.at(-2)).toEqual({ op: 'travel', to: 'vnh' });
    expect(exit.at(-1)).toEqual({ op: 'expect', screen: 'town', timeoutMs: 30000 });
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
      expect(loaded.task.entry.steps[0]).toEqual({ op: 'expectFloor', titleKey: key, timeoutMs: 5000 });
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
    if (loaded.ok) expect(loaded.task.entry.steps[0]).toEqual({ op: 'travel', to: 'vnh' });

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
});
