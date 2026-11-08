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
 *   zoom <in|out> [times]      zoom the open world map, one step per press
 *   entry [task.json]          run a task file's entry script (default tasks/ffxi-4f.json)
 *
 * The screen names, the live coordinates and the task-file rules are in
 * `docs/guides/2026-10-24-live-control-guide.md` and the wvd-live-control skill.
 */
import { readFile, writeFile } from 'node:fs/promises';
import type { Actuator, Frame, Observation, Point } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { captureJpeg, focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';
import { createChannel, layoutChannel } from '../src/engine/vision/frame-channel.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { ACTING_CONFIDENCE_FLOOR, createScreenReaders } from '../src/perception/reader-set.ts';
import { FFXI_GCN } from '../src/perception/sites/ffxi-gcn.ts';
import { TRAVEL_IDS, LOCATIONS } from '../src/perception/locations.ts';
import { readMapDetailed } from '../src/perception/map.ts';
import { travelTo, travelViaAtlas, zoomWorldMap, type WorldMapEnv } from '../src/actions/worldmap.ts';
import { createTaskRunner } from '../src/tasks/runner.ts';
import { parseTask } from '../src/tasks/schema.ts';

const TITLE = 'WizardryVariantsDaphne';
const HOLD_MS = 60;
const DEFAULT_TASK = new URL('../tasks/ffxi-4f.json', import.meta.url);

const KEYS: Readonly<Record<string, number>> = {
  g: 0x22, l: 0x26, q: 0x10, f: 0x21, r: 0x13, e: 0x12, tab: 0x0f, esc: 0x01, space: 0x39,
  // WASD: the walk keys (contracts §4's "WASD escape"). A tap is one step's worth of hold only if
  // it is held — `key w 250` exists for that; the default 60 ms barely nudges the party.
  w: 0x11, a: 0x1e, s: 0x1f, d: 0x20,
};

const out = (value: unknown): void => { console.log(JSON.stringify(value)); };
const log = (line: string): void => { console.error(line); };
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The app's own chain, exactly (perception/reader-set.ts, 2026-11-08): the CLI used to keep a shorter
 * copy — sixteen readers against the app's eighteen, no site descriptor, no inn rest scene — so a stall
 * the CLI could not reproduce was diagnosed against a chain the loop does not run. The site descriptor
 * goes in too: the map's numbers are then the ones production uses.
 */
function perceiver(): CompositePerceiver {
  return createScreenReaders({ site: FFXI_GCN, floor: ACTING_CONFIDENCE_FLOOR }).composite;
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
      origin: observation.map.origin,
      icons: observation.map.icons.map((icon) => ({ kind: icon.kind, at: icon.at })),
    };
  }
  return base;
}

function help(): void {
  out({
    ok: true,
    usage: 'node scripts/live.mjs <status|observe|shot|focus|tap|key|drag|travel|zoom|entry>',
    commands: {
      status: 'focus + the current screen (read-only)',
      observe: 'alias for status',
      shot: 'shot [--out path] [--width n] — save a window JPEG',
      focus: 'bring the game to the foreground',
      tap: 'tap x y — one click at a 1920x1080 client pixel',
      key: 'key <g|l|q|f|r|e|tab|esc|space>',
      drag: 'drag x1 y1 x2 y2 [ms] — the world-map pan',
      travel: 'travel <id> — open the world map and click a catalogued node',
      zoom: 'zoom <in|out> [times] — zoom the open world map, one step per press',
      atlas: 'atlas <id> — travel by the stored atlas only (no template fallback), trace included',
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

/**
 * The frame channel the engine publishes into: the vision module's contract, created here exactly as
 * main.ts does for the World. One region per process; the child opens the same name.
 */
const channelLayout = layoutChannel({ width: 1920, height: 1080, slots: 2 });
const channelName = `wvd-live-${process.pid}-${Date.now()}`;
const mapping = openMapping(channelName, channelLayout.bytes);
const channel = createChannel(mapping.memory, channelLayout);
const child = startEngine({
  title: TITLE,
  channel: { name: channelName, bytes: channelLayout.bytes },
});
const client = connectEngine(child, { timeoutMs: 8_000 });
try {
  const source = new Win32Capture(client, channel);
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

  /** The world-map action's view of the machine: one helper, so travel and zoom cannot drift. */
  const mapEnv = (): WorldMapEnv => ({
    actuator,
    capture: () => source.capture(),
    observe: (frame) => see.observe(frame),
    sleep: wait,
    log,
    atlas: true,
    pointer: false,
  });

  switch (command) {
    case 'status':
    case 'observe': {
      const frame = await source.capture();
      const classification = await see.classify(frame);
      // The map parser's own answer, gate included: the screen is not the map and this says which
      // measured gate refused it, without a bisected copy of the module (task t-mvmuxnkc-jveshn).
      const mapParse = await readMapDetailed(frame);
      out({
        ok: true,
        foreground: await foreground(client),
        ...describe(classification.answer),
        mapGate: mapParse.ok ? null : mapParse.gate,
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
      const shot = await captureJpeg(source, channel, width);
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
      const hold = args[1] === undefined ? HOLD_MS : Number(args[1]);
      if (!Number.isFinite(hold) || hold < 1) throw new Error('key hold must be a positive number of ms');
      out({ ...(await actuator.holdKey(scan, hold)), command, key: name, holdMs: hold });
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
      const result = await travelTo(id, mapEnv());
      out({ ...result, command: 'travel', to: id });
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'atlas': {
      const id = args[0];
      if (id === undefined) throw new Error('atlas needs a catalogued site id');
      if (!(await take())) break;
      const result = await travelViaAtlas({ kind: 'site', id }, mapEnv(), { trace: true });
      out({ ...result, command: 'atlas', to: id });
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'zoom': {
      const direction = (args[0] ?? '').toLowerCase();
      if (direction !== 'in' && direction !== 'out') throw new Error('zoom needs in or out');
      const times = args[1] === undefined ? 1 : Number(args[1]);
      if (!Number.isInteger(times) || times < 1 || times > 10) throw new Error('zoom times must be an integer 1-10');
      if (!(await take())) break;
      // Q and E are the map's zoom keys and nothing else's: refuse to press them on another screen.
      const before = await see.observe(await source.capture());
      if (before.screen !== 'worldmap') {
        out({ ok: false, error: 'not-worldmap', screen: before.screen, confidence: Number(before.confidence.toFixed(3)) });
        process.exitCode = 1;
        break;
      }
      let zoomed = 0;
      for (; zoomed < times; zoomed += 1) {
        const result = await zoomWorldMap(direction, mapEnv());
        if (!result.ok) {
          out({ ...result, command: 'zoom', direction, step: zoomed });
          process.exitCode = 1;
          break;
        }
      }
      if (zoomed === times) out({ ok: true, command: 'zoom', direction, times });
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
