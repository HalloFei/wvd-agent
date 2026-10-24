/**
 * The loop and the composition root (plan Task 10), driven entirely by fakes: no engine, no window,
 * no game, no network. A fake source, a fake perceiver and a fake actuator are all the loop is
 * allowed to know; a fake host is all the escalation transport is allowed to know.
 *
 * What is asserted here is the loop's contract, not a module's:
 *
 * - one tick is capture → observe → classify → policy → act, exactly once each;
 * - a tick that overruns is skipped, never queued;
 * - a stall becomes an escalation and, past `stallStopSeconds`, a stop;
 * - the escalation is one `pushEvent` with `trigger:'flush'`, `tags:['snapshot']` and one JPEG
 *   `BlobInput`, and it ends in the answer, the timeout or a cancel — never in a second question;
 * - the three tools answer with prose receipts and refuse what they must.
 */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, LogLevel, Logger, ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import type {
  ActionResult,
  Actuator,
  EngineEvent,
  Frame,
  FrameSource,
  MapState,
  Observation,
  Perceiver,
  Point,
} from '../src/contracts.ts';
import { automoveToExit, automoveToTile, openMap } from '../src/actions/automove.ts';
import { acceptChestPrompt, DISARM_SCAN, enableBattleAuto } from '../src/actions/chest.ts';
import { timeQte, type QteTimer, type QteTimingOptions } from '../src/actions/qte.ts';
import { WVD_DEFAULTS, type WvdConfigSection } from '../src/config.ts';
import { MAX_PRESS_HOLD_MS } from '../src/contracts.ts';
import { routePolicy } from '../src/policy/route.ts';
import { tileOnScreen } from '../src/perception/map.ts';
import { classify } from '../src/policy/session.ts';
import { WvdWorld, type WvdSession } from '../src/world.ts';

const CTX = {} as ToolCallContext;
/** The Windows set-1 codes the World's receipts report; the commands' own are in `actions/`. */
const SCAN = { W: 0x11, R: 0x13, F: 0x21, G: 0x22 };

// ---------------------------------------------------------------------------------------------
// The fakes the brief asks for: a source, a perceiver and an actuator
// ---------------------------------------------------------------------------------------------

/**
 * A frame whose pixels the loop can compare: `seed` is the sampled scene. The 1x1 image is the
 * smallest thing `sceneSignature` can read, which is all the stillness rule needs (the real measure
 * is tested in `tests/stillness.test.ts`).
 */
function frame(atMs: number, seed = 0): Frame {
  return {
    atMs,
    width: 1920,
    height: 1080,
    toRgba: async () => ({ data: Uint8Array.of(seed, seed, seed, 255), width: 1, height: 1 }),
  };
}

class ScriptedSource implements FrameSource {
  captures = 0;
  /** Captures that will fail before a good one is served. */
  failures = 0;
  /** When set, `capture()` waits for it: the test decides when the tick may finish. */
  gate: Promise<void> | null = null;
  /** When true every capture is a different scene: the party is walking. */
  moving = false;
  private seed = 0;

  async capture(): Promise<Frame> {
    this.captures += 1;
    const gate = this.gate;
    if (gate) await gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('capture timeout: no-frame');
    }
    if (this.moving) this.seed = (this.seed + 40) % 256;
    return frame(this.captures * 100, this.seed);
  }
}

class ScriptedPerceiver implements Perceiver {
  observes = 0;
  constructor(public observation: Observation) {}
  async observe(): Promise<Observation> {
    this.observes += 1;
    return this.observation;
  }
}

class ScriptedActuator implements Actuator {
  readonly calls: string[] = [];
  result: ActionResult = { ok: true };

  async tap(at: Point): Promise<ActionResult> {
    this.calls.push(`tap ${at.x},${at.y}`);
    return this.result;
  }
  async doubleTap(at: Point): Promise<ActionResult> {
    this.calls.push(`doubleTap ${at.x},${at.y}`);
    return this.result;
  }
  async holdKey(scan: number, holdMs: number): Promise<ActionResult> {
    this.calls.push(`key ${scan} ${holdMs}`);
    return this.result;
  }
}

interface Pushed {
  readonly event: {
    type: string;
    text: string;
    tags?: readonly string[];
    meta?: Record<string, unknown>;
    blobs?: ReadonlyArray<{ bytes?: Uint8Array; mime?: string; fallbackText: string }>;
  };
  readonly opts?: { trigger?: string; deliver?: boolean };
  readonly cursor: number;
  readonly contextDelivery: 'deliver' | 'archive-only';
}

class FakeHost {
  readonly pushed: Pushed[] = [];
  /** Every line the loop wrote, with its level: a routine refusal must not read as a failure. */
  readonly logRecords: Array<{ level: LogLevel; message: string; data?: unknown }> = [];
  /** What the host stamps on every value: the loop's only synchronous delivery evidence. */
  delivery: 'deliver' | 'archive-only' = 'deliver';
  acceptsImage = true;
  acceptsThrows = false;
  failPush = false;
  private cursor = 0;

  get modelFacts() {
    const host = this;
    return {
      model: () => 'fake-model',
      accepts(mime: string): boolean {
        if (host.acceptsThrows) throw new Error('activeProvider names a missing endpoint');
        return host.acceptsImage && mime.startsWith('image/');
      },
      contextWindow: () => 0,
    };
  }

  get log(): Logger {
    const host = this;
    const record = (level: LogLevel) => (message: string, data?: unknown): void => {
      host.logRecords.push({ level, message, data });
    };
    const logger: Logger = {
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      emit: (level, message) => { host.logRecords.push({ level, message }); },
      child: () => logger,
    };
    return logger;
  }

  async pushEvent(event: Pushed['event'], opts?: Pushed['opts']): Promise<EventEnvelope> {
    if (this.failPush) throw new Error('World wvd: host lifecycle ended');
    this.cursor += 1;
    const envelope = {
      ...event,
      cursor: this.cursor,
      origin: 'external' as const,
      contextDelivery: this.delivery,
      blobs: (event.blobs ?? []).map((blob, index) => ({
        handle: `log:${index}.jpg`,
        mime: blob.mime ?? 'application/octet-stream',
        fallbackText: blob.fallbackText,
      })),
    } as unknown as EventEnvelope;
    this.pushed.push({ event, opts, cursor: this.cursor, contextDelivery: this.delivery });
    return envelope;
  }
}

/** The one clock, under the test's hand: `atMs` is whatever the test says it is. */
class TestClock {
  at = 1000;
  now = (): number => this.at;
  advance(ms: number): void {
    this.at += ms;
  }
}

// ---------------------------------------------------------------------------------------------
// The World under test
// ---------------------------------------------------------------------------------------------

const dungeonMap: Observation = {
  screen: 'dungeonmap',
  atMs: 100,
  confidence: 0.9,
  map: {
    floorTitle: 'B1F',
    titleKey: '0001c00003e6c00003efe00003874000',
    player: { x: 19, y: 21 },
    // The chevron. The fixtures put it at the screen's centre so a walk's tap point is arithmetic.
    origin: { x: 960, y: 540 },
    icons: [
      { kind: 'chest', at: { x: 14, y: 18 } },
      { kind: 'hazard', at: { x: 10, y: 10 } },
    ],
  },
};

/**
 * A map with no chest left on it: the route's next move is the exit (contracts §6). `hazard` is a
 * non-chest icon so the map is still a real readout.
 */
const emptyMap: Observation = {
  screen: 'dungeonmap',
  atMs: 100,
  confidence: 0.9,
  map: {
    floorTitle: 'B1F',
    titleKey: '0001c00003e6c00003efe00003874000',
    player: { x: 19, y: 21 },
    origin: { x: 960, y: 540 },
    icons: [{ kind: 'hazard', at: { x: 10, y: 10 } }],
  },
};

/** The map a `dungeonmap` observation carries; the fixtures below that are one say so. */
function mapOf(observation: Observation): MapState {
  if (observation.screen !== 'dungeonmap') throw new Error('the fixture is not a map observation');
  return observation.map;
}

/** The chest the route picks on the fixtures' map: the party on (19,21), a chest on (14,18). */
const CHEST: Point = { x: 14, y: 18 };

/** How far above the clicked tile the 自动移动 element is drawn (measured 79–84, §3c). */
const POPUP_RISE = 81;

/** The three calls a pointer-mode walk to `target` makes, as the fake actuator records them. */
function walkCalls(map: MapState, target: Point = CHEST, holdMs = 60): string[] {
  const at = tileOnScreen(map, target);
  return [`key ${SCAN.R} ${holdMs}`, `tap ${at.x},${at.y}`, `tap ${at.x},${at.y - POPUP_RISE}`];
}

/** A walk aimed from the fixture map's own readout. */
const walkOne = (holdMs = 60): string[] => walkCalls(mapOf(dungeonMap), CHEST, holdMs);

const unknownButSeen: Observation = { screen: 'unknown', atMs: 100, confidence: 0.2 };
const nothingSeen: Observation = { screen: 'unknown', atMs: 100, confidence: 0 };
const waiting: Observation = { screen: 'loading', atMs: 100, confidence: 0.9 };
const dungeonView: Observation = { screen: 'dungeon', atMs: 100, confidence: 0.9 };

/** A member the opener policy can rank; the card index is its position in the panel. */
function openerMember(detect: number, disarm: number, willpower = 100, feared = false) {
  return { name: '#', detect, disarm, willpower, feared };
}

/**
 * The opener panel with two members: index 1 has the higher 陷阱解除, so the choice is the second
 * card — centre (963, 784) from the measured card boxes (x 879–1046, y 729–839).
 */
const openerPanel: Observation = {
  screen: 'chest-open',
  atMs: 100,
  confidence: 1,
  opener: { members: [openerMember(10, 40), openerMember(10, 90)] },
};

/** A parsed panel where nobody may open the chest: both are under the 60 willpower floor. */
const openerNobody: Observation = {
  screen: 'chest-open',
  atMs: 100,
  confidence: 1,
  opener: { members: [openerMember(10, 40, 59), openerMember(10, 90, 30)] },
};

/**
 * The best card's heart did not parse (`NaN` = no heart drawn / unread): it is ineligible, and the
 * other member (59) is under the floor. Nobody may open the chest, and the reason must name it.
 */
const openerUnread: Observation = {
  screen: 'chest-open',
  atMs: 100,
  confidence: 1,
  opener: { members: [openerMember(10, 105, Number.NaN), openerMember(10, 40, 59)] },
};

/**
 * What `ChestPerceiver` emits when the panel's gates match but a digit cannot be read (`unknown`,
 * confidence 0.3): below the route's act floor, above a blank frame's 0.
 */
const refusedPanel: Observation = { screen: 'unknown', atMs: 100, confidence: 0.3 };

/**
 * A live bar, from the recording: two zones, the marker somewhere inside the first, and the 解除
 * button where the recording found it. Nothing here is pressed until the World hands the tick to
 * the timing sub-loop.
 */
const qteBar: Observation = {
  screen: 'chest-qte',
  atMs: 100,
  confidence: 1,
  qte: {
    zones: [{ from: 694, to: 922 }, { from: 997, to: 1223 }],
    markerX: 800,
    button: { x: 958, y: 662 },
    attempts: null,
  },
};

function makeWorld(options: {
  cfg?: Partial<WvdConfigSection>;
  observation?: Observation;
  source?: ScriptedSource;
  actuator?: ScriptedActuator;
  screenshot?: ((maxWidth?: number) => { bytes: Uint8Array; width: number; height: number } | null) | null;
  /** Held open to keep an escalation inside its snapshot capture while the test acts. */
  snapshotGate?: Promise<void>;
  /** Held open to keep two concurrent startSession calls overlapping. */
  openSessionGate?: Promise<void>;
  host?: FakeHost;
  /**
   * The QTE timing sub-loop. The real one unless a test scripts it: a bar on screen would then
   * sample this fake source (which has no bar) and refuse, never press — the honest default.
   */
  timing?: QteTimer;
} = {}) {
  const source = options.source ?? new ScriptedSource();
  const perceiver = new ScriptedPerceiver(options.observation ?? dungeonMap);
  const actuator = options.actuator ?? new ScriptedActuator();
  const snapshotCalls: Array<number | undefined> = [];
  const shot = options.screenshot === null ? null : options.screenshot;
  const session: WvdSession = {
    source,
    perceiver,
    actuator,
    snapshot: shot === null
      ? undefined
      : {
        captureJpeg: async (maxWidth?: number) => {
          snapshotCalls.push(maxWidth);
          if (options.snapshotGate) await options.snapshotGate;
          return shot
            ? shot(maxWidth)
            : { bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), width: 1280, height: 720 };
        },
      },
  };
  const cfg: WvdConfigSection = { ...structuredClone(WVD_DEFAULTS), enabled: false, tickMs: 50, ...options.cfg };
  const host = options.host ?? new FakeHost();
  const clock = new TestClock();
  let openSessionCalls = 0;
  const world = new WvdWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    policy: routePolicy,
    classify,
    timing: options.timing ?? timeQte,
    commands: {
      // `main.ts` reads `pressHoldMs` per command; the harness does the same, so a configured hold
      // that the loop ignored would show up here (Important 2).
      openMap: () => openMap(actuator, cfg.pressHoldMs),
      automoveToTile: (at) => automoveToTile(actuator, at, cfg.pressHoldMs),
      automoveToExit: () => automoveToExit(actuator, cfg.pressHoldMs),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      enableBattleAuto: () => enableBattleAuto(actuator),
    },
    openSession: async () => {
      openSessionCalls += 1;
      if (options.openSessionGate) await options.openSessionGate;
      return { ok: true, session };
    },
    autoTick: false,
    now: clock.now,
  });
  return {
    world, host, source, perceiver, actuator, cfg, snapshotCalls, clock,
    openSessionCalls: () => openSessionCalls,
  };
}

async function started(world: WvdWorld, host: FakeHost): Promise<WvdWorld> {
  await world.start(host as unknown as WorldHost);
  await world.startSession();
  return world;
}

function tool(world: WvdWorld, name: string) {
  return world.tools().find((candidate) => candidate.name === name)!;
}

async function until(condition: () => boolean, label: string, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const outcome = (value: string | ToolOutcome): ToolOutcome =>
  typeof value === 'string' ? { text: value } : value;

// ---------------------------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------------------------

describe('the tick', () => {
  it('captures once, observes once and issues the route policy\'s action', async () => {
    const { world, host, source, perceiver, actuator } = makeWorld();
    await started(world, host);

    await world.tick();

    expect(source.captures).toBe(1);
    expect(perceiver.observes).toBe(1);
    // dungeonmap with a chest and a budget → move → 移动至宝箱 (L)
    expect(actuator.calls).toEqual(walkOne());
    expect(host.pushed).toEqual([]);
  });

  it('sends one command and waits for the screen to answer it', async () => {
    const { world, host, actuator, perceiver, clock } = makeWorld();
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    // The route re-derives 'move' on the next tick; the loop must not press L again while the map
    // is still on screen. This is the defect the review found: a stateless policy is not a memory.
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    // automoveStillSeconds passes with the screen unchanged: the command gave up and is not re-sent.
    clock.advance(5000);
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    // The farm advanced — the party is somewhere else on the map — so a command may be sent again,
    // aimed from the new readout: the chevron has scrolled with the party.
    const moved = { ...dungeonMap, map: { ...mapOf(dungeonMap), player: { x: 12, y: 18 } } };
    perceiver.observation = moved;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([...walkOne(), ...walkCalls(mapOf(moved))]);
  });

  it('does not open a second engine for a second concurrent startSession', async () => {
    let release = (): void => {};
    const openSessionGate = new Promise<void>((resolve) => { release = resolve; });
    const { world, host, openSessionCalls } = makeWorld({ openSessionGate });
    await world.start(host as unknown as WorldHost);

    const first = world.startSession();
    expect(await world.startSession()).toBe(false);
    release();

    expect(await first).toBe(true);
    expect(openSessionCalls()).toBe(1);
  });

  it('skips a tick rather than queueing it', async () => {
    const source = new ScriptedSource();
    let release = (): void => {};
    source.gate = new Promise<void>((resolve) => { release = resolve; });
    const { world, host, perceiver } = makeWorld({ source });
    await started(world, host);

    const first = world.tick();
    const second = world.tick();
    await until(() => source.captures === 1, 'the first capture');
    release();
    await Promise.all([first, second]);

    expect(source.captures).toBe(1);
    expect(perceiver.observes).toBe(1);
  });

  it('stops with a report when nothing was perceived', async () => {
    const { world, host, actuator } = makeWorld({ observation: nothingSeen });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual([]);
    const stopped = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.event.text).toContain('nothing');
    expect(world.isRunning()).toBe(false);
  });

  it('sends no input in a dry run', async () => {
    const { world, host, actuator } = makeWorld({ cfg: { dryRun: true } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(true);
  });

  it('retries a failing capture for three ticks, then treats the engine as absent', async () => {
    const source = new ScriptedSource();
    source.failures = 4;
    const { world, host, perceiver } = makeWorld({ source });
    await started(world, host);

    for (let index = 0; index < 3; index += 1) {
      await world.tick();
      expect(world.isRunning()).toBe(true);
    }
    expect(perceiver.observes).toBe(0);
    expect(host.pushed).toEqual([]);

    await world.tick();

    expect(world.isRunning()).toBe(false);
    const stopped = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.event.text).toContain('capture');
  });
});

// ---------------------------------------------------------------------------------------------
// The chest QTE: the tick belongs to the bar, one press, then back to the route
// ---------------------------------------------------------------------------------------------

describe('the chest QTE', () => {
  it('times the bar before the policy acts, and presses Space once', async () => {
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      await options.press();
      return { ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809 };
    };
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    expect(seen).toHaveLength(1);
    // The sub-loop's own bounds come from config, not from the caller's guess.
    expect(seen[0]!.minWindowMs).toBe(WVD_DEFAULTS.qteMinWindowMs);
    expect(seen[0]!.budgetMs).toBe(WVD_DEFAULTS.qteSubLoopMs);
    // The disarm is Space (0x39), held for the configured duration — a key, not a tap, not a literal.
    expect(actuator.calls).toEqual([`key ${DISARM_SCAN} ${WVD_DEFAULTS.pressHoldMs}`]);
  });

  it('does not press when the sub-loop gives up, and the tick carries on', async () => {
    let calls = 0;
    const timing: QteTimer = async () => {
      calls += 1;
      return { ok: false, reason: 'resolved' };
    };
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual([]);

    // A resolved pass is not a stop: the tick that follows asks the sub-loop again.
    await world.tick();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(world.isRunning()).toBe(true);
  });

  it('logs the routine end of a bar at info, never warn', async () => {
    // The bar outlives the press by ~3 s; a dimmed 解除 still clears the perceiver floor, so every
    // tick after our own press re-enters and refuses with `resolved`. That is the normal end of a
    // pass, not a failure: read as a warning it is ~30 false alarms per chest.
    for (const reason of ['resolved', 'bar-gone'] as const) {
      let calls = 0;
      const timing: QteTimer = async () => {
        calls += 1;
        return { ok: false, reason };
      };
      const { world, host } = makeWorld({ observation: qteBar, timing });
      await started(world, host);

      await world.tick();
      await world.tick();

      expect(calls).toBe(2);
      expect(host.logRecords.filter((line) => line.level === 'warn')).toEqual([]);
      const noted = host.logRecords.filter((line) => line.message.includes(`was not pressed: ${reason}`));
      // One line per tick that asks: no once-per-bar state is added (decision 6), so the honest
      // count is one info line per entry, not one per bar.
      expect(noted).toHaveLength(2);
      expect(noted.every((line) => line.level === 'info')).toBe(true);
    }
  });

  it('keeps a refusal that wanted to act at warn', async () => {
    const timing: QteTimer = async () => ({ ok: false, reason: 'budget-spent' });
    const { world, host } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    const warned = host.logRecords.filter((line) => line.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('budget-spent');
  });

  it('leaves without a press when a stop lands during the sub-loop', async () => {
    let worldRef: WvdWorld | null = null;
    const timing: QteTimer = async (options) => {
      // A stop from the console lands while the sub-loop is working; the next press must not.
      await worldRef!.stop();
      const pressed = await options.press();
      return pressed.ok
        ? { ok: true, v: 0, atMs: 0, target: 0, tapX: 0, restX: null }
        : { ok: false, reason: 'press-refused' };
    };
    const made = makeWorld({ observation: qteBar, timing });
    worldRef = made.world;
    await started(made.world, made.host);

    await made.world.tick();

    expect(made.actuator.calls).toEqual([]);
    expect(made.world.isRunning()).toBe(false);
  });

  it('warns and keeps the session when the timer throws', async () => {
    // `timeQte` returns values for its sampler, but `press` and `now` are the World's closures: a
    // throw there must be a skipped press, not the tick's catch ending the session as "a module
    // failed".
    const timing: QteTimer = async () => {
      throw new Error('boom');
    };
    const { world, host } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    expect(world.isRunning()).toBe(true);
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped')).toEqual([]);
    const warned = host.logRecords.filter((line) => line.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('could not be timed');
    expect(warned[0]!.message).toContain('boom');
  });

  it('does not time the bar when the client area is not 1920x1080', async () => {
    // The crop's origin is 1920-anchored (contracts §0.5); timing from another size would press
    // against the wrong pixels, so the composition root's invariant is enforced here.
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      return { ok: false, reason: 'resolved' };
    };
    const source = new ScriptedSource();
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing, source });
    await started(world, host);

    // The fake source is 1920x1080: the bar is timed.
    await world.tick();
    expect(seen).toHaveLength(1);

    // Another client size: nothing is sampled and nothing is pressed.
    source.capture = async (): Promise<Frame> => ({ ...frame(100), width: 2560, height: 1440 });
    await world.tick();
    expect(seen).toHaveLength(1);
    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(true);
    // The operator has to be able to fix the window: the warning names the size it saw.
    const warned = host.logRecords.filter(
      (line) => line.level === 'warn' && line.message.includes('not timing the chest QTE'),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]!.message).toContain('2560x1440');
  });

  it('sends no press in a dry run, even on the bar', async () => {
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      await options.press();
      return { ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809 };
    };
    const dry = makeWorld({ observation: qteBar, timing, cfg: { dryRun: true } });
    await started(dry.world, dry.host);

    await dry.world.tick();

    expect(seen).toEqual([]);
    expect(dry.actuator.calls).toEqual([]);

    // The same bar without the dry run does reach the sub-loop and the key, so the guard above
    // is the dry run and not "the QTE is never timed in this harness".
    const live = makeWorld({ observation: qteBar, timing });
    await started(live.world, live.host);
    await live.world.tick();
    expect(seen).toHaveLength(1);
    expect(live.actuator.calls).toEqual([`key ${DISARM_SCAN} ${WVD_DEFAULTS.pressHoldMs}`]);
  });

  it('reports the dry-run intent whatever the window size', async () => {
    // A dry run reports what it would do; the window-size refusal is a live-run gate, and the
    // operator reading a dry run must see the `would`, not a live-sounding "not timing".
    const source = new ScriptedSource();
    source.capture = async (): Promise<Frame> => ({ ...frame(100), width: 2560, height: 1440 });
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      return { ok: false, reason: 'resolved' };
    };
    const { world, host } = makeWorld({ observation: qteBar, timing, source, cfg: { dryRun: true } });
    await started(world, host);

    await world.tick();

    expect(seen).toEqual([]);
    expect(host.logRecords.some((line) => line.message.includes('dry run, would time the chest QTE'))).toBe(true);
    expect(host.logRecords.some((line) => line.message.includes('not timing the chest QTE'))).toBe(false);
  });

  it('clears the opener click when the bar takes the screen, so a returning panel is clickable', async () => {
    // The panel dismisses into the bar: that is the click's answer, whether the bar is read now or
    // after it goes. If the record survived the bar, a panel that comes back would be "still in
    // flight" and the loop would wait out `mapOpenTimeoutMs` instead of choosing a card again.
    const timing: QteTimer = async () => ({ ok: false, reason: 'resolved' });
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: openerPanel, timing });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    perceiver.observation = qteBar;
    clock.advance(100);
    await world.tick();
    expect(host.logRecords.some(
      (line) => line.message.includes('open-chest took effect: the screen is now chest-qte'),
    )).toBe(true);

    // The bar ended with the panel still up: the click is not outstanding, so the route chooses.
    perceiver.observation = openerPanel;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784', 'tap 963,784']);
  });
});

// ---------------------------------------------------------------------------------------------
// One command at a time: the walk owns the loop until arrival (Critical 2)
// ---------------------------------------------------------------------------------------------

describe('a walk stays in flight through the screens it produces', () => {
  it('does not open the map again when the map closing is the walk itself', async () => {
    const { world, host, perceiver, actuator, source, clock } = makeWorld();
    await started(world, host);

    // On the map the route walks to a chest: L. The map closing on the next tick is the key
    // working, not the walk finishing, so it must not release the command.
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    perceiver.observation = dungeonView;
    source.moving = true;
    for (let index = 0; index < 10; index += 1) {
      clock.advance(500);
      await world.tick();
    }
    // Five seconds of walking and nothing is sent: no G, no second L.
    expect(actuator.calls).toEqual(walkOne());
    expect(world.isRunning()).toBe(true);

    // The party stops. The scene has been still for automoveStillSeconds: arrival, and the route's
    // next decision (open the map from the 3D view) is allowed.
    source.moving = false;
    clock.advance(100);
    await world.tick();
    clock.advance(5_100);
    await world.tick();
    expect(actuator.calls).toEqual([
      ...walkOne(),
      `key ${SCAN.G} 60`,
      `key ${SCAN.G} 60`,
    ]);
  });

  it('treats a readout that moves under an open map as the walk starting, not as arrival', async () => {
    // navigation §3d: automove does not care whether the map is open, so the party can walk with the
    // map up. The readout moving is the walk, and arrival is the scene standing still.
    const { world, host, perceiver, actuator, clock } = makeWorld();
    await started(world, host);
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    const walked = { ...dungeonMap, map: { ...mapOf(dungeonMap), player: { x: 11, y: 19 } } };
    perceiver.observation = walked;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    clock.advance(5_100);
    await world.tick();
    // Arrival releases the walk, and the map is still open at a chest, so the route walks again —
    // aimed from where the readout now says the party is.
    expect(actuator.calls).toEqual([...walkOne(), ...walkCalls(mapOf(walked))]);
  });
});

// ---------------------------------------------------------------------------------------------
// Every command is gated on the screen it is valid on (Important 1)
// ---------------------------------------------------------------------------------------------

describe('the command gates', () => {
  it('presses F on the map, and opens the map first when the exit is decided elsewhere', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: emptyMap });
    await started(world, host);

    // On the map, F is 移動至出口: the one screen where the exit command is valid.
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);

    // The map closed and the party walked: the walk is outstanding, so nothing is sent.
    perceiver.observation = dungeonView;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);

    // Arrival, still with no chest budget: the route asks for the exit from the 3D view, where F is
    // 調査. The loop opens the map instead, and the next tick presses F from the map.
    clock.advance(5_100);
    await world.tick();
    expect(actuator.calls).toEqual([
      `key ${SCAN.F} 60`,
      `key ${SCAN.G} 60`,
      `key ${SCAN.G} 60`,
    ]);
  });

  it('refuses to open the map from the map: G there is 移動至目的地', async () => {
    // A model answer can name any intent. On the map, `open-map` is an unintended automove, so the
    // loop refuses it rather than pressing G.
    const doubtedMap: Observation = { ...dungeonMap, confidence: 0.3 };
    const { world, host, actuator } = makeWorld({ observation: doubtedMap, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const answer = outcome(await tool(world, 'wvd_resume').handler({ intent: { kind: 'open-map' } }, CTX));
    expect(answer.failed).toBeUndefined();
    await tick;

    expect(actuator.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Stalls are the loop's
// ---------------------------------------------------------------------------------------------

describe('the stall policy', () => {
  it('turns no progress into an escalation, and the escalation into the fallback', async () => {
    const { world, host, actuator, clock } = makeWorld({
      observation: waiting,
      cfg: { stallStopSeconds: 1, escalateTimeoutMs: 25 },
    });
    await started(world, host);

    await world.tick();
    expect(host.pushed).toEqual([]);

    clock.advance(600);
    await world.tick();

    const stuck = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toHaveLength(1);
    // no answer → the policy's own recovery: open the map (G twice), never `F` blind — on the 3D
    // view F is 調査, and the exit is only a command on the map (navigation §3d)
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('stops at stallStopSeconds, after the escalation has had its chance', async () => {
    const { world, host, clock } = makeWorld({
      observation: waiting,
      cfg: { stallStopSeconds: 1, escalateTimeoutMs: 10000 },
    });
    await started(world, host);

    await world.tick();
    clock.advance(600);
    const paused = world.tick();
    await until(() => host.pushed.length === 1, 'the question');
    clock.advance(500);
    // a diagnosis-only answer closes the question without redirecting the loop
    const answer = outcome(await tool(world, 'wvd_resume').handler({}, CTX));
    expect(answer.failed).toBeUndefined();
    await paused;

    clock.advance(500);
    await world.tick();

    expect(world.isRunning()).toBe(false);
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped')).toHaveLength(1);
  });

  it('does not count an alternating screen as progress', async () => {
    const { world, host, perceiver, clock } = makeWorld({
      cfg: { stallStopSeconds: 4, escalateTimeoutMs: 25 },
    });
    await started(world, host);
    await world.tick(); // map read #1: progress, one command sent

    // The screen alternates, but the party never moves and no chest disappears. A loop that calls
    // that progress never asks for help, however stuck the farm is.
    for (const next of [dungeonView, dungeonMap, dungeonView]) {
      perceiver.observation = next;
      clock.advance(400);
      await world.tick();
    }

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
  });

  it('cooldowns after a timeout instead of asking again on the next tick', async () => {
    const { world, host, clock } = makeWorld({
      observation: waiting,
      cfg: { stallStopSeconds: 10, escalateTimeoutMs: 200 },
    });
    await started(world, host);

    await world.tick();
    clock.advance(3000);
    await world.tick(); // escalates and times out; the fallback runs
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);

    clock.advance(100); // inside the cooldown, still stalled
    await world.tick();
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);

    clock.advance(200); // past the cooldown
    await world.tick();
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The escalation exchange
// ---------------------------------------------------------------------------------------------

describe('the escalation exchange', () => {
  it('pushes exactly one event with one blob, then resumes with the fallback at the timeout', async () => {
    const { world, host, actuator, snapshotCalls, cfg } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateTimeoutMs: 25, escalationImageWidth: 1280 },
    });
    await started(world, host);

    await world.tick();

    const stuck = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.opts?.trigger).toBe('flush');
    expect(stuck[0]!.event.tags).toEqual(['snapshot']);
    expect(stuck[0]!.contextDelivery).toBe('deliver');
    expect(stuck[0]!.event.blobs).toHaveLength(1);
    expect(stuck[0]!.event.blobs![0]!.mime).toBe('image/jpeg');
    expect(stuck[0]!.event.blobs![0]!.fallbackText).toBe('screenshot 1280×720');
    expect(stuck[0]!.event.text).toContain('Question:');
    // the snapshot is a second capture at the configured width, not a re-encode of the verdict frame
    expect(snapshotCalls).toEqual([cfg.escalationImageWidth]);
    // nobody answered, so the loop took its own recovery: the map first, never `F` blind
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
    // exactly one question, counting pushes: the hourly budget is the loop's
    expect(world.escalationsThisHour()).toBe(1);
  });

  it('checks image support wrapped, so a throwing endpoint still gets the question', async () => {
    const host = new FakeHost();
    host.acceptsThrows = true;
    const { world } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 20 }, host });
    await started(world, host);

    await world.tick();

    const stuck = host.pushed.find((pushed) => pushed.event.type === 'wvd.stuck')!;
    expect(stuck.event.text).toContain('Question:');
  });

  it('still sends the question when the endpoint cannot show images', async () => {
    const host = new FakeHost();
    host.acceptsImage = false;
    const { world } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 20 }, host });
    await started(world, host);

    await world.tick();

    const stuck = host.pushed.find((pushed) => pushed.event.type === 'wvd.stuck')!;
    expect(stuck.event.blobs).toHaveLength(1);
    expect(stuck.event.text.toLowerCase()).toContain('cannot');
  });

  it('says so when the screenshot could not be captured at all', async () => {
    const { world, host } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateTimeoutMs: 20 },
      screenshot: () => null,
    });
    await started(world, host);

    await world.tick();

    const stuck = host.pushed.find((pushed) => pushed.event.type === 'wvd.stuck')!;
    expect(stuck.event.blobs).toBeUndefined();
    expect(stuck.event.text).toContain('could not be captured');
  });

  it('does not wait when the host archived the event instead of delivering it', async () => {
    const host = new FakeHost();
    host.delivery = 'archive-only';
    const { world, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 30000 }, host });
    await started(world, host);

    const start = Date.now();
    await world.tick();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('a stop during the snapshot capture asks nothing and sends nothing', async () => {
    let release = (): void => {};
    const snapshotGate = new Promise<void>((resolve) => { release = resolve; });
    const { world, host, actuator, snapshotCalls } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateTimeoutMs: 5000 },
      snapshotGate,
    });
    await started(world, host);

    const tick = world.tick();
    await until(() => snapshotCalls.length === 1, 'the snapshot capture');
    await world.stop();
    release();
    await tick;

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);
    expect(actuator.calls).toEqual([]);
  });

  it('treats a push that throws as undelivered and takes the fallback', async () => {
    const host = new FakeHost();
    host.failPush = true;
    const { world, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 30000 }, host });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('treats a discarded question as undelivered and takes the fallback', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 30000 } });
    await started(world, host);

    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');
    const cursor = host.pushed[0]!.cursor;
    const envelope = { cursor, type: 'wvd.stuck', source: 'wvd', ts: '', text: '', origin: 'external' } as EventEnvelope;
    world.onEventsSettled([envelope], 'discarded');
    await tick;

    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('resumes with the answer\'s intent, and refuses a second answer', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);

    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const resume = tool(world, 'wvd_resume');
    const answered = outcome(await resume.handler({ intent: { kind: 'open-map' }, note: 'map was closed' }, CTX));
    expect(answered.failed).toBeUndefined();
    expect(answered.text).toBe('resumed: the loop takes open-map');
    await tick;

    // the intent the model named, not the fallback
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);

    // a late answer hears "nothing is waiting" before its arguments are even looked at
    const late = outcome(await resume.handler({ intent: { kind: 'dance' } }, CTX));
    expect(late.failed).toBe(true);
    expect(late.text).toBe('not resumed: nothing is waiting for an answer');
  });

  it('names the fallback when an answer arrives after the timeout', async () => {
    const { world, host } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 20 } });
    await started(world, host);
    await world.tick();

    const late = outcome(await tool(world, 'wvd_resume').handler({}, CTX));
    expect(late.failed).toBe(true);
    expect(late.text).toContain('expired');
    // the fallback is screen-chosen: an unknown screen is opened, not left (F is 調査 there)
    expect(late.text).toContain('opened the map');
  });
});

// ---------------------------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------------------------

describe('the tools', () => {
  it('wvd_status reports the session in prose', async () => {
    const { world, host } = makeWorld();
    await started(world, host);
    await world.tick();

    const status = outcome(await tool(world, 'wvd_status').handler({}, CTX));
    expect(status.failed).toBeUndefined();
    expect(status.text).toContain('session running');
    expect(status.text).toContain('last intent');
    expect(status.text).not.toMatch(/^\{/);
  });

  it('wvd_look captures, observes and returns the frame as a blob', async () => {
    const { world, host, source, snapshotCalls } = makeWorld();
    await started(world, host);

    const look = outcome(await tool(world, 'wvd_look').handler({}, CTX));

    expect(source.captures).toBe(1);
    expect(look.failed).toBeUndefined();
    expect(look.text).toContain('Image 1280×720');
    expect(look.blobs).toHaveLength(1);
    const blob = look.blobs![0]!;
    expect('mime' in blob ? blob.mime : null).toBe('image/jpeg');
    expect(blob.fallbackText).toBe('screenshot 1280×720');
    expect(snapshotCalls).toEqual([1280]);
  });

  it('wvd_look refuses when no session is running', async () => {
    const { world } = makeWorld();
    const look = outcome(await tool(world, 'wvd_look').handler({}, CTX));
    expect(look.failed).toBe(true);
    expect(look.text).toContain('no session');
  });

  it('wvd_act refuses unless a question is waiting', async () => {
    const { world, host, actuator } = makeWorld();
    await started(world, host);

    const act = outcome(await tool(world, 'wvd_act').handler({ kind: 'tap', x: 10, y: 10 }, CTX));

    expect(act.failed).toBe(true);
    expect(act.text).toContain('no question is waiting');
    expect(actuator.calls).toEqual([]);
  });

  it('wvd_act scales image pixels onto the window and refuses what is outside the image', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const act = tool(world, 'wvd_act');
    const sent = outcome(await act.handler({ kind: 'tap', x: 960, y: 540 }, CTX));
    expect(sent.failed).toBeUndefined();
    expect(sent.text).toBe('sent: tap 1440, 810');
    expect(actuator.calls).toContain('tap 1440,810');

    const outside = outcome(await act.handler({ kind: 'doubleTap', x: 1280, y: 10 }, CTX));
    expect(outside.failed).toBe(true);
    expect(outside.text).toContain('1280×720');

    const held = outcome(await act.handler({ kind: 'holdKey', key: 'w', holdMs: 250 }, CTX));
    expect(held.failed).toBeUndefined();
    expect(held.text).toBe('sent: held w 250 ms');
    expect(actuator.calls).toContain(`key ${SCAN.W} 250`);

    await tool(world, 'wvd_resume').handler({}, CTX);
    await tick;
  });

  it('presses with the configured hold rather than the 60 ms default', async () => {
    const { world, host, actuator } = makeWorld({ cfg: { pressHoldMs: 90 } });
    await started(world, host);

    await world.tick();

    // `worlds.wvd.pressHoldMs` is threaded into the command by the composition root; the map's
    // 移動至宝箱 is one press, and it carries the tuned duration (Important 2).
    expect(actuator.calls).toEqual(walkOne(90));
  });

  it('clamps a hold to the contract ceiling: a longer one could outlive the engine teardown', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const act = tool(world, 'wvd_act');
    const held = outcome(await act.handler({ kind: 'holdKey', key: 'w', holdMs: 5_000 }, CTX));
    expect(held.failed).toBeUndefined();
    expect(held.text).toBe(`sent: held w ${MAX_PRESS_HOLD_MS} ms`);
    expect(actuator.calls).toContain(`key ${SCAN.W} ${MAX_PRESS_HOLD_MS}`);

    // the schema says the same ceiling, so a model reading the declaration cannot ask for more
    const properties = (act.parameters as { properties: Record<string, { maximum?: number }> }).properties;
    expect(properties.holdMs!.maximum).toBe(MAX_PRESS_HOLD_MS);

    await tool(world, 'wvd_resume').handler({}, CTX);
    await tick;
  });

  it('wvd_act reports a rejected input as not sent', async () => {
    const actuator = new ScriptedActuator();
    actuator.result = { ok: false, reason: 'rejected', detail: 'not-foreground' };
    const { world, host } = makeWorld({ observation: unknownButSeen, actuator, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const act = outcome(await tool(world, 'wvd_act').handler({ kind: 'tap', x: 10, y: 10 }, CTX));
    expect(act.failed).toBe(true);
    expect(act.text).toBe('not sent: rejected (not-foreground)');

    await tool(world, 'wvd_resume').handler({}, CTX);
    await tick;
  });

  it('wvd_resume validates the intent it is given, and aims move at the nearest chest', async () => {
    // The escalation is on a map the route will not act on (below its floor), because `move` is the
    // map's own gesture: the loop refuses to walk to a tile anywhere else (navigation §3d).
    const doubtedMap: Observation = { ...dungeonMap, confidence: 0.3 };
    const { world, host, actuator } = makeWorld({ observation: doubtedMap, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    const resume = tool(world, 'wvd_resume');
    const unknown = outcome(await resume.handler({ intent: { kind: 'dance' } }, CTX));
    expect(unknown.failed).toBe(true);
    expect(unknown.text).toBe('not resumed: unknown intent kind: dance');

    const notObject = outcome(await resume.handler({ intent: 'open-map' }, CTX));
    expect(notObject.failed).toBe(true);
    expect(notObject.text).toBe('not resumed: intent must be an object');

    // The model names the verb, not the cell: the tile is the nearest chest of the last map read.
    const moved = outcome(await resume.handler({ intent: { kind: 'move' }, note: 'walk to the chest' }, CTX));
    expect(moved.failed).toBeUndefined();
    expect(moved.text).toBe('resumed: the loop takes move');
    await tick;
    expect(actuator.calls).toEqual(walkOne());
  });
});

// ---------------------------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------------------------

describe('stopping', () => {
  it('a stopHotkey ends the session and pushes one event saying so', async () => {
    const { world, host } = makeWorld();
    await started(world, host);
    await world.tick();
    expect(host.pushed).toEqual([]);

    await world.onEngineEvent({ kind: 'stopHotkey' } as EngineEvent);

    expect(world.isRunning()).toBe(false);
    const stopped = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.event.text).toContain('hotkey');
  });

  it('a stopHotkey settles a pending question instead of holding the stop deadline', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 60000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    await world.onEngineEvent({ kind: 'stopHotkey' } as EngineEvent);
    await tick;

    // cancelled, not timed out: no fallback input, and the question is closed
    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(false);
  });

  it('stops when the stop hotkey could not be registered', async () => {
    const { world, host } = makeWorld();
    await started(world, host);

    await world.onEngineEvent({ kind: 'engineProblem', detail: 'stop-hotkey-unregistered' } as EngineEvent);

    expect(world.isRunning()).toBe(false);
    const stopped = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.event.text).toContain('stop hotkey is not registered');
  });

  it('records a degraded engine without ending the session', async () => {
    const { world, host } = makeWorld();
    await started(world, host);

    await world.onEngineEvent({ kind: 'engineProblem', detail: 'native-encoder-unavailable' } as EngineEvent);

    expect(world.isRunning()).toBe(true);
    const status = outcome(await tool(world, 'wvd_status').handler({}, CTX));
    expect(status.text).toContain('native-encoder-unavailable');
  });

  it('mounting stops nothing and pushes nothing when no session ran', async () => {
    const { world, host } = makeWorld();
    await world.start(host as unknown as WorldHost);
    await world.stop();
    expect(host.pushed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The opener panel is clicked, once (Task 12)
// ---------------------------------------------------------------------------------------------

describe('the opener click', () => {
  it("clicks the chosen member's card centre, once, and treats the next screen as its answer", async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: openerPanel });
    await started(world, host);

    // Index 1 has the higher 陷阱解除, so it is the second card: (963, 784) from the measured boxes.
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The panel is still up. The click is a command in flight, so the route's same `open-chest`
    // intent does not become a second click.
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The screen after the panel is whatever follows: loot, for an untrapped chest (chest §3a). The
    // loop does not wait for a QTE bar that may never appear; it simply re-perceives.
    perceiver.observation = { screen: 'loot', atMs: 200, confidence: 1 };
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);
    expect(world.isRunning()).toBe(true);
  });

  it('gives up a click the panel never answered, and does not click again until the farm advances', async () => {
    const { world, host, actuator, clock } = makeWorld({ observation: openerPanel, cfg: { mapOpenTimeoutMs: 50 } });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The panel never changed: the click is recorded failed and not re-sent. The stall clock owns
    // what happens next, exactly as it does for a key command.
    clock.advance(100);
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);
  });

  it('escalates instead of clicking when nobody is at or above the willpower floor', async () => {
    const { world, host, actuator } = makeWorld({ observation: openerNobody, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls.filter((call) => call.startsWith('tap '))).toEqual([]);
    const stuck = host.pushed.find((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toBeDefined();
    // The reason travels in the question: the model is told *why* the loop will not click.
    expect(stuck!.event.text).toContain('60 willpower floor');
    expect(world.escalationsThisHour()).toBe(1);
  });

  it('escalates on a card with no readable willpower, and never falls back to a lower member', async () => {
    const { world, host, actuator } = makeWorld({ observation: openerUnread, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls.filter((call) => call.startsWith('tap '))).toEqual([]);
    const stuck = host.pushed.find((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toBeDefined();
    // The reason names the unread card, so the model is not told "below the floor" about a value the
    // screen never showed.
    expect(stuck!.event.text).toContain('show no willpower');
    expect(stuck!.event.text).toContain('60 willpower floor');
  });

  it('escalates a panel it recognised but could not read, without clicking', async () => {
    // `ChestPerceiver` answers `unknown` at confidence 0.3 for this frame; the loop must ask, not
    // stop (confidence 0 would have ended the session) and not click a half-read roster.
    const { world, host, actuator } = makeWorld({ observation: refusedPanel, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls.filter((call) => call.startsWith('tap '))).toEqual([]);
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
    expect(world.isRunning()).toBe(true);
  });

  it('honours the configured willpower floor, not only the policy default', async () => {
    const { world, host, actuator } = makeWorld({
      observation: { ...openerPanel, opener: { members: [openerMember(10, 90, 70)] } },
      cfg: { willpowerFloor: 80, escalateTimeoutMs: 25 },
    });
    await started(world, host);

    await world.tick();

    expect(actuator.calls.filter((call) => call.startsWith('tap '))).toEqual([]);
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
  });

  it('refuses to click a card from a screen that is not the panel', async () => {
    const doubtedMap: Observation = { ...dungeonMap, confidence: 0.3 };
    const { world, host, actuator } = makeWorld({ observation: doubtedMap, cfg: { escalateTimeoutMs: 5000 } });
    await started(world, host);
    const tick = world.tick();
    await until(() => host.pushed.length === 1, 'the question');

    // A model answer can name any intent. `open-chest` is only valid on the panel.
    const answer = outcome(await tool(world, 'wvd_resume').handler({ intent: { kind: 'open-chest' } }, CTX));
    expect(answer.failed).toBeUndefined();
    await tick;

    expect(actuator.calls.filter((call) => call.startsWith('tap '))).toEqual([]);
  });
});
