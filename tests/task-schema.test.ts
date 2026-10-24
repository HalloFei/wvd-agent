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
  it('parses the committed FFXI 4F task', async () => {
    const raw = await readFile(new URL('../tasks/ffxi-4f.json', import.meta.url), 'utf8');
    const loaded = parseTask(raw, TRAVEL_IDS);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.task.id).toBe('ffxi-4f');
    expect(loaded.task.floor.titleKey).toMatch(/^[0-9a-f]{32}$/);
    expect(loaded.task.entry.steps.length).toBeGreaterThan(3);
    expect(loaded.task.exit).toBeDefined();
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
