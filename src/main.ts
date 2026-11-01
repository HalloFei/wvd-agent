/**
 * The composition root (plan Task 10): config → modules, and nothing else.
 *
 * No decision lives here. It names which realization of each contract this deployment uses —
 * `Win32Capture` for frames, one composite perceiver for screens, the engine child for input, the
 * route policy and the session classifier for decisions — and hands them to `WvdWorld`.
 *
 * Two things it deliberately does *not* do:
 *
 * - **It touches no engine at construction.** `create()` runs when the World is mounted, and a
 *   mounted World must be idle and hands-off; the child is spawned on the first session instead.
 * - **It connects no host.** The host arrives at `start(host)`; the engine's unsolicited messages
 *   reach the loop because the session's `onEngineEvent` forwards them.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PRESS_HOLD_MS,
  type ActionResult,
  type Actuator,
  type EngineEvent,
  type Point,
} from './contracts.ts';
import { automoveToExit, automoveToTile, openMap } from './actions/automove.ts';
import { acceptChestPrompt, cancelQte, dismissLoot, enableBattleAuto, reenterChest, tapLoot } from './actions/chest.ts';
import { timeQte } from './actions/qte.ts';
import type { TaskDefinition } from './contracts.ts';
import type { WvdConfigSection } from './config.ts';
import { connectEngine, startEngine, type EngineClient } from './engine/child.ts';
import { captureJpeg, focusGame, sendInput, Win32Capture } from './engine/win32.ts';
import { ChestPerceiver } from './perception/chest.ts';
import { CombatPerceiver } from './perception/combat.ts';
import { ChestPromptPerceiver } from './perception/prompt.ts';
import { ChestOpeningPerceiver } from './perception/chest-opening.ts';
import { LootPerceiver } from './perception/loot.ts';
import { CompositePerceiver } from './perception/composite.ts';
import { HudPerceiver } from './perception/hud.ts';
import { TownPerceiver, WorldMapPerceiver } from './perception/location.ts';
import { DungeonSelectPerceiver } from './perception/dungeon-select.ts';
import { TRAVEL_IDS } from './perception/locations.ts';
import { MapPerceiver } from './perception/map.ts';
import { routePolicy } from './policy/route.ts';
import { createTaskPolicy } from './tasks/policy.ts';
import { createTaskRunner } from './tasks/runner.ts';
import { parseTask } from './tasks/schema.ts';
import { classify } from './policy/session.ts';
import { WvdWorld, type SessionOpen, type WvdSession } from './world.ts';

/**
 * The route's acting floor (contracts §6): a screen below it is not identified well enough to act
 * on, so it is also the floor at which a recogniser's answer is trusted for the loop.
 */
const ACTING_CONFIDENCE_FLOOR = 0.5;

export interface WvdComposition {
  /** The live `worlds.wvd` section. Keys are read per decision; nothing is copied into a module. */
  cfg: WvdConfigSection;
  timezone: string;
}

/** Builds the World this deployment runs. Touches no engine until a session starts. */
export function createWvdWorld(composition: WvdComposition): WvdWorld {
  const { cfg, timezone } = composition;
  let world: WvdWorld | null = null;
  let engine: EngineClient | null = null;
  // The task the running session farms with; the decorator reads it per tick, so a session that
  // loaded no file behaves exactly like the v1 route.
  let task: TaskDefinition | null = null;

  /** The package root: `tasks/` sits beside `src/`, and a relative `taskFile` resolves from here. */
  const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

  /** The child, spawned on first use and re-spawned if a session closed it. */
  const connect = (): EngineClient => {
    engine ??= connectEngine(
      startEngine({ title: cfg.gameWindowTitle, hotkey: cfg.stopHotkey, jpegQuality: cfg.jpegQuality }),
      { timeoutMs: cfg.engineTimeoutMs },
    );
    return engine;
  };

  /**
   * The configured press, clamped to the ceiling the engine's teardown can still release
   * (contracts §4/§5): `pressHoldMs` is the operator's, and a hand-edited config must not be able
   * to ask for a hold longer than the child's grace.
   */
  const pressHoldMs = (): number => Math.min(MAX_PRESS_HOLD_MS, Math.max(1, cfg.pressHoldMs));

  /** `Actuator` over the engine: the child asserts foreground before every press (contracts §4). */
  const actuator: Actuator = {
    tap: (at: Point): Promise<ActionResult> => sendInput(connect(), { op: 'tap', x: at.x, y: at.y, count: 1 }),
    doubleTap: (at: Point): Promise<ActionResult> => sendInput(connect(), { op: 'tap', x: at.x, y: at.y, count: 2 }),
    holdKey: (scan: number, holdMs: number): Promise<ActionResult> =>
      sendInput(connect(), { op: 'key', scan, holdMs }),
    drag: (from: Point, to: Point, durationMs: number): Promise<ActionResult> =>
      sendInput(connect(), { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs }),
  };

  /**
   * Cheapest decisive gate first (ChestB band, then the map readout, then the wider HUD scan).
   * Each recogniser keeps its own floor; they happen to agree on the route's act floor.
   */
  const perceiver = new CompositePerceiver([
    { perceiver: new ChestPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new MapPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new ChestPromptPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    // The loot screen comes before the opening: the result banner (`获得了…` over the opened chest)
    // also clears the opening's gates — live 2026-11-01 it was named `chest-opening` 0.60 and the
    // loop waited on it — while the loot recogniser's caption + AUTO test separates the two.
    { perceiver: new LootPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    // The opening is named after the prompt: both draw no HUD, and only the prompt's own recogniser
    // can tell the 打开 menu from the lid lifting.
    { perceiver: new ChestOpeningPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new CombatPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new HudPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    // The HUD refuses both of these at 0.2; they run last so a dungeon frame never pays for them.
    { perceiver: new WorldMapPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new TownPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    // The DLL-style list between the world map and the dungeon; named last because only its own
    // row recogniser speaks and a normal frame must not pay for it.
    { perceiver: new DungeonSelectPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
  ]);

  const openSession = async (): Promise<SessionOpen> => {
    // The task file is read per session, so an edited file is picked up by the next start; a bad
    // one refuses the start with its reason rather than running a session nobody can predict.
    const file = cfg.taskFile.trim();
    let loaded = null as TaskDefinition | null;
    if (file !== '') {
      const path = isAbsolute(file) ? file : resolve(PACKAGE_ROOT, file);
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        return { ok: false, reason: 'task-file-invalid', detail: `cannot read ${path}` };
      }
      const parsed = parseTask(text, TRAVEL_IDS);
      if (parsed.ok === false) {
        return { ok: false, reason: 'task-file-invalid', detail: `${path}: ${parsed.reason}${parsed.detail ? ` (${parsed.detail})` : ''}` };
      }
      loaded = parsed.task;
    }
    task = loaded;
    // Spawning here is the session's first act: `create()` stays idle.
    const client = connect();
    // The World takes the foreground when the session starts; the console line is the announcement.
    const focused = await focusGame(client);
    world?.note(focused
      ? 'wvd: the game is foreground'
      : 'wvd: the game did not come to the foreground; each press will ask again before giving up');
    const session: WvdSession = {
      source: new Win32Capture(client, {
        // A degraded decode is the child's report reaching the loop, not a silent slowdown (R23).
        onProblem: (event) => {
          void world?.onEngineEvent(event);
        },
      }),
      perceiver,
      actuator,
      // The escalation's second capture: the child's own JPEG, downscaled on request (contracts §5).
      // A failure is null, not a throw: the question still goes out without an image.
      snapshot: {
        captureJpeg: async (maxWidth?: number) => {
          try {
            return await captureJpeg(client, maxWidth);
          } catch {
            return null;
          }
        },
      },
      onEngineEvent: (listener: (event: EngineEvent) => void) => client.onEvent(listener),
      close: () => {
        engine?.close();
        engine = null;
      },
    };
    const taskRunner = loaded === null ? undefined : createTaskRunner({
      task: loaded,
      source: session.source,
      perceiver: session.perceiver,
      actuator: session.actuator,
      log: (line) => world?.note(line),
    });
    return taskRunner === undefined ? { ok: true, session } : { ok: true, session, task: taskRunner };
  };

  world = new WvdWorld({
    cfg,
    timezone,
    policy: createTaskPolicy(() => task, routePolicy),
    classify,
    // The QTE sub-loop is a dependency like the policy: `timeQte` is the production timing.
    timing: timeQte,
    commands: {
      // `pressHoldMs` is read per command, like every other key this World owns (§0.3).
      openMap: () => openMap(actuator, pressHoldMs()),
      automoveToTile: (at) => automoveToTile(actuator, at, pressHoldMs()),
      automoveToExit: () => automoveToExit(actuator, pressHoldMs()),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      tapLoot: () => tapLoot(actuator),
      dismissLoot: () => dismissLoot(actuator),
      enableBattleAuto: () => enableBattleAuto(actuator),
      // The attempt-vs-reroll policy's action: leave the QTE (free, chest §4) and re-click a card.
      cancelQte: () => cancelQte(actuator),
      reenterChest: () => reenterChest(actuator, cfg.hazardEscapeHoldMs),
    },
    openSession,
  });
  return world;
}
