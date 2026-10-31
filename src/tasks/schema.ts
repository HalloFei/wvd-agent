/**
 * The task file's parser and validator (contracts §10, design §7.4).
 *
 * One job: `text` in, `TaskLoad` out. It reads no file, touches no game and imports nothing but
 * types, so a bad task file is a value the caller can report — never a throw into the loop.
 *
 * The rules are deliberately strict. An unknown field or an unknown op is **rejected**, not
 * ignored: a typo in a step name would otherwise be a silent no-op, and a task that silently skips
 * a step is how a party walks into the wrong floor.
 */
import type {
  ScreenId, TaskDefinition, TaskFileProblem, TaskLoad, TaskScript, TaskStep,
} from '../contracts.ts';

const SCREENS: ReadonlySet<string> = new Set<ScreenId>([
  'town', 'worldmap', 'dungeon', 'dungeonmap', 'combat',
  'chest-open', 'chest-qte', 'loot', 'loading', 'unknown',
]);

const KEY_NAMES: ReadonlySet<string> = new Set(['g', 'l', 'q', 'f', 'r', 'tab', 'esc', 'space']);

/** How long one script may take when the file does not say. One live entry measured ~45 s. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;

const MAX_COORDINATE = 16_383;

/** A floor title fingerprint: 32 lowercase hex, the shape `map.ts` measures (R27a). */
const TITLE_KEY = /^[0-9a-f]{32}$/;

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The failure branch alone, so a step parser can return it without claiming to be a whole load. */
type Problem = { readonly ok: false; readonly reason: TaskFileProblem; readonly detail?: string };

const problem = (reason: TaskFileProblem, detail?: string): Problem =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** Every field of a step, by op; anything else in the object is an unknown field. */
const STEP_FIELDS: Record<TaskStep['op'], readonly string[]> = {
  tap: ['op', 'at', 'count'],
  key: ['op', 'key', 'holdMs'],
  wait: ['op', 'ms'],
  expect: ['op', 'screen', 'timeoutMs'],
  expectFloor: ['op', 'titleKey', 'timeoutMs'],
  travel: ['op', 'to'],
};

function parseStep(raw: unknown, index: number, knownLocations?: ReadonlySet<string>): TaskStep | Problem {
  const where = `steps[${index}]`;
  if (!isObject(raw)) return problem('not-an-object', where);
  const op = raw.op;
  if (typeof op !== 'string' || !(op in STEP_FIELDS)) return problem('unknown-op', `${where}: ${String(op)}`);
  const fields = STEP_FIELDS[op as TaskStep['op']];
  for (const field of Object.keys(raw)) {
    if (!fields.includes(field)) return problem('unknown-field', `${where}: ${field}`);
  }
  if (op === 'tap') {
    const at = raw.at;
    if (!Array.isArray(at) || at.length !== 2) return problem('missing-field', `${where}: at`);
    const [x, y] = at;
    if (!Number.isInteger(x) || !Number.isInteger(y)
      || (x as number) < 0 || (x as number) > MAX_COORDINATE
      || (y as number) < 0 || (y as number) > MAX_COORDINATE) {
      return problem('bad-coordinate', `${where}: at`);
    }
    const count = raw.count ?? 1;
    if (count !== 1 && count !== 2) return problem('bad-coordinate', `${where}: count`);
    return { op, at: [x as number, y as number], count };
  }
  if (op === 'key') {
    if (typeof raw.key !== 'string' || !KEY_NAMES.has(raw.key)) return problem('missing-field', `${where}: key`);
    if (raw.holdMs !== undefined && (!Number.isInteger(raw.holdMs) || (raw.holdMs as number) < 1)) {
      return problem('bad-timeout', `${where}: holdMs`);
    }
    const step: TaskStep = { op, key: raw.key as TaskStep['key'] };
    return raw.holdMs === undefined ? step : { ...step, holdMs: raw.holdMs as number };
  }
  if (op === 'wait') {
    if (!Number.isInteger(raw.ms) || (raw.ms as number) < 1) return problem('bad-timeout', `${where}: ms`);
    return { op, ms: raw.ms as number };
  }
  if (op === 'expect') {
    if (typeof raw.screen !== 'string' || !SCREENS.has(raw.screen)) {
      return problem('missing-field', `${where}: screen`);
    }
    const timeoutMs = raw.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
      return problem('bad-timeout', `${where}: timeoutMs`);
    }
    return timeoutMs === undefined
      ? { op, screen: raw.screen as ScreenId }
      : { op, screen: raw.screen as ScreenId, timeoutMs: timeoutMs as number };
  }
  if (op === 'travel') {
    if (typeof raw.to !== 'string' || raw.to.length === 0) return problem('missing-field', `${where}: to`);
    if (knownLocations !== undefined && !knownLocations.has(raw.to)) {
      return problem('unknown-location', `${where}: ${raw.to}`);
    }
    return { op, to: raw.to };
  }
  // expectFloor: a step may gate one leg with its own key; the task's own key is the fallback.
  const titleKey = raw.titleKey;
  if (titleKey !== undefined && (typeof titleKey !== 'string' || !TITLE_KEY.test(titleKey))) {
    return problem('bad-title-key', `${where}: titleKey`);
  }
  const timeoutMs = raw.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
    return problem('bad-timeout', `${where}: timeoutMs`);
  }
  return {
    op: 'expectFloor',
    ...(titleKey === undefined ? {} : { titleKey: titleKey as string }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}

function parseScript(raw: unknown, name: string, knownLocations?: ReadonlySet<string>): TaskScript | Problem {
  if (!isObject(raw)) return problem('missing-field', name);
  for (const field of Object.keys(raw)) {
    if (field !== 'timeoutMs' && field !== 'steps') return problem('unknown-field', `${name}: ${field}`);
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) return problem('bad-timeout', `${name}: timeoutMs`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return problem('missing-field', `${name}: steps`);
  const steps: TaskStep[] = [];
  for (let index = 0; index < raw.steps.length; index += 1) {
    const step = parseStep(raw.steps[index], index, knownLocations);
    if (!('op' in step)) {
      return step.detail === undefined
        ? problem(step.reason, name)
        : problem(step.reason, `${name}: ${step.detail}`);
    }
    steps.push(step);
  }
  return { timeoutMs: timeoutMs as number, steps };
}

/**
 * Parse and validate one task file. `text` is the file as written; JSON syntax is checked here so
 * a caller never has to catch.
 */
export function parseTask(text: string, knownLocations?: ReadonlySet<string>): TaskLoad {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return problem('not-json');
  }
  if (!isObject(raw)) return problem('not-an-object');
  for (const field of Object.keys(raw)) {
    if (!['id', 'label', 'floor', 'entry', 'exit'].includes(field)) return problem('unknown-field', field);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) return problem('missing-field', 'id');
  if (typeof raw.label !== 'string' || raw.label.length === 0) return problem('missing-field', 'label');

  if (!isObject(raw.floor)) return problem('missing-field', 'floor');
  if (typeof raw.floor.titleKey !== 'string' || !TITLE_KEY.test(raw.floor.titleKey)) {
    return problem('bad-title-key', 'floor.titleKey');
  }

  const entry = parseScript(raw.entry, 'entry', knownLocations);
  if (!('steps' in entry)) return entry;
  const exit = raw.exit === undefined ? undefined : parseScript(raw.exit, 'exit', knownLocations);
  if (exit !== undefined && !('steps' in exit)) return exit;

  const task: TaskDefinition = {
    id: raw.id,
    label: raw.label,
    floor: { titleKey: raw.floor.titleKey },
    entry,
    ...(exit === undefined ? {} : { exit }),
  };
  return { ok: true, task };
}
