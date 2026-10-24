#!/usr/bin/env tsx
/**
 * The live control CLI for Wizardry Variants Daphne: one command per action, one JSON line out.
 *
 * The wrapper is `scripts/live.mjs` (it finds tsx in this checkout or in the sibling Coopanion);
 * this file is the typed entry the wrapper runs. Input commands take the foreground first, the way
 * the World does at session start: a lone Alt tap + `SetForegroundWindow`, the technique Coopanion's
 * computer use uses. The engine refuses every press unless the game is foreground, so a rejected
 * press is reported, never retried blindly.
 *
 * Commands:
 *   status | observe            focus state + the current screen (read-only)
 *   shot [--out path] [--width n]  save a JPEG of the window (read-only)
 *   focus                      bring the game to the foreground
 *   tap x y                    one click at a 1920x1080 client pixel
 *   key <g|l|q|f|r|e|tab|esc|space>  one key press
 *   drag x1 y1 x2 y2 [ms]      press, move, release (the world-map pan)
 *   travel <catalog id>        open the world map and click a destination (vnh, ffxi-gcn, ...)
 *   entry [task.json]          run a task file's entry script (default tasks/ffxi-4f.json)
 *
 * The screen names, the live coordinates and the task-file rules are in
 * `docs/guides/2026-10-24-live-control-guide.md` and the wvd-live-control skill.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Actuator, Frame, Observation, Point } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { TRAVEL_IDS, LOCATIONS } from '../src/perception/locations.ts';
import { MapPerceiver } from '../src/perception/map.ts';
import { travelTo } from '../src/actions/worldmap.ts';
import { createTaskRunner } from '../src/tasks/runner.ts';
import { parseTask } from '../src/tasks/schema.ts';

const TITLE = 'WizardryVariantsDaphne';
const HOLD_MS = 60;
const DEFAULT_TASK = new URL('../tasks/ffxi-4f.json', import.meta.url);

const KEYS: Readonly<Record<string, number>> = {
  g: 0x22, l: 0x26, q: 0x10, f: 0x21, r: 0x13, e: 0x12, tab: 0x0f, esc: 0x01, space: 0x39,
};

const out = (value: unknown): void => { console.log(JSON.stringify(value)); };
const log = (line: string): void => { console.error(line); };
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function perceiver(): CompositePerceiver {
  return new CompositePerceiver([
    { perceiver: new ChestPerceiver(), floor: 0.5 },
    { perceiver: new MapPerceiver(), floor: 0.5 },
    { perceiver: new ChestPromptPerceiver(), floor: 0.5 },
    { perceiver: new CombatPerceiver(), floor: 0.5 },
    { perceiver: new HudPerceiver(), floor: 0.5 },
    { perceiver: new WorldMapPerceiver(), floor: 0.5 },
    { perceiver: new TownPerceiver(), floor: 0.5 },
  ]);
}

type Client = ReturnType<typeof connectEngine>;

function actuatorFor(client: Client): Actuator {
  return {
    tap: (at: Point) => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 1 }),
    doubleTap: (at: Point) => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 2 }),
    holdKey: (scan: number, holdMs: number) => sendInput(client, { op: 'key', scan, holdMs }),
    drag: (from: Point, to: Point, durationMs: number) =>
      sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs }),
  };
}

async function foreground(client: Client): Promise<boolean> {
  const reply = await client.request({ op: 'foreground' });
  return reply.ok && (reply.value as { foreground?: boolean } | null)?.foreground === true;
}

function describe(observation: Observation): Record<string, unknown> {
  const base: Record<string, unknown> = {
    screen: observation.screen,
    confidence: Number(observation.confidence.toFixed(3)),
  };
  if (observation.screen === 'dungeonmap') {
    base.map = {
      floorTitle: observation.map.floorTitle,
      titleKey: observation.map.titleKey,
      player: observation.map.player,
      icons: observation.map.icons.length,
    };
  }
  return base;
}

function help(): void {
  out({
    ok: true,
    usage: 'node scripts/live.mjs <status|observe|shot|focus|tap|key|drag|travel|entry>',
    commands: {
      status: 'focus + the current screen (read-only)',
      observe: 'alias for status',
      shot: 'shot [--out path] [--width n] — save a window JPEG',
      focus: 'bring the game to the foreground',
      tap: 'tap x y — one click at a 1920x1080 client pixel',
      key: 'key <g|l|q|f|r|e|tab|esc|space>',
      drag: 'drag x1 y1 x2 y2 [ms] — the world-map pan',
      travel: 'travel <id> — open the world map and click a catalogued node',
      entry: 'entry [task.json] — run a task file\'s entry script',
    },
    destinations: [...TRAVEL_IDS],
    controls: {
      'world-map icon': { x: 1177, y: 1012 },
      'minimap (open dungeon map)': { x: 1787, y: 96 },
      'dungeon-select row': 'travel ffxi-zone1 | ffxi-zone2 | ffxi-zone3 — the row is matched by its label',
    },
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  help();
  process.exit(0);
}
if (!LOCATIONS.has('ffxi-gcn')) {
  // a guard for a broken template table, not a runtime path
  out({ ok: false, error: 'location catalog is empty' });
  process.exit(1);
}

const child = startEngine({ title: TITLE, jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
try {
  const source = new Win32Capture(client, {});
  const see = perceiver();
  const actuator = actuatorFor(client);
  const observe = async (): Promise<{ frame: Frame; observation: Observation }> => {
    const frame = await source.capture();
    return { frame, observation: await see.observe(frame) };
  };
  const take = async (): Promise<boolean> => {
    const focused = await focusGame(client);
    if (!focused) {
      out({ ok: false, error: 'focus-refused', detail: 'the game window did not come to the foreground' });
      process.exitCode = 1;
    }
    return focused;
  };

  switch (command) {
    case 'status':
    case 'observe': {
      const classification = await see.classify(await source.capture());
      out({
        ok: true,
        foreground: await foreground(client),
        ...describe(classification.answer),
        // Every screen the frame speaks about: what it supports, and what it rules out.
        standings: classification.standings
          .filter((standing) => standing.support > 0 || standing.ruledOut)
          .map((standing) => ({
            screen: standing.screen,
            support: standing.support,
            ruledOut: standing.ruledOut,
          })),
      });
      break;
    }
    case 'focus': {
      const focused = await focusGame(client);
      out({ ok: focused, foreground: await foreground(client) });
      if (!focused) process.exitCode = 1;
      break;
    }
    case 'shot': {
      const at = args.indexOf('--out');
      const widthAt = args.indexOf('--width');
      const path = at >= 0 ? args[at + 1] : '.tmp/wvd-shot.jpg';
      const width = widthAt >= 0 ? Number(args[widthAt + 1]) : undefined;
      if (!path) throw new Error('shot --out needs a path');
      if (width !== undefined && (!Number.isFinite(width) || width < 64)) throw new Error('shot --width is not a number');
      const shot = await captureJpeg(client, width);
      await writeFile(path, shot.bytes);
      out({ ok: true, path, width: shot.width, height: shot.height });
      break;
    }
    case 'tap': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('tap needs x y');
      if (!(await take())) break;
      out({ ...(await actuator.tap({ x, y })), command, at: { x, y } });
      break;
    }
    case 'key': {
      const name = (args[0] ?? '').toLowerCase();
      const scan = KEYS[name];
      if (scan === undefined) throw new Error(`key must be one of ${Object.keys(KEYS).join(', ')}`);
      if (!(await take())) break;
      out({ ...(await actuator.holdKey(scan, HOLD_MS)), command, key: name });
      break;
    }
    case 'drag': {
      const [x1, y1, x2, y2] = args.slice(0, 4).map(Number);
      const ms = args[4] === undefined ? 300 : Number(args[4]);
      if (![x1, y1, x2, y2, ms].every((value) => Number.isFinite(value))) throw new Error('drag needs x1 y1 x2 y2 [ms]');
      if (!(await take())) break;
      out({ ...(await actuator.drag({ x: x1!, y: y1! }, { x: x2!, y: y2! }, ms)), command });
      break;
    }
    case 'travel': {
      const id = args[0];
      if (id === undefined) throw new Error(`travel needs one of ${[...TRAVEL_IDS].join(', ')}`);
      if (!(await take())) break;
      const result = await travelTo(id, {
        actuator,
        capture: () => source.capture(),
        observe: (frame) => see.observe(frame),
        sleep: wait,
        log,
      });
      out({ ...result, command: 'travel', to: id });
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'entry': {
      const path = args[0];
      const text = await readFile(path === undefined ? DEFAULT_TASK : path, 'utf8');
      const parsed = parseTask(text, TRAVEL_IDS);
      if (!parsed.ok) {
        out({ ok: false, error: 'task-file-invalid', reason: parsed.reason, detail: parsed.detail });
        process.exitCode = 1;
        break;
      }
      if (!(await take())) break;
      const runner = createTaskRunner({ task: parsed.task, source, perceiver: see, actuator, log });
      const started = Date.now();
      const result = await runner.enter();
      out({ ...result, command: 'entry', task: parsed.task.id, ms: Date.now() - started });
      if (!result.ok) process.exitCode = 1;
      break;
    }
    default:
      out({ ok: false, error: `unknown command: ${command}` });
      process.exitCode = 2;
  }
} catch (error) {
  out({ ok: false, error: message(error) });
  process.exitCode = 1;
} finally {
  client.close();
}
