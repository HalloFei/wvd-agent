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
import {
  MAX_PRESS_HOLD_MS,
  type ActionResult,
  type Actuator,
  type EngineEvent,
  type Point,
} from './contracts.ts';
import { automoveToChest, automoveToExit, openMap } from './actions/automove.ts';
import type { WvdConfigSection } from './config.ts';
import { connectEngine, startEngine, type EngineClient } from './engine/child.ts';
import { captureJpeg, sendInput, Win32Capture } from './engine/win32.ts';
import { ChestPerceiver } from './perception/chest.ts';
import { CompositePerceiver } from './perception/composite.ts';
import { HudPerceiver } from './perception/hud.ts';
import { MapPerceiver } from './perception/map.ts';
import { routePolicy } from './policy/route.ts';
import { classify } from './policy/session.ts';
import { WvdWorld, type WvdSession } from './world.ts';

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
  };

  /**
   * Cheapest decisive gate first (ChestB band, then the map readout, then the wider HUD scan).
   * Each recogniser keeps its own floor; they happen to agree on the route's act floor.
   */
  const perceiver = new CompositePerceiver([
    { perceiver: new ChestPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new MapPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
    { perceiver: new HudPerceiver(), floor: ACTING_CONFIDENCE_FLOOR },
  ]);

  const openSession = async (): Promise<WvdSession | null> => {
    // Spawning here is the session's first act: `create()` stays idle.
    const client = connect();
    return {
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
  };

  world = new WvdWorld({
    cfg,
    timezone,
    policy: routePolicy,
    classify,
    commands: {
      // `pressHoldMs` is read per command, like every other key this World owns (§0.3).
      openMap: () => openMap(actuator, pressHoldMs()),
      automoveToChest: () => automoveToChest(actuator, pressHoldMs()),
      automoveToExit: () => automoveToExit(actuator, pressHoldMs()),
    },
    openSession,
  });
  return world;
}
