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
  FarmPolicy,
  Frame,
  FrameSource,
  MapState,
  MapIcon,
  Observation,
  Perceiver,
  Point,
  SessionTask,
  TaskDefinition,
  BattleMemberReader,
  BattleOpener,
} from '../src/contracts.ts';
import { automoveToExit, automoveToTile, openMap } from '../src/actions/automove.ts';
import { acceptChestPrompt, cancelQte, DISARM_SCAN, dismissLoot, enableBattleAuto, reenterChest, tapLoot } from '../src/actions/chest.ts';
import { timeQte, type QteTimer, type QteTimingOptions } from '../src/actions/qte.ts';
import { WVD_DEFAULTS, type WvdConfigSection } from '../src/config.ts';
import { MAX_PRESS_HOLD_MS } from '../src/contracts.ts';
import { routePolicy } from '../src/policy/route.ts';
import { createTaskPolicy } from '../src/tasks/policy.ts';
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
  async drag(from: Point, to: Point, durationMs: number): Promise<ActionResult> {
    this.calls.push(`drag ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
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
/**
 * The 3-D view with something drawn over it: the frame's own evidence says dungeon (the minimap arrow),
 * nothing named it. This is the frame the loop asks the game's map about (operator rule 2026-11-03).
 */
const dungeonLikeUnknown: Observation = { screen: 'unknown', atMs: 100, confidence: 0.8, dungeonLike: true };
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

/** The battle screen: the loop enables 倍速/自动 and waits for it to leave. */
const combatView: Observation = { screen: 'combat', atMs: 100, confidence: 0.9 };

/** The chest prompt: the 打开 button is its only command. */
const chestPrompt: Observation = { screen: 'chest-prompt', atMs: 100, confidence: 1 };

/** A parsed panel where nobody may open the chest: both are under the 60 willpower floor. */
const openerNobody: Observation = {
  screen: 'chest-open',
  atMs: 100,
  confidence: 1,
  opener: { members: [openerMember(10, 40, 59), openerMember(10, 90, 30)] },
};

/**
 * The best card's heart did not parse (`NaN` = a heart was drawn but could not be read): it is
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
  /** The task a session runs, when the test exercises the entry hand-off. */
  task?: SessionTask;
  /** The policy under test; the route alone unless a test decorates it (the task decorator). */
  policy?: FarmPolicy;
  /** What the orientation's world-map travel answers. */
  travelResult?: { ok: true } | { ok: false; reason: 'location-not-found' | 'unknown-location'; detail?: string };
  /** What a tile walk answers, when a test needs the game to refuse it (an unreachable cell). */
  moveResult?: ActionResult;
  /** The opener list and the member reader (contracts §11); absent leaves battles to auto. */
  battle?: { readonly openers: readonly BattleOpener[]; readonly reader: BattleMemberReader };
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
  const travelCalls: string[] = [];
  const openerCalls: string[] = [];
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
  // The settle window is pinned to 0 here: most tests are about what the loop does *with* a verdict,
  // and a 1 s window would make every one of them model a transition first. The tests that pin the
  // window itself pass `escalateSettleMs` explicitly.
  const cfg: WvdConfigSection = {
    ...structuredClone(WVD_DEFAULTS), enabled: false, tickMs: 50, escalateSettleMs: 0, ...options.cfg,
  };
  const host = options.host ?? new FakeHost();
  const clock = new TestClock();
  let openSessionCalls = 0;
  const world = new WvdWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    policy: options.policy ?? routePolicy,
    battle: options.battle,
    classify,
    timing: options.timing ?? timeQte,
    commands: {
      // `main.ts` reads `pressHoldMs` per command; the harness does the same, so a configured hold
      // that the loop ignored would show up here (Important 2).
      openMap: () => openMap(actuator, cfg.pressHoldMs),
      automoveToTile: (at) => Promise.resolve(options.moveResult ?? automoveToTile(actuator, at, cfg.pressHoldMs)),
      automoveToExit: () => automoveToExit(actuator, cfg.pressHoldMs),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      tapLoot: () => tapLoot(actuator),
      dismissLoot: () => dismissLoot(actuator),
      // The heal's taps are pinned in tests/heal.test.ts; the world tests only need the command.
      healParty: async () => ({ ok: true }),
      enableBattleAuto: () => enableBattleAuto(actuator),
      // The opener's taps are pinned in tests/battle-opener.test.ts; the world tests need the call.
      battleOpener: async (opener) => { openerCalls.push(opener.name); return { ok: true }; },
      cancelQte: () => cancelQte(actuator),
      reenterChest: () => reenterChest(actuator, cfg.hazardEscapeHoldMs),
      travel: async (to) => {
        travelCalls.push(to);
        return options.travelResult ?? { ok: true };
      },
    },
    openSession: async () => {
      openSessionCalls += 1;
      if (options.openSessionGate) await options.openSessionGate;
      return options.task === undefined ? { ok: true, session } : { ok: true, session, task: options.task };
    },
    autoTick: false,
    now: clock.now,
  });
  return {
    world, host, source, perceiver, actuator, cfg, snapshotCalls, clock, travelCalls,
    openerCalls,
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

    // automoveStillSeconds passes with the screen unchanged: the walk never started. Since 2026-11-02
    // the farm does not wait here — it retries the cell once (the first refusal is often the map's
    // fade), and only a second refusal makes it unreachable, at which point the exit is the next stage.
    clock.advance(5000);
    await world.tick();
    expect(actuator.calls).toEqual([...walkOne(), ...walkOne()]);

    // The retry is refused as well: the chest is skipped, and with none left the farm leaves.
    clock.advance(100);
    await world.tick();
    clock.advance(5000);
    await world.tick();
    expect(actuator.calls).toEqual([...walkOne(), ...walkOne(), `key ${SCAN.F} 60`]);
  });

  it('sends a command that changed nothing again once the farm advances', async () => {
    // The guard is per screen epoch: a map that never opened is not pressed twice, but a readout that
    // moves is the farm advancing, and a command may be sent again from it.
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);

    // mapOpenTimeoutMs passes with the 3-D view still up: the map command changed nothing.
    clock.advance(3_100);
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);

    // The farm advances: the map is up and the party moved. The guard clears, and the loop acts on
    // the new readout instead of staying silent.
    const moved = { ...dungeonMap, map: { ...mapOf(dungeonMap), player: { x: 12, y: 18 } } };
    perceiver.observation = moved;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([
      `key ${SCAN.G} 60`,
      `key ${SCAN.G} 60`,
      ...walkCalls(mapOf(moved)),
    ]);
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

  it('holds the nothing-perceived stop through a transition and stops when it persists', async () => {
    // Live 2026-11-02: a battle's fade read `unknown` at confidence 0 and ended an unattended run.
    // With the real settle window a blank frame is watched, not obeyed; a session that stays blank
    // still stops, with the same report.
    const { world, host, clock } = makeWorld({ observation: nothingSeen, cfg: { escalateSettleMs: 5_000 } });
    await started(world, host);

    await world.tick();
    expect(world.isRunning()).toBe(true);

    clock.advance(5_100);
    await world.tick();
    const stopped = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.event.text).toContain('nothing');
    expect(world.isRunning()).toBe(false);
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
      return { ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809, restSettled: true };
    };
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    expect(seen).toHaveLength(1);
    // The sub-loop's own bound comes from config, not from the caller's guess. The pass window is
    // the policy's judgement: the World hands the loop a `choosePass` carrying the configured floor,
    // and the loop itself no longer has a lead floor to pass in.
    expect(seen[0]!.budgetMs).toBe(WVD_DEFAULTS.qteSubLoopMs);
    expect(seen[0]!.choosePass?.({ windowMs: WVD_DEFAULTS.qteMinWindowMs, speedPxPerS: 900 })).toBe('press');
    expect(seen[0]!.choosePass?.({ windowMs: WVD_DEFAULTS.qteMinWindowMs - 1, speedPxPerS: 900 })).toBe('reroll');
    // The disarm is Space (0x39), held for the configured duration — a key, not a tap, not a literal.
    expect(actuator.calls).toEqual([`key ${DISARM_SCAN} ${WVD_DEFAULTS.pressHoldMs}`]);
    // The success line is #18's fit input: the plan's delay is `delayMs` (every `atMs` is a clock
    // stamp, contracts §0.4), and the rest read says whether it settled.
    const pressed = host.logRecords.filter((line) => line.message.includes('chest QTE pressed'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.message).toContain('delayMs=120');
    expect(pressed[0]!.message).toContain('restX=809');
    expect(pressed[0]!.message).toContain('settled=true');
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

  it('presses the bar as the last attempt after the reroll budget is spent', async () => {
    let calls = 0;
    const timing: QteTimer = async (options) => {
      calls += 1;
      if (calls === 1) return { ok: false, reason: 'no-better-pass' };
      // The budget is spent, but a plan exists: the bar is taken as the last attempt.
      expect(options.choosePass?.({ windowMs: 1, speedPxPerS: 1200 })).toBe('press');
      const pressed = await options.press();
      return pressed.ok
        ? { ok: true, v: 0, atMs: 0, target: 0, tapX: 0, restX: null, restSettled: false }
        : { ok: false, reason: 'press-refused' };
    };
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();                 // the budget is spent; the bar is left for this tick
    await world.tick();                 // the next tick presses it anyway
    expect(actuator.calls).toEqual([`key ${DISARM_SCAN} ${WVD_DEFAULTS.pressHoldMs}`]);
    expect(world.isRunning()).toBe(true);
  });

  it('taps the loot card at its measured point, once per interval', async () => {
    const loot: Observation = { screen: 'loot', atMs: 120, confidence: 0.6 };
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: loot });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(100);
    await world.tick();                 // inside lootTapIntervalMs: no second tap
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(400);
    await world.tick();                 // the interval has passed: one more tap
    expect(actuator.calls).toEqual(['tap 960,510', 'tap 960,510']);

    perceiver.observation = dungeonMap; // the card left; the route moves on
    clock.advance(100);
    await world.tick();
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
        ? { ok: true, v: 0, atMs: 0, target: 0, tapX: 0, restX: null, restSettled: false }
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
      return { ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809, restSettled: true };
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
    // flight" and the loop would wait out `openerPanelTimeoutMs` instead of choosing a card again.
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

  it('casts a listed member\'s opener once per battle, before auto', async () => {
    // Operator rule 2026-11-02: the ACTIVE member is filtered against the configured list; on it, the
    // skill is cast before auto; not on it, the default runs. Alice acts first, so the first phase is hers.
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '右上' as const, target: 'party-front' as const }], reader };
    const { world, host, actuator, perceiver, clock, openerCalls } = makeWorld({ observation: combatView, battle });
    await started(world, host);

    await world.tick();
    expect(openerCalls).toEqual(['爱丽丝']);
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);

    // The battle leaves; once the fight's own wait settles, a new battle starts and re-arms the filter.
    perceiver.observation = dungeonView;
    for (let index = 0; index < 14; index += 1) { clock.advance(500); await world.tick(); }
    perceiver.observation = combatView;
    clock.advance(500);
    await world.tick();
    expect(openerCalls).toEqual(['爱丽丝', '爱丽丝']);
  });

  it('does nothing but auto when the ACTIVE member is not on the opener list', async () => {
    const reader: BattleMemberReader = { readActiveMember: async () => '本杰明' };
    const battle = { openers: [{ name: '爱丽丝', slot: '右上' as const, target: 'party-front' as const }], reader };
    const { world, host, actuator, openerCalls } = makeWorld({ observation: combatView, battle });
    await started(world, host);

    await world.tick();
    expect(openerCalls).toEqual([]);
    // The default action is the auto battle the loop already sent.
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);
    expect(host.logRecords.some((line) => line.message.includes('not on the opener list'))).toBe(true);
  });

  it('treats an unreadable ACTIVE member as a miss, never a tap', async () => {
    const reader: BattleMemberReader = { readActiveMember: async () => null };
    const battle = { openers: [{ name: '爱丽丝', slot: '右上' as const, target: 'party-front' as const }], reader };
    const { world, host, actuator, openerCalls } = makeWorld({ observation: combatView, battle });
    await started(world, host);

    await world.tick();
    expect(openerCalls).toEqual([]);
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);
    expect(host.logRecords.some((line) => line.message.includes('unreadable'))).toBe(true);
  });

  it('presses auto again while the battle is still waiting at a command phase', async () => {
    // Operator rule 2026-11-02: auto is the battle's fallback — pressed until it is on. A press
    // swallowed while the opener's skill resolves must not leave the fight to the stall clock, so a
    // later command phase presses again; the pace is the fight's own in-flight wait, not the tick.
    const { world, host, actuator, clock } = makeWorld({ observation: combatView });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);

    // Inside the fight's own wait nothing is sent.
    clock.advance(1_000);
    await world.tick();
    expect(actuator.calls).toHaveLength(2);

    // The wait answers (the scene stands still) and the battle is unchanged: the fallback presses.
    clock.advance(3_000);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708', 'tap 691,708', 'tap 1231,708']);
  });

  it('stops pressing auto at the configured attempts, and says so once', async () => {
    // `autoBattleEnableAttempts` (contracts §8.5) is the cap the config already declared: three
    // tries by default, and a fourth is not a war of attrition on the button.
    const { world, host, actuator, clock } = makeWorld({ observation: combatView, cfg: { autoBattleEnableAttempts: 3 } });
    await started(world, host);
    // Press, wait for the fight's answer, press again: the third is the cap, and the fourth tick after
    // that only says so.
    for (let index = 0; index < 7; index += 1) {
      clock.advance(3_000);
      await world.tick();
    }
    const presses = actuator.calls.filter((call) => call === 'tap 691,708').length;
    expect(presses).toBe(3);
    expect(host.logRecords.filter((record) => record.message.includes('auto was pressed 3 times')).length).toBe(1);
  });

  it('re-arms the auto fallback for the next battle', async () => {
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: combatView });
    await started(world, host);
    await world.tick();
    expect(actuator.calls.filter((call) => call === 'tap 691,708').length).toBe(1);

    // The battle leaves, then a new one starts: the count belongs to the battle.
    perceiver.observation = dungeonView;
    clock.advance(3_000);
    await world.tick();
    perceiver.observation = combatView;
    clock.advance(3_000);
    await world.tick();
    expect(actuator.calls.filter((call) => call === 'tap 691,708').length).toBe(2);
  });

  it('casts the opener once even when the auto press is retried', async () => {
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '右上' as const, target: 'party-front' as const }], reader };
    const { world, host, openerCalls, clock } = makeWorld({ observation: combatView, battle });
    await started(world, host);
    for (let index = 0; index < 8; index += 1) {
      clock.advance(3_000);
      await world.tick();
    }
    expect(openerCalls).toEqual(['爱丽丝']);
  });

  it('puts the heal before the next command in the cycle pipeline', async () => {
    // Operator rule 2026-11-02, priority 1: safe before battle and after it. The battle sets the heal;
    // the next 3-D view tick spends it and sends nothing else, so the party is healed before the loop
    // asks it to open the map for the next chest. Priorities 2-4 (claim, skip, rest) come after.
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: combatView });
    await started(world, host);
    const healed = () => host.logRecords.filter((record) => record.message.includes('healed the party')).length;

    await world.tick();
    const fightCalls = actuator.calls.length;
    expect(fightCalls).toBeGreaterThan(0);

    // The battle leaves: the fight stays in flight until its screen answers (arrival), then the heal
    // is that tick's one command — no route command rides along with it.
    perceiver.observation = dungeonView;
    let callsAtHeal = -1;
    for (let index = 0; index < 14 && callsAtHeal < 0; index += 1) {
      clock.advance(500);
      await world.tick();
      if (healed() === 1) callsAtHeal = actuator.calls.length;
    }
    expect(healed()).toBe(1);
    expect(callsAtHeal).toBe(fightCalls);

    // The next tick is the route's: with the heal spent, the map opens for the next chest.
    clock.advance(500);
    await world.tick();
    expect(actuator.calls.slice(fightCalls)).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('heals once after a battle, and again after a chest, and not twice on the same view', async () => {
    const { world, host, perceiver, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);
    const healed = () => host.logRecords.filter((record) => record.message.includes('healed the party')).length;

    // A battle, then the view: the heal is the operator's after-every-battle step. The fight's own
    // command stays in flight until its screen answers, so give the view a few ticks.
    perceiver.observation = combatView;
    clock.advance(100);
    await world.tick();
    expect(healed()).toBe(0);
    perceiver.observation = dungeonView;
    for (let index = 0; index < 12; index += 1) { clock.advance(500); await world.tick(); }
    expect(healed()).toBe(1);

    // The flag is spent: more view ticks do not heal again.
    for (let index = 0; index < 6; index += 1) { clock.advance(500); await world.tick(); }
    expect(healed()).toBe(1);

    // A chest sets it again: loot, then the view.
    perceiver.observation = { screen: 'loot', atMs: 100, confidence: 1 };
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    for (let index = 0; index < 12; index += 1) { clock.advance(500); await world.tick(); }
    expect(healed()).toBe(2);
  });

  it('answers a walk with the chest prompt, whose animation defeats the stillness rule', async () => {
    // The live failure of 2026-11-01: the prompt appeared 4 s into the walk, its highlight animates
    // (two captures 0.5 s apart differed on 394k pixels), the scene never stood still, the walk
    // never arrived, and the loop escalated instead of pressing 打开.
    const { world, host, perceiver, actuator, source, clock } = makeWorld();
    await started(world, host);
    await world.tick();
    expect(actuator.calls).toEqual(walkOne());

    perceiver.observation = dungeonView;
    source.moving = true;
    for (let index = 0; index < 6; index += 1) {
      clock.advance(500);
      await world.tick();
    }
    expect(actuator.calls).toEqual(walkOne());

    // Every frame is still different (the prompt animates), yet the screen is the arrival evidence.
    perceiver.observation = chestPrompt;
    clock.advance(100);
    await world.tick();
    expect(host.logRecords.some((record) => record.message.includes('arrived: the screen is chest-prompt'))).toBe(true);
    expect(actuator.calls.at(-1)).toBe('tap 955,858');
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
// The task entry hands the party to the loop
// ---------------------------------------------------------------------------------------------

describe('the task entry hand-off', () => {
  /** An entry that starts no walk: the test walks the fake frame clock itself. */
  const entryTask = (entered: () => void): SessionTask => ({
    enter: async () => {
      entered();
      return { ok: true, steps: 1, ms: 1 };
    },
    runScript: async () => ({ ok: true, steps: 0, ms: 0 }),
    abort: () => {},
  });

  it('holds the first command until the walk the entry started arrives', async () => {
    let enters = 0;
    const { world, host, actuator, source, clock } = makeWorld({
      observation: dungeonView,
      task: entryTask(() => { enters += 1; }),
    });
    await started(world, host);
    expect(enters).toBe(1);

    // The entry's 自动移动 is under way: every frame is a new scene, so the loop sends nothing.
    source.moving = true;
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([]);

    // The party stands: the stillness window starts on the frame it stopped on, and only a full
    // automoveStillSeconds releases the walk — the same arrival rule as the loop's own move.
    source.moving = false;
    await world.tick();
    clock.advance(4_900);
    await world.tick();
    expect(actuator.calls).toEqual([]);

    clock.advance(200);
    await world.tick();
    // Arrival releases the hand-off and the route's first command goes out in the same tick.
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
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

  it('does not ask about an unnamed screen that resolves inside the settle window', async () => {
    // The chest panel's fade: unnamed for a few ticks, then the panel. It must not spend a question
    // (and the operator's 90 s) on a transition the next frames answer — measured 2026-10-31, both
    // chest runs paid 90 s for exactly these frames.
    const { world, host, perceiver, clock } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateSettleMs: 1_000, escalateTimeoutMs: 25 },
    });
    await started(world, host);

    await world.tick();                  // the fade's first unnamed frame
    clock.advance(150);
    await world.tick();                  // unnamed, 150 ms in
    perceiver.observation = dungeonMap;  // the panel settles
    clock.advance(150);
    await world.tick();

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);
  });

  it('asks about an unnamed screen once it outlasts the settle window', async () => {
    const { world, host, clock } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateSettleMs: 1_000, escalateTimeoutMs: 25 },
    });
    await started(world, host);

    await world.tick();                  // unnamed since this tick
    clock.advance(900);
    await world.tick();                  // 900 ms: still settling
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);

    clock.advance(200);                  // 1 100 ms: it has outlasted the window
    await world.tick();
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
  });

  it('asks the game for its map about a 3-D-looking frame before the question', async () => {
    // Operator rule 2026-11-03: the 3-D view can read unnamed (a bright scene fills the title band,
    // the menu legend draws a panel — t-mvy23qe2). The map states the floor in text, so the loop
    // presses it once before it spends the model's 90 s question.
    const { world, host, actuator } = makeWorld({ observation: dungeonLikeUnknown, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);
    expect(actuator.calls).toEqual(['key ' + SCAN.G + ' 60', 'key ' + SCAN.G + ' 60']);
    expect(host.logRecords.some((record) => record.message.includes('opening the map to ask the game'))).toBe(true);
  });

  it('asks once: a frame still unnamed after the map press becomes the question', async () => {
    const { world, host } = makeWorld({ observation: dungeonLikeUnknown, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();   // the map press
    await world.tick();   // still unnamed: the question

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
    expect(host.logRecords.filter((record) => record.message.includes('opening the map to ask the game'))).toHaveLength(1);
  });

  it('a map that opens after the press settles the frame without a question', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: dungeonLikeUnknown, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();                  // the map press
    perceiver.observation = dungeonMap;  // the game answered with its map
    clock.advance(500);
    await world.tick();

    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);
    expect(actuator.calls.slice(0, 2)).toEqual(['key ' + SCAN.G + ' 60', 'key ' + SCAN.G + ' 60']);
  });

  it('says "cooling down" once per cooldown, not once per tick', async () => {
    const { world, host, clock } = makeWorld({
      observation: unknownButSeen,
      cfg: { escalateSettleMs: 1_000, escalateTimeoutMs: 100 },
    });
    await started(world, host);

    await world.tick();
    clock.advance(1_100);
    await world.tick();                  // asks; the question times out and the cooldown opens

    clock.advance(10);
    await world.tick();
    clock.advance(10);
    await world.tick();

    const cooling = () => host.logRecords.filter((record) => record.message.includes('cooling down'));
    expect(cooling()).toHaveLength(1);
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
    // loop does not wait for a QTE bar that may never appear; it taps the loot card at its measured
    // centre — not a second opener click — and re-perceives.
    perceiver.observation = { screen: 'loot', atMs: 200, confidence: 1 };
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784', 'tap 960,510']);
    expect(world.isRunning()).toBe(true);
  });

  it('does not take the prompt still on screen as the answer to the 打开 click', async () => {
    const { world, host, actuator, clock } = makeWorld({ observation: chestPrompt });
    await started(world, host);

    // The prompt's 打开 is tapped once. The screen has not changed: the click has not landed yet,
    // so it is one command in flight, not an answer — the live run re-tapped 11 times in a second.
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    clock.advance(100);
    await world.tick();
    clock.advance(300);
    await world.tick();

    expect(actuator.calls).toEqual(['tap 955,858']);
    expect(world.isRunning()).toBe(true);
  });

  it('takes the panel arriving as the answer to the 打开 click and clicks a card', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: chestPrompt });
    await started(world, host);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    // 4.6 s after the click — the live panel arrived in 4.6–8 s — the panel is the screen. It is the
    // answer to the prompt click, and the same tick may choose a card from it.
    perceiver.observation = openerPanel;
    clock.advance(4_600);
    await world.tick();

    expect(actuator.calls).toEqual(['tap 955,858', 'tap 963,784']);
    expect(
      host.logRecords.some((record) => record.message.includes('open-chest took effect: the screen is now chest-open')),
    ).toBe(true);
  });

  it('waits through the chest-opening animation instead of escalating the unnamed frame', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({
      observation: chestPrompt,
      // A regression asks the model; the test then fails on the pushed event instead of waiting.
      // The settle window is production's: the animation below is the measured 4.1 s of unnamed
      // frames, and the window is what must cover it.
      cfg: { escalateSettleMs: WVD_DEFAULTS.escalateSettleMs, escalateTimeoutMs: 25 },
    });
    await started(world, host);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    // The click starts the opening animation, which no perceiver names for 4.1 s; the panel comes
    // after. The opener press is in flight, so the unnamed frame is a transition, not a question.
    perceiver.observation = unknownButSeen;
    for (const advance of [100, 1_000, 1_000, 1_000, 1_000]) {
      clock.advance(advance);
      await world.tick();
      expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(0);
    }

    perceiver.observation = openerPanel;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858', 'tap 963,784']);
  });

  it('gives up a click the panel never answered, and does not click again until the farm advances', async () => {
    const { world, host, actuator, clock } = makeWorld({
      observation: openerPanel,
      cfg: { openerPanelTimeoutMs: 50 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The panel never changed: the click is recorded failed and not re-sent. The wait is the
    // opener's own key, not the map's: the live panel arrived 4.6–8 s after the click, long after
    // `mapOpenTimeoutMs`. The stall clock owns what happens next, as for any other command.
    clock.advance(100);
    await world.tick();
    expect(
      host.logRecords.some((record) => record.level === 'warn' && record.message.includes('the opener panel never answered the click')),
    ).toBe(true);

    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);
  });

  it('clicks a panel that arrives after the give-up, because the screen change is progress', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({
      observation: chestPrompt,
      cfg: { openerPanelTimeoutMs: 50 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    // The prompt never answers: the click is given up and recorded failed.
    clock.advance(100);
    await world.tick();
    expect(host.logRecords.some((record) => record.message.includes('never answered the click'))).toBe(true);

    // The panel arrives later. A screen the loop did not produce is the farm advancing, so the
    // failed latch must not survive it — the live bug held `intent: open-chest` for 25 s instead.
    perceiver.observation = openerPanel;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858', 'tap 963,784']);
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

// ---------------------------------------------------------------------------------------------
// The reroll's re-engage (2026-10-31)
// ---------------------------------------------------------------------------------------------

/**
 * After a QTE cancel the party stands on the chest's own tile and the game returns to the 3-D view;
 * the 打开 prompt only comes back once the party steps off. The cancel is therefore a command whose
 * answer is `chest-prompt`, with one while-waiting step — and while it waits the route policy must
 * not run: on a 3-D frame its answer is `open-map`, i.e. a G pressed over the chest.
 */
describe('the chest re-engage after a QTE cancel', () => {
  it('cancels, steps off the chest once, and routes nothing until the prompt answers', async () => {
    const { world, host, perceiver, actuator, cfg } = makeWorld({
      observation: qteBar,
      timing: async () => ({ ok: false, reason: 'reroll' }),
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toContain('tap 738,758');
    expect(actuator.calls.some((call) => call.startsWith('key '))).toBe(false);
    expect(host.logRecords.some((record) => record.message.includes('chest QTE reroll 1/5'))).toBe(true);

    // The game is back in the 3-D view: the re-engage goes out once — S (away) then W (back in) — and
    // the route gets no turn. One step off alone is silent live (2026-10-31, two 10 s attempts).
    perceiver.observation = { screen: 'dungeon', atMs: 200, confidence: 1 };
    await world.tick();
    expect(actuator.calls.filter((call) => call.startsWith('key '))).toEqual([
      `key 31 ${cfg.hazardEscapeHoldMs}`,
      `key 17 ${cfg.hazardEscapeHoldMs}`,
    ]);
    const afterStep = actuator.calls.length;

    // A second 3-D tick: no second step, and no G.
    await world.tick();
    expect(actuator.calls.length).toBe(afterStep);

    // The prompt answers the cancel; the ordinary policy now presses 打开.
    perceiver.observation = { screen: 'chest-prompt', atMs: 300, confidence: 1 };
    await world.tick();
    expect(actuator.calls.at(-1)).toBe('tap 955,858');
  });
});


// ---------------------------------------------------------------------------------------------
// The orientation: resume the farm from any screen (contracts §10, the goal form)
// ---------------------------------------------------------------------------------------------

describe('the orientation', () => {
  const CLIMB = '0c0280000d6ff0000d7ffc0008c37000';
  const FARM = '000000007f3ffe007ffeff00220bb600';
  const STRANGER = 'ffffffffffffffffffffffffffffffff';

  const mapWith = (titleKey: string, icons: readonly MapIcon[] = []): Observation => ({
    screen: 'dungeonmap',
    atMs: 100,
    confidence: 0.9,
    map: { floorTitle: 'B1F', titleKey, player: { x: 19, y: 21 }, origin: { x: 960, y: 540 }, icons },
  });
  const townView: Observation = { screen: 'town', atMs: 100, confidence: 0.9 };

  const goalDefinition = (options: { climb?: boolean } = {}): TaskDefinition => ({
    id: 'ffxi-4f',
    label: '[Chest] FFXI 4F',
    floor: { titleKey: FARM },
    goal: {
      site: 'ffxi-gcn',
      zone: 'ffxi-zone3',
      ...(options.climb === false
        ? {}
        : { climb: { from: CLIMB, script: { timeoutMs: 60_000, steps: [{ op: 'wait' as const, ms: 1 }] } } }),
    },
    exit: { timeoutMs: 1_000, steps: [{ op: 'tap' as const, at: [1, 2] as const }] },
  });
  /** The loop's view of a goal task: the orientation descriptor, and a script recorder. */
  function goalTask(definition = goalDefinition()): { task: SessionTask; calls: string[] } {
    const calls: string[] = [];
    const task: SessionTask = {
      enter: async () => {
        calls.push('enter');
        return { ok: true, steps: 0, ms: 0 };
      },
      runScript: async (name) => {
        calls.push(name);
        return { ok: true, steps: 1, ms: 1 };
      },
      abort: () => {},
      orient: { goal: definition.goal!, floor: definition.floor.titleKey },
    };
    return { task, calls };
  }

  /** The two presses of openMap, as the fake actuator records them. */
  const GG = ['key ' + SCAN.G + ' 60', 'key ' + SCAN.G + ' 60'];

  it('resumes from inside the dungeon: no entry runs, and the map is opened to read the floor', async () => {
    const { task, calls } = goalTask();
    const { world, host, actuator } = makeWorld({ observation: dungeonView, task });
    await started(world, host);

    // A scripted entry would have stopped at its own expect-town; a goal task never runs one.
    expect(world.isRunning()).toBe(true);
    expect(calls).toEqual([]);

    await world.tick();
    expect(actuator.calls).toEqual(GG);
  });

  it('travels: to the site from town or the map, to the zone from Dungeon Select', async () => {
    const cases: ReadonlyArray<readonly [Observation, string]> = [
      [townView, 'ffxi-gcn'],
      [{ screen: 'worldmap', atMs: 100, confidence: 0.9 }, 'ffxi-gcn'],
      [{ screen: 'dungeon-select', atMs: 100, confidence: 0.9 }, 'ffxi-zone3'],
    ];
    for (const [screen, to] of cases) {
      const { task } = goalTask();
      const { world, host, travelCalls } = makeWorld({ observation: screen, task });
      await started(world, host);

      await world.tick();
      expect(travelCalls, screen.screen).toEqual([to]);
    }
  });

  it('farms as soon as the map shows the farm floor', async () => {
    const { task } = goalTask();
    const farm = mapWith(FARM, [{ kind: 'chest', at: CHEST }]);
    const { world, host, actuator, travelCalls } = makeWorld({ observation: farm, task });
    await started(world, host);

    await world.tick();
    expect(travelCalls).toEqual([]);
    expect(actuator.calls).toEqual(walkCalls(mapOf(farm), CHEST));
  });

  it('climbs from the stair floor, then hands the walk to the loop', async () => {
    const { task, calls } = goalTask();
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: mapWith(CLIMB), task });
    await started(world, host);

    await world.tick();
    expect(calls).toEqual(['climb']);
    expect(actuator.calls).toEqual([]);

    // The climb's last press closes the map and starts a game-driven walk: the loop commands nothing
    // until the party stands. The first named frame that is not the climb's screen (dungeon) closes
    // the load window the climb opened.
    perceiver.observation = dungeonView;
    clock.advance(600);
    await world.tick();
    expect(actuator.calls).toEqual([]);

    clock.advance(5_100);
    const farm = mapWith(FARM, [{ kind: 'chest', at: CHEST }]);
    perceiver.observation = farm;
    await world.tick();
    // Arrival released the walk and the same tick found the farm floor: the first farm command.
    expect(actuator.calls).toEqual(walkCalls(mapOf(farm), CHEST));
  });

  it('stops on a floor it has no measured way off, before pressing anything', async () => {
    const { task } = goalTask();
    const { world, host, actuator } = makeWorld({ observation: mapWith(STRANGER), task });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(false);
    const stopped = host.pushed.find((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped?.event.text).toContain('neither the farm floor');
  });

  it('never abandons a chest: a prompt during the orientation is the route that finishes it', async () => {
    const { task } = goalTask();
    const { world, host, actuator, travelCalls } = makeWorld({ observation: chestPrompt, task });
    await started(world, host);

    await world.tick();
    expect(travelCalls).toEqual([]);
    expect(actuator.calls).toHaveLength(1);
  });

  it('does not stop on the black frame a travel lands on', async () => {
    // Live 2026-11-02: the travel to 北穿幽冥城 returned when the world map left, the next frame was
    // the load's fade (unknown at confidence 0), and the session classifier stopped a run that had
    // just arrived. The settle window watches that load instead of asking about it.
    const { task } = goalTask();
    const { world, host, perceiver, clock, travelCalls } = makeWorld({ observation: townView, task });
    await started(world, host);

    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn']);

    perceiver.observation = { screen: 'unknown', atMs: 100, confidence: 0 } as Observation;
    clock.advance(500);
    await world.tick();
    expect(world.isRunning()).toBe(true);

    // The window is a wait, not a shield: the first named frame closes it and the loop acts at once.
    clock.advance(500);
    perceiver.observation = { screen: 'dungeon-select', atMs: 100, confidence: 0.9 } as Observation;
    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn', 'ffxi-zone3']);
  });

  it('retries the world-map travel once, then stops with the reason', async () => {
    const { task } = goalTask();
    const { world, host, travelCalls } = makeWorld({
      observation: townView,
      task,
      travelResult: { ok: false, reason: 'location-not-found', detail: 'not in view' },
    });
    await started(world, host);

    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn']);
    expect(world.isRunning()).toBe(true);

    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn', 'ffxi-gcn']);
    expect(world.isRunning()).toBe(false);
  });

  it('re-orients after the exit script instead of running a scripted entry', async () => {
    const definition = goalDefinition();
    const { task, calls } = goalTask(definition);
    const { world, host, perceiver, travelCalls } = makeWorld({
      // A farm floor with no chest left: the route next move is the exit.
      observation: mapWith(FARM),
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 2 },
    });
    await started(world, host);

    await world.tick();
    expect(calls).toEqual(['exit']);

    // The exit script ends in town; the next cycle must orient back in, not run an entry.
    perceiver.observation = townView;
    await world.tick();
    expect(calls).not.toContain('enter');
    expect(travelCalls).toEqual(['ffxi-gcn']);
  });
});

// ---------------------------------------------------------------------------------------------
// A chest the party cannot walk to (operator rule, 2026-11-02)
// ---------------------------------------------------------------------------------------------

describe('a chest the party cannot walk to', () => {
  const near: Point = { x: 14, y: 18 };
  const far: Point = { x: 10, y: 10 };
  const twoChests: Observation = {
    screen: 'dungeonmap',
    atMs: 100,
    confidence: 0.9,
    map: {
      floorTitle: 'B1F',
      titleKey: '0001c00003e6c00003efe00003874000',
      player: { x: 19, y: 21 },
      origin: { x: 960, y: 540 },
      icons: [{ kind: 'chest', at: near }, { kind: 'chest', at: far }],
    },
  };

  it('skips it, aims at the next chest, and leaves when none is left', async () => {
    const { world, host, actuator, clock } = makeWorld({ observation: twoChests });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(walkCalls(mapOf(twoChests), near));
    clock.advance(100);
    await world.tick(); // the stillness baseline

    // The party never moves. The first refusal is retried on the settled map, not acted on.
    clock.advance(5_100);
    await world.tick();
    expect(actuator.calls).toEqual([...walkCalls(mapOf(twoChests), near), ...walkCalls(mapOf(twoChests), near)]);

    // The second refusal makes the cell unreachable in the same tick: the next walk is the other chest.
    clock.advance(100);
    await world.tick();
    clock.advance(5_100);
    await world.tick();
    expect(actuator.calls.slice(-3)).toEqual(walkCalls(mapOf(twoChests), far));
    expect(host.logRecords.some((line) => line.message.includes('trying once more'))).toBe(true);
    expect(host.logRecords.some((line) => line.message.includes('skipping it this cycle'))).toBe(true);
  });

  it('skips the cell at once when the tile raises no 自動移動 element, and then leaves', async () => {
    // The walk refuses as soon as the game raises no element (2026-11-02): no five-second wait, no
    // pressed L, and the farm moves on to the other chest in the next tick.
    const { world, host, actuator } = makeWorld({
      observation: twoChests,
      moveResult: { ok: false, reason: 'timeout', detail: 'the tile raised no 自動移動 element' },
    });
    await started(world, host);

    for (let index = 0; index < 5; index += 1) await world.tick();

    // Each chest is refused twice before it is skipped: the first refusal is often the map's fade,
    // and the operator's rule is to claim every chest that is available. With both skipped, the farm
    // leaves by the exit.
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
    const skips = host.logRecords.filter((line) => line.message.includes('cannot be walked to'));
    expect(skips.filter((line) => line.message.includes('trying once more'))).toHaveLength(2);
    expect(skips.filter((line) => line.message.includes('skipping it this cycle'))).toHaveLength(2);
    expect(skips[0]!.message).toContain('the tile raised no 自動移動 element');
  });
});
