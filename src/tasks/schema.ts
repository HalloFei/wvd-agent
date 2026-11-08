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
  Point, ScreenId, TaskClimb, TaskDefinition, TaskFileProblem, TaskGoal, TaskLeave, TaskLoad, TaskRest,
  TaskScript, TaskStep,
} from '../contracts.ts';

const SCREENS: ReadonlySet<string> = new Set<ScreenId>([
  'town', 'worldmap', 'dungeon', 'dungeonmap', 'combat',
  'chest-open', 'chest-qte', 'drop-item-claim', 'loading', 'dungeon-select', 'unknown',
]);

const KEY_NAMES: ReadonlySet<string> = new Set(['g', 'e', 'l', 'q', 'f', 'r', 'tab', 'esc', 'space']);

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
  harken: ['op', 'destination', 'timeoutMs'],
  'open-map': ['op'],
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
  if (op === 'harken') {
    if (raw.destination !== undefined && (typeof raw.destination !== 'string' || raw.destination.length === 0)) {
      return problem('missing-field', `${where}: destination`);
    }
    const timeoutMs = raw.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)) {
      return problem('bad-timeout', `${where}: timeoutMs`);
    }
    const step: TaskStep = { op };
    const named = raw.destination === undefined ? step : { ...step, destination: raw.destination as string };
    return timeoutMs === undefined ? named : { ...named, timeoutMs: timeoutMs as number };
  }
  if (op === 'open-map') return { op };
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

/** A 1920×1080 client point: two integers inside the frame, the same rule a `tap` step's `at` uses. */
function parsePoint(raw: unknown, where: string): Point | Problem {
  if (!Array.isArray(raw) || raw.length !== 2) return problem('missing-field', where);
  const [x, y] = raw;
  if (!Number.isInteger(x) || !Number.isInteger(y)
    || (x as number) < 0 || (x as number) > MAX_COORDINATE
    || (y as number) < 0 || (y as number) > MAX_COORDINATE) {
    return problem('bad-coordinate', where);
  }
  return { x: x as number, y: y as number };
}

/**
 * The cycle's rest (operator rule 2026-11-06). `rest.at` is the town's inn control and
 * `rest.timeoutMs` the bound on the whole visit; both are required, because a rest with a
 * guessed bound is a cycle that can end unrested without saying so.
 */
function parseRest(raw: unknown): TaskRest | Problem {
  if (!isObject(raw)) return problem('missing-field', 'rest');
  for (const field of Object.keys(raw)) {
    if (field !== 'at' && field !== 'timeoutMs') return problem('unknown-field', `rest: ${field}`);
  }
  const at = parsePoint(raw.at, 'rest.at');
  if (!('x' in at)) return at;
  if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1) {
    return problem('bad-timeout', 'rest: timeoutMs');
  }
  return { at, timeoutMs: raw.timeoutMs as number };
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

/** The fields a `goal` may carry; anything else in the object is an unknown field. */
const GOAL_FIELDS: readonly string[] = ['site', 'zone', 'climb'];
/** The fields a `climb` may carry. */
const CLIMB_FIELDS: readonly string[] = ['from', 'script', 'destination'];
/** The fields a `leave` may carry. */
const LEAVE_FIELDS: readonly string[] = ['to'];

/** A catalog id, checked only when the caller has a catalog to check against. */
function parseLocationId(raw: unknown, field: string, knownLocations?: ReadonlySet<string>): string | Problem {
  if (typeof raw !== 'string' || raw.length === 0) return problem('missing-field', field);
  if (knownLocations !== undefined && !knownLocations.has(raw)) return problem('unknown-location', `${field}: ${raw}`);
  return raw;
}

/**
 * The goal form (contracts §10): where the farm is, not how to drive there.
 *
 * The ids are validated against the same catalog a `travel` step is, so a typo refuses the session
 * at load instead of failing an orientation mid-run. The climb script is parsed by the same rules as
 * every other script — a step that the runner could not execute is refused here.
 */
function parseGoal(raw: unknown, knownLocations?: ReadonlySet<string>): TaskGoal | Problem {
  if (!isObject(raw)) return problem('missing-field', 'goal');
  for (const field of Object.keys(raw)) {
    if (!GOAL_FIELDS.includes(field)) return problem('unknown-field', `goal: ${field}`);
  }
  const site = parseLocationId(raw.site, 'goal.site', knownLocations);
  if (typeof site !== 'string') return site;
  const goal: { site: string; zone?: string; climb?: TaskClimb } = { site };
  if (raw.zone !== undefined) {
    const zone = parseLocationId(raw.zone, 'goal.zone', knownLocations);
    if (typeof zone !== 'string') return zone;
    goal.zone = zone;
  }
  if (raw.climb !== undefined) {
    const climb = parseClimb(raw.climb);
    if ('ok' in climb) return climb;
    goal.climb = climb;
  }
  return goal;
}

function parseClimb(raw: unknown): TaskClimb | Problem {
  if (!isObject(raw)) return problem('missing-field', 'goal.climb');
  for (const field of Object.keys(raw)) {
    if (!CLIMB_FIELDS.includes(field)) return problem('unknown-field', `goal.climb: ${field}`);
  }
  if (typeof raw.from !== 'string' || !TITLE_KEY.test(raw.from)) return problem('bad-title-key', 'goal.climb.from');
  const script = parseScript(raw.script, 'goal.climb.script');
  if (!('steps' in script)) return script;
  // The harken row's label, when the climb names one: the menu's own text (第一区-城外- etc.). The
  // World taps it only when the menu offers it — the list is not fixed (operator rule 2026-11-03).
  if (raw.destination !== undefined && (typeof raw.destination !== 'string' || raw.destination.length === 0)) {
    return problem('missing-field', 'goal.climb.destination');
  }
  return raw.destination === undefined
    ? { from: raw.from, script }
    : { from: raw.from, script, destination: raw.destination };
}

/**
 * The leave goal (contracts §10): where the cycle returns to. The destination is a catalogue id, so a
 * typo refuses the session at load instead of failing a leave at the Dungeon Select list.
 */
function parseLeave(raw: unknown, knownLocations?: ReadonlySet<string>): TaskLeave | Problem {
  if (!isObject(raw)) return problem('missing-field', 'leave');
  for (const field of Object.keys(raw)) {
    if (!LEAVE_FIELDS.includes(field)) return problem('unknown-field', `leave: ${field}`);
  }
  const to = parseLocationId(raw.to, 'leave.to', knownLocations);
  return typeof to === 'string' ? { to } : to;
}

/**
 * Parse and validate one task file. `text` is the file as written; JSON syntax is checked here so
 * a caller never has to catch.
 *
 * A task carries **either** an `entry` script **or** a `goal`: a scripted entry drives itself from
 * a screen it assumes, and a goal lets the World orient from any screen. Both at once would be two
 * answers to one question, so it is refused rather than silently preferring one.
 *
 * The exit is the same choice one level down: a measured `exit` script, or a `leave` goal the loop
 * judges from each frame. `leave` belongs to the goal form — a scripted task keeps its script.
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
    if (!['id', 'label', 'floor', 'entry', 'exit', 'goal', 'leave', 'rest'].includes(field)) return problem('unknown-field', field);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) return problem('missing-field', 'id');
  if (typeof raw.label !== 'string' || raw.label.length === 0) return problem('missing-field', 'label');

  if (!isObject(raw.floor)) return problem('missing-field', 'floor');
  if (typeof raw.floor.titleKey !== 'string' || !TITLE_KEY.test(raw.floor.titleKey)) {
    return problem('bad-title-key', 'floor.titleKey');
  }

  if (raw.entry !== undefined && raw.goal !== undefined) return problem('exclusive-field', 'entry and goal');
  if (raw.entry === undefined && raw.goal === undefined) return problem('missing-field', 'entry or goal');

  const entry = raw.entry === undefined ? undefined : parseScript(raw.entry, 'entry', knownLocations);
  if (entry !== undefined && !('steps' in entry)) return entry;
  const exit = raw.exit === undefined ? undefined : parseScript(raw.exit, 'exit', knownLocations);
  if (exit !== undefined && !('steps' in exit)) return exit;
  const goal = raw.goal === undefined ? undefined : parseGoal(raw.goal, knownLocations);
  if (goal !== undefined && 'ok' in goal) return goal;
  // Two answers to one question, refused in the same spirit as entry-vs-goal: a measured script and
  // a frame-judged goal would disagree the moment the party is somewhere the script did not assume.
  if (raw.exit !== undefined && raw.leave !== undefined) return problem('exclusive-field', 'exit and leave');
  if (raw.leave !== undefined && raw.goal === undefined) return problem('missing-field', 'leave needs goal');
  const leave = raw.leave === undefined ? undefined : parseLeave(raw.leave, knownLocations);
  if (leave !== undefined && !('to' in leave)) return leave;
  const rest = raw.rest === undefined ? undefined : parseRest(raw.rest);
  if (rest !== undefined && 'ok' in rest) return rest;

  const task: TaskDefinition = {
    id: raw.id,
    label: raw.label,
    floor: { titleKey: raw.floor.titleKey },
    ...(entry === undefined ? {} : { entry: entry as TaskScript }),
    ...(exit === undefined ? {} : { exit }),
    ...(goal === undefined || 'ok' in goal ? {} : { goal }),
    ...(leave === undefined || !('to' in leave) ? {} : { leave }),
    ...(rest === undefined || 'ok' in rest ? {} : { rest }),
  };
  return { ok: true, task };
}