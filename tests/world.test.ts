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
 * - the escalation is one `pushEvent` with `trigger:'flush'`, `tags:['snapshot']` and the judged
 *   frame's two blobs (JPEG for the model, lossless PNG for the ledger), and it ends in the answer,
 *   the timeout or a cancel — never in a second question;
 * - the three tools answer with prose receipts and refuse what they must.
 */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, LogLevel, Logger, ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { decodePng } from '../src/perception/ledger.ts';
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
import { acceptChestPrompt, cancelQte, DISARM_SCAN, dismissLoot, pressBattleAuto, pressBattleSpeed, reenterChest, tapLoot } from '../src/actions/chest.ts';
import { closeCharacterPage } from '../src/actions/heal.ts';
import { timeQte, type QteTimer, type QteTimingOptions } from '../src/actions/qte.ts';
import { WVD_DEFAULTS, type WvdConfigSection } from '../src/config.ts';
import { MAX_PRESS_HOLD_MS } from '../src/contracts.ts';
import { routePolicy } from '../src/policy/route.ts';
import { createTaskPolicy } from '../src/tasks/policy.ts';
import { tileOnScreen } from '../src/perception/map.ts';
import { classify } from '../src/policy/session.ts';
import { WvdWorld, type WvdSession } from '../src/world.ts';
import { PARTY_PANEL_COLLAPSE } from '../src/policy/recover.ts';

const CTX = {} as ToolCallContext;
/** The Windows set-1 codes the World's receipts report; the commands' own are in `actions/`. */
const SCAN = { W: 0x11, R: 0x13, F: 0x21, G: 0x22, ESC: 0x01 };

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
  /**
   * The frame this source serves instead of the stub. The stub declares 1920×1080 but hands back one
   * pixel (perception is scripted, so no test reads them); a test about the escalation's **evidence**
   * needs pixels that agree with the frame, because the evidence is now encoded from them.
   */
  script: ((atMs: number) => Frame) | null = null;
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
    if (this.script) return this.script(this.captures * 100);
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
const characterPageView: Observation = { screen: 'character-page', atMs: 100, confidence: 1 };

/**
 * One heal, the way the loop runs it since 2026-11-08: the party card from the walking view, then the
 * page's three steps (sparkle, 恢复, close) from **page** frames, then the close verified by the page
 * leaving. The loop sends one step per tick, so each tap needs its own frames — a composite would land
 * all four taps in one tick (and, in a battle, on the battle screen).
 */
interface TickableWorld { tick(): Promise<unknown> }
interface RecordingHost { logRecords: ReadonlyArray<{ message: string }> }

/** Tick until the loop logs `text` once more than it had, or fail: the heal's start is a log line. */
async function tickUntilLogged(
  world: TickableWorld,
  host: RecordingHost,
  clock: { advance(ms: number): void },
  text: string,
  limit = 24,
): Promise<void> {
  const count = (): number => host.logRecords.filter((record) => record.message.includes(text)).length;
  const before = count();
  for (let index = 0; index < limit; index += 1) {
    clock.advance(500);
    await world.tick();
    if (count() > before) return;
  }
  throw new Error('never logged: ' + text);
}

async function runHeal(
  world: TickableWorld,
  perceiver: { observation: Observation },
  clock: { advance(ms: number): void },
): Promise<void> {
  perceiver.observation = characterPageView;
  for (let index = 0; index < 6; index += 1) { clock.advance(1_000); await world.tick(); }
  perceiver.observation = dungeonView;
  for (let index = 0; index < 4; index += 1) { clock.advance(1_000); await world.tick(); }
}

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
const combatView: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: true, autoOn: false };

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

/** The skill panel's 確定 as the live client drew it 2026-11-07 22:16 (located, not assumed). */
const PANEL_CONFIRM_AT: Point = { x: 1_053, y: 1_006 };

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
  /** The aim cannot be read on this run: the walk is never given a point (live 2026-11-06). */
  blindAim?: boolean;
  /**
   * The opener list, the member reader (contracts §11) and the panel locator. The locator defaults to
   * the live client's measured 確定; a test that needs the panel absent or moved passes its own.
   */
  battle?: {
    readonly openers: readonly BattleOpener[];
    readonly reader: BattleMemberReader;
    readonly locateConfirm?: (frame: Frame) => Promise<Point | null>;
  };
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
  /** The battle's cast, split into its two operations (contracts §11, the sequence). */
  const slotCalls: string[] = [];
  /** The heal's steps, in the order the loop sent them (2026-11-08: one step per frame). */
  const healSteps: string[] = [];
  const confirmCalls: string[] = [];
  const escCalls: string[] = [];
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
    battle: options.battle === undefined
      ? undefined
      : {
        openers: options.battle.openers,
        reader: options.battle.reader,
        locateConfirm: options.battle.locateConfirm ?? (async () => PANEL_CONFIRM_AT),
      },
    classify,
    timing: options.timing ?? timeQte,
    commands: {
      // `main.ts` reads `pressHoldMs` per command; the harness does the same, so a configured hold
      // that the loop ignored would show up here (Important 2).
      openMap: () => openMap(actuator, cfg.pressHoldMs),
      // The aim `main.ts` gives: the tick's own map read, at the marker it placed the cell on. The
      // harness has no frame source for the popup, so the walk keeps its measured-rise path.
      automoveToTile: (cell) => Promise.resolve(options.moveResult ?? automoveToTile(actuator, cell, cfg.pressHoldMs, {
        locate: async () => {
          if (options.blindAim === true) return null;
          const observation = perceiver.observation;
          return observation.screen === 'dungeonmap' ? tileOnScreen(mapOf(observation), cell) : null;
        },
      })),
      automoveToExit: () => automoveToExit(actuator, cfg.pressHoldMs),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      tapLoot: () => tapLoot(actuator),
      dismissLoot: () => dismissLoot(actuator),
      // The heal's taps are pinned in tests/heal.test.ts; the world tests only need the command.
      healStep: async (step: string) => { healSteps.push(step); return { ok: true }; },
      // The page's close is one measured tap, so the world tests can see it.
      closeCharacterPage: () => closeCharacterPage(actuator),
      tapPoint: (at) => actuator.tap(at),
      restAtInn: (at) => actuator.tap(at),
      battleSpeed: () => pressBattleSpeed(actuator),
      battleAuto: () => pressBattleAuto(actuator),
      // The opener's taps are pinned in tests/battle-opener.test.ts; the world tests need the calls.
      battleSlot: async (opener) => { slotCalls.push(opener.name); return { ok: true }; },
      // The cast's resolving press takes the **located** point (perception/battle-panel.ts), so the
      // harness records where it would have pressed, not which member cast it.
      battleConfirm: async (at) => { confirmCalls.push(`${at.x},${at.y}`); return { ok: true }; },
      escape: async () => { escCalls.push('esc'); return { ok: true }; },
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
    slotCalls,
    healSteps,
    confirmCalls,
    escCalls,
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

  it('re-arms a command that changed nothing after the window, so a slow frame cannot freeze the loop', async () => {
    // Live 2026-11-08 13:30 (after a battle, the game drawing at 21 FPS): open-map was given up at a
    // 4 667 ms wait, the map opened *after* the give-up, and the route's next ask was refused on the
    // same screen epoch — 53 s frozen on a legible frame. A fresh ask after this window is the route
    // re-deriving the intent from the frame in hand, not a replay of the failed press.
    const { world, host, actuator, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);

    await world.tick();                                   // one frame of the view: not yet a decision
    await world.tick();                                   // the second frame: the route may command
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);

    clock.advance(3_100);                                 // mapOpenTimeoutMs passes, nothing changed
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]); // refused, not re-sent

    clock.advance(4_000);                                 // still inside the re-arm window
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);

    clock.advance(5_000);                                 // past it: ask again from this frame
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`, `key ${SCAN.G} 60`]);
  });

  it('sends a command that changed nothing again once the farm advances', async () => {
    // The guard is per screen epoch: a map that never opened is not pressed twice, but a readout that
    // moves is the farm advancing, and a command may be sent again from it.
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);

    await world.tick();                                   // one frame of the view: not yet a decision
    expect(actuator.calls).toEqual([]);
    await world.tick();                                   // the second frame: the route may command
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);

    // mapOpenTimeoutMs passes with the 3-D view still up: the map command changed nothing.
    clock.advance(3_100);
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);

    // The farm advances: the map is up and the party moved. The guard clears, and the loop acts on
    // the new readout instead of staying silent.
    const moved = { ...dungeonMap, map: { ...mapOf(dungeonMap), player: { x: 12, y: 18 } } };
    perceiver.observation = moved;
    // The walk is a paced operation now (2026-11-07): the map's first frame is a transition, the
    // second is stable, and the pace must have passed since the previous operation.
    clock.advance(800);
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([
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
      return {
      ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809, restSettled: true,
      pressAtMs: 0, ackAtMs: 0, delayActualMs: 0, inputMs: null, tauS: null,
    };
    };
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    expect(seen).toHaveLength(1);
    // The sub-loop's own bound comes from config, not from the caller's guess. The pass window is
    // the policy's judgement: the World hands the loop a `choosePass` carrying the configured floor,
    // and the loop itself no longer has a lead floor to pass in.
    expect(seen[0]!.budgetMs).toBe(WVD_DEFAULTS.qteSubLoopMs);
    // A bar with no measured park is planned with the measured prior slide, not with a switch.
    expect(seen[0]!.carryTauS).toBeCloseTo(WVD_DEFAULTS.qtePriorCarryTauS, 9);
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

  it('re-rolls a bar the stop band refuses', async () => {
    // 2026-11-06: the hard 150 ms window floor is gone; the one "can this pass succeed" test is the
    // stop band. A pass the band refuses for the whole sub-loop is `no-reachable-zone`, and the
    // World cancels the bar (a free cancel) to let the panel pick another opener.
    const timing: QteTimer = async () => ({ ok: false, reason: 'no-reachable-zone' });
    const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();

    expect(host.logRecords.some((record) => record.message.includes('chest QTE reroll 1/5'))).toBe(true);
    // The cancel is the bar's round ✕ — a tap, and no disarm key was pressed.
    expect(actuator.calls.some((call) => call.startsWith('tap'))).toBe(true);
    expect(actuator.calls.some((call) => call.startsWith('key '))).toBe(false);
    expect(world.isRunning()).toBe(true);
  });

  it('gives up on a bar the band refuses when the reroll budget is already spent', async () => {
    const timing: QteTimer = async () => ({ ok: false, reason: 'no-reachable-zone' });
    const { world, host } = makeWorld({ observation: qteBar, timing, cfg: { maxRerolls: 0 } });
    await started(world, host);

    await world.tick();

    expect(host.logRecords.some((record) => record.message.includes('no pass fit a zone to 95 %'))).toBe(true);
    expect(host.logRecords.some((record) => record.message.includes('chest QTE reroll'))).toBe(false);
    expect(world.isRunning()).toBe(true);
  });

  it('taps the loot card at its measured point, once per pace', async () => {
    const loot: Observation = { screen: 'drop-item-claim', atMs: 120, confidence: 0.6 };
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: loot });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(100);
    await world.tick();                 // inside both the 400 ms interval and the 700 ms pace
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(700);
    await world.tick();                 // past the pace and the configured interval: one more tap
    expect(actuator.calls).toEqual(['tap 960,510', 'tap 960,510']);

    perceiver.observation = dungeonMap; // the card left; the route moves on
    clock.advance(100);
    await world.tick();
    expect(world.isRunning()).toBe(true);
  });

  it('names the drop it claims, when the line was recorded', async () => {
    // The reader carries the drop's own name (operator, 2026-11-06: a drop the World has not seen is
    // named after the game's line and recorded), so the run's log says what it claimed.
    const loot: Observation = {
      screen: 'drop-item-claim',
      atMs: 120,
      confidence: 0.6,
      item: '10,000拜恩纸币',
    };
    const { world, host, actuator } = makeWorld({ observation: loot });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap 960,510']);
    expect(
      host.logRecords.some((record) => record.message.includes('collected the loot card (10,000拜恩纸币)')),
    ).toBe(true);
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
        ? {
          ok: true, v: 0, atMs: 0, target: 0, tapX: 0, restX: null, restSettled: false,
          pressAtMs: 0, ackAtMs: 0, delayActualMs: 0, inputMs: null, tauS: null,
        }
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

  it('feeds the bar\'s measured carry and input leg into the next QTE call', async () => {
    // Operator rule 2026-11-05: the park's carry time and the press's round trip become the next
    // plan's terms for this bar; the config is only the prior before anything is measured.
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      await options.press();
      return {
        ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809, restSettled: true,
        pressAtMs: 0, ackAtMs: 64, delayActualMs: 120, inputMs: 60, tauS: 0.2,
      };
    };
    const { world, host, clock } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    await world.tick();
    expect(seen).toHaveLength(1);
    // A bar with no park yet is planned with the measured prior slide; the park replaces it below.
    expect(seen[0]!.carryTauS).toBeCloseTo(WVD_DEFAULTS.qtePriorCarryTauS, 9);
    // The band is as honest as the carry's source (calibrated 2026-11-06): the prior is the ten parks'
    // ±0.08 s of slide (45 px), the bar's own park narrows it to 12 px.
    expect(seen[0]!.carrySpreadPx).toBe(45);
    expect(seen[0]!.latencySpreadMs).toBe(12);

    clock.advance(100);
    await world.tick();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.carryTauS).toBeCloseTo(0.2, 6);
    expect(seen[1]!.latencyMs).toBeCloseTo(64, 6);
    expect(seen[1]!.carrySpreadPx).toBe(12);
  });

  it('stops pressing a bar that will not resolve, after the spin guard, with one warning', async () => {
    // The 2026-10-31 bar was pressed 224 times in 4.5 min, every press a refusal (2026-11-06 data).
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      return { ok: false, reason: 'bar-gone' };
    };
    const { world, host } = makeWorld({ observation: qteBar, timing });
    await started(world, host);

    for (let tick = 0; tick < 10; tick += 1) await world.tick();

    // QTE_MAX_TRIES_PER_BAR: six sub-loops on one bar, then the stall clock's.
    expect(seen).toHaveLength(6);
    const warned = host.logRecords.filter((line) => line.message.includes('leaving it to the stall clock'));
    expect(warned).toHaveLength(1);
    expect(world.isRunning()).toBe(true);
  });

  it('sends no press in a dry run, even on the bar', async () => {
    const seen: QteTimingOptions[] = [];
    const timing: QteTimer = async (options) => {
      seen.push(options);
      await options.press();
      return {
      ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809, restSettled: true,
      pressAtMs: 0, ackAtMs: 0, delayActualMs: 0, inputMs: null, tauS: null,
    };
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

    // The bar ended with the panel still up: the click is not outstanding, so the route chooses. The
    // returning panel's first frame is a transition for the pacer (the pace itself passed long ago),
    // so the card click waits for the panel to hold (operator rule 2026-11-03).
    perceiver.observation = openerPanel;
    clock.advance(800);
    await world.tick();                 // the first frame of the panel: not stable yet
    expect(actuator.calls).toEqual(['tap 963,784']);
    clock.advance(100);
    await world.tick();                 // the panel has held for two frames
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
    ]);
  });

  it('does not press on the battle\'s first frames: the settle window holds the sequence', async () => {
    // Operator rule 2026-11-04: the battle is turn-based, so the loop waits for a frame that has
    // stopped moving. The old branch pressed ~200 ms after the battle appeared, while the panel drew.
    const { world, host, actuator, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 1_000, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                              // the battle's first frame
    expect(actuator.calls).toEqual([]);
    clock.advance(999);
    await world.tick();
    expect(actuator.calls).toEqual([]);
    clock.advance(1);
    await world.tick();                              // settled: the first operation
    expect(actuator.calls).toEqual(['tap 1231,708']);
  });

  it('casts a listed member\'s opener as two paced operations, before auto', async () => {
    // Operator rules: the ACTIVE member is filtered against the configured list (2026-11-02), and a
    // battle is turn-based — the cast is the slot and the resolving press as two operations, one per
    // pace, never two at the same time (2026-11-04).
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, actuator, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                              // the first read: one frame, not confirmed
    expect(slotCalls).toEqual([]);
    await world.tick();                              // the same name again: the slot
    expect(slotCalls).toEqual(['爱丽丝']);
    expect(confirmCalls).toEqual([]);
    expect(actuator.calls).toEqual([]);

    clock.advance(999);
    await world.tick();                              // inside the pace: nothing
    expect(confirmCalls).toEqual([]);

    clock.advance(1);
    await world.tick();                              // the resolving press
    expect(confirmCalls).toEqual(['1053,1006']);

    clock.advance(1_000);
    await world.tick();                              // 自動
    expect(actuator.calls).toEqual(['tap 1231,708']);
  });

  it("presses the panel's confirm on an unnamed frame: the cast it owes is not a click into an unknown screen", async () => {
    // Live 2026-11-07 22:00:11: the slot tap was sent, the skill panel (拉巴迪奥斯的秘术, 取消 / 確定)
    // came up over the battle, and the screen read 'unknown'. The route's own rule — an unnamed screen
    // is a wait, never a click — turned every tick into a wait, so the battle branch below never ran
    // and the confirm the sequence still owed was never dispatched: 48 s on the panel, run stopped.
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                              // the first read: one frame, not confirmed
    await world.tick();                              // the same name again: the slot
    expect(slotCalls).toEqual(['爱丽丝']);

    perceiver.observation = refusedPanel;            // the skill panel: above a blank frame, below the act floor
    clock.advance(1_000);
    await world.tick();                              // the owed confirm, on the panel's own frame
    expect(confirmCalls).toEqual(['1053,1006']);
    expect(host.logRecords.some((line) => line.message.includes('確定'))).toBe(true);
  });

  it('still waits on an unnamed frame when the battle owes no operation', async () => {
    // The exception is the cast's own second half, not every unnamed frame: before the slot is sent,
    // the route's rule stands and nothing is pressed into a frame the loop cannot name.
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                              // one frame of the turn card, not confirmed
    perceiver.observation = refusedPanel;            // the screen is lost before the command phase
    clock.advance(1_000);
    await world.tick();
    expect(slotCalls).toEqual([]);
    expect(confirmCalls).toEqual([]);
  });
  it('presses the confirm only once the panel is located, and at the point it is located', async () => {
    // Operator rule 2026-11-07: *read the panel and tap the confirmation once you see it.* The panel
    // moves between draws, so a fixed point lands on its body (the same panel was at y 975–1035 on
    // 2026-11-05 and y 976–1037 on 2026-11-07 and the fixed press resolved neither). The locator
    // answers the frame; null is "the panel is not drawn yet" and nothing is pressed.
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    let panel: Point | null = null;
    const battle = {
      openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }],
      reader,
      locateConfirm: async () => panel,
    };
    const { world, host, perceiver, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);
    await world.tick();                              // the first read
    await world.tick();                              // the slot

    perceiver.observation = refusedPanel;            // the panel's frame, but the locator has not seen it
    clock.advance(1_000);
    await world.tick();
    expect(confirmCalls).toEqual([]);
    expect(host.logRecords.some((line) => line.message.includes('not on this frame'))).toBe(true);

    panel = { x: 1_048, y: 1_046 };                  // a later frame draws it, forty pixels lower
    clock.advance(1_000);
    await world.tick();
    expect(confirmCalls).toEqual(['1048,1046']);
  });

  it('does nothing but auto when the ACTIVE member is not on the opener list', async () => {
    const reader: BattleMemberReader = { readActiveMember: async () => '本杰明' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, actuator, slotCalls, confirmCalls } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                        // the first read: one frame is not a decision
    expect(actuator.calls).toEqual([]);
    await world.tick();                        // the same name again: confirmed, the default runs
    expect(slotCalls).toEqual([]);
    expect(confirmCalls).toEqual([]);
    expect(actuator.calls).toEqual(['tap 1231,708']);
    expect(host.logRecords.some((line) => line.message.includes('not on the opener list'))).toBe(true);
  });

  it('reads the turn card, and says "not on the list", once — not once per tick', async () => {
    // The read is the step's own evidence, so it happens when the sequence is at the cast, not on
    // every frame of the pace. A log said once per tick is the console flood this pins away.
    let reads = 0;
    const reader: BattleMemberReader = { readActiveMember: async () => { reads += 1; return '本杰明'; } };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const offBoth: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: false, autoOn: false };
    const speedOnView: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: true, autoOn: false };
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: offBoth, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                       // 倍速 is off: its press comes first, nothing is read
    expect(reads).toBe(0);
    expect(actuator.calls).toEqual(['tap 691,708']);

    perceiver.observation = speedOnView;
    clock.advance(1_000);
    await world.tick();                       // 倍速 on: the first readable frame of two
    expect(reads).toBe(1);
    await world.tick();                       // the same answer again: confirmed, and not on the list
    expect(reads).toBe(2);
    const noted = () => host.logRecords.filter((record) => record.message.includes('not on the opener list')).length;
    expect(noted()).toBe(1);

    for (let index = 0; index < 5; index += 1) {
      clock.advance(100);
      await world.tick();
    }
    expect(reads).toBe(2);
    expect(noted()).toBe(1);
  });

  it('a battle entered with 自動 on is disengaged for the cast, then handed back to auto', async () => {
    // Operator rule 2026-11-04: 自動 off if it is on, use the opener skill once, then 自動 on. An auto
    // battle draws no command phase, so the card cannot be read and the cast cannot be sent until it
    // is off; the last step turns the battle back over to auto.
    let reads = 0;
    const reader: BattleMemberReader = { readActiveMember: async () => { reads += 1; return '爱丽丝'; } };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const autoView: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: false, autoOn: true };
    const { world, host, actuator, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: autoView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                       // 倍速 first
    expect(actuator.calls).toEqual(['tap 691,708']);
    expect(reads).toBe(0);

    perceiver.observation = { ...autoView, speedOn: true };
    clock.advance(1_000);
    await world.tick();                       // 自動 off (the same toggle point)
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);
    expect(reads).toBe(0);
    expect(host.logRecords.some((line) => line.message.includes('turned 自動 off'))).toBe(true);

    perceiver.observation = { ...autoView, speedOn: true, autoOn: false };
    clock.advance(1_000);
    await world.tick();                       // the command phase is the loop's: the first read
    expect(reads).toBe(1);
    expect(slotCalls).toEqual([]);
    await world.tick();                       // the same name again: confirmed, the slot
    expect(reads).toBe(2);
    expect(slotCalls).toEqual(['爱丽丝']);

    clock.advance(1_000);
    await world.tick();                       // the resolving press
    expect(confirmCalls).toEqual(['1053,1006']);

    clock.advance(1_000);
    await world.tick();                       // 自動 back on
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708', 'tap 1231,708']);
  });

  it('casts the opener only in the first battle of the first cycle, and leaves the rest to 自動', async () => {
    // Operator rule 2026-11-04, refined: the disengage + cast belongs to the first battle of the first
    // cycle. Every later battle only needs 自動 on — no cast, and no turn-card read.
    let reads = 0;
    const reader: BattleMemberReader = { readActiveMember: async () => { reads += 1; return '爱丽丝'; } };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, actuator, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    // The first battle: the cast, then 自動.
    await world.tick();                        // the first read
    expect(slotCalls).toEqual([]);
    await world.tick();                        // the same name again: the slot
    expect(slotCalls).toEqual(['爱丽丝']);
    clock.advance(1_000);
    await world.tick();                        // the resolving press
    expect(confirmCalls).toEqual(['1053,1006']);
    clock.advance(1_000);
    await world.tick();                        // 自動 on
    expect(actuator.calls).toEqual(['tap 1231,708']);

    // The battle leaves, then a second one starts with 自動 off: only 自動 is pressed.
    perceiver.observation = dungeonView;
    clock.advance(1_000);
    await world.tick();
    clock.advance(1_000);
    await world.tick();
    perceiver.observation = combatView;
    clock.advance(1_000);
    await world.tick();
    expect(reads).toBe(2);                     // both reads belonged to the first battle
    expect(slotCalls).toEqual(['爱丽丝']);
    expect(confirmCalls).toEqual(['1053,1006']);
    expect(actuator.calls.filter((call) => call === 'tap 1231,708').length).toBe(2);
  });

  it('the next battle starts from its own settle window', async () => {
    // Review Focus 4: the sequence is not merely re-created, its settle window is respected too.
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 1_000, battleStepMs: 1_000 },
    });
    await started(world, host);
    const presses = () => actuator.calls.filter((call) => call === 'tap 1231,708').length;

    await world.tick();                        // battle A's first frame
    expect(presses()).toBe(0);
    clock.advance(1_000);
    await world.tick();                        // battle A's settle passed
    expect(presses()).toBe(1);

    // The battle leaves (two named frames of another mode), then a new one starts.
    perceiver.observation = dungeonView;
    clock.advance(1_000);
    await world.tick();
    clock.advance(1_000);
    await world.tick();
    perceiver.observation = combatView;
    clock.advance(1_000);
    await world.tick();                        // battle B's first frame: its own settle
    expect(presses()).toBe(1);
    clock.advance(1_000);
    await world.tick();                        // B's settle passed: a fresh first operation
    expect(presses()).toBe(2);
  });

  it('treats an unreadable ACTIVE member as a miss, and waits for the panel before auto', async () => {
    // Live 2026-11-03 02:07: the first combat frame answers nothing — the party panel is drawn a beat
    // after the battle screen. The cast waits for a readable panel, and auto is never pressed while the
    // read is owed: auto would take the command phase the cast needs.
    const reader: BattleMemberReader = { readActiveMember: async () => null };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, actuator, slotCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();
    expect(slotCalls).toEqual([]);
    expect(actuator.calls).toEqual([]);
    expect(host.logRecords.some((line) => line.message.includes('not readable yet'))).toBe(true);

    // The opener's timeout closes: the cast is given up and auto takes the battle.
    clock.advance(10_100);
    await world.tick();
    expect(slotCalls).toEqual([]);
    expect(actuator.calls).toEqual(['tap 1231,708']);
    expect(host.logRecords.filter((line) => line.message.includes('opener was given up')).length).toBe(1);
  });

  it('casts the opener once the panel becomes readable', async () => {
    // The 02:07 failure, fixed: null on the battle's first frame, 爱丽丝 on a later one.
    let answer: string | null = null;
    const reader: BattleMemberReader = { readActiveMember: async () => answer };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, slotCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();
    expect(slotCalls).toEqual([]);

    answer = '爱丽丝';
    clock.advance(500);
    await world.tick();                       // one readable frame: not confirmed yet
    expect(slotCalls).toEqual([]);
    await world.tick();                       // the same name again: the cast
    expect(slotCalls).toEqual(['爱丽丝']);
  });

  it('presses auto again while the battle is still waiting at a command phase', async () => {
    // Operator rule 2026-11-02: auto is the battle's fallback — pressed until it is on. A press
    // swallowed while the opener's skill resolves must not leave the fight to the stall clock.
    const { world, host, actuator, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 1231,708']);

    clock.advance(1_000);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 1231,708', 'tap 1231,708']);
  });

  it('stops pressing auto at the configured attempts, and says so once', async () => {
    // `autoBattleEnableAttempts` (contracts §8.5) is the cap the config already declared: three tries
    // by default, and a fourth is not a war of attrition on the button.
    const { world, host, actuator, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 0, battleStepMs: 1_000, autoBattleEnableAttempts: 3 },
    });
    await started(world, host);
    for (let index = 0; index < 7; index += 1) {
      clock.advance(1_000);
      await world.tick();
    }
    const presses = actuator.calls.filter((call) => call === 'tap 1231,708').length;
    expect(presses).toBe(3);
    expect(host.logRecords.filter((record) => record.message.includes('自動 was pressed 3 times')).length).toBe(1);
  });

  it('re-arms the battle sequence for the next battle', async () => {
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);
    await world.tick();
    expect(actuator.calls.filter((call) => call === 'tap 1231,708').length).toBe(1);

    // The battle leaves (two named frames of another mode), then a new one starts: fresh counts.
    perceiver.observation = dungeonView;
    clock.advance(1_000);
    await world.tick();
    clock.advance(1_000);
    await world.tick();
    perceiver.observation = combatView;
    clock.advance(1_000);
    await world.tick();
    expect(actuator.calls.filter((call) => call === 'tap 1231,708').length).toBe(2);
  });

  it('puts 倍速 first, then the opener, then 自動', async () => {
    // Operator rule 2026-11-03, the battle order: speed → opener → auto → finish. Both are toggles,
    // so each press waits for the frame to say its toggle is off.
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const offBoth: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: false, autoOn: false };
    const speedOnView: Observation = { screen: 'combat', atMs: 100, confidence: 0.9, speedOn: true, autoOn: false };
    const { world, host, actuator, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: offBoth, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                       // 1. multi-speed
    expect(actuator.calls).toEqual(['tap 691,708']);
    expect(slotCalls).toEqual([]);

    perceiver.observation = speedOnView;      // the game shows 倍速 on
    clock.advance(1_000);
    await world.tick();                       // 2. the first read
    expect(slotCalls).toEqual([]);
    await world.tick();                       // the same name again: the slot
    expect(slotCalls).toEqual(['爱丽丝']);

    clock.advance(1_000);
    await world.tick();                       // the resolving press
    expect(confirmCalls).toEqual(['1053,1006']);

    clock.advance(1_000);
    await world.tick();                       // 3. 自動
    expect(actuator.calls).toEqual(['tap 691,708', 'tap 1231,708']);
  });

  it('casts the opener once even when the auto press is retried', async () => {
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);
    for (let index = 0; index < 8; index += 1) {
      clock.advance(1_000);
      await world.tick();
    }
    expect(slotCalls).toEqual(['爱丽丝']);
    expect(confirmCalls).toEqual(['1053,1006']);
  });

  it('puts the heal before the next command in the cycle pipeline', async () => {
    // Operator rule 2026-11-02, priority 1: safe before battle and after it. The battle sets the heal;
    // the next 3-D view tick spends it and sends nothing else, so the party is healed before the loop
    // asks it to open the map for the next chest. Priorities 2-4 (claim, skip, rest) come after.
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: combatView, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);
    const healed = () => host.logRecords.filter((record) => record.message.includes('healed the party')).length;

    await world.tick();
    const fightCalls = actuator.calls.length;
    expect(fightCalls).toBeGreaterThan(0);

    // The battle leaves: the fight stays in flight until its screen answers (arrival), then the heal
    // starts on that tick — one step per frame, and no route command rides along with it.
    perceiver.observation = dungeonView;
    const healStarts = (): number => host.logRecords.filter((record) => record.message.includes('the heal starts')).length;
    let callsAtHeal = -1;
    for (let index = 0; index < 14 && callsAtHeal < 0; index += 1) {
      clock.advance(500);
      await world.tick();
      if (healStarts() === 1) callsAtHeal = actuator.calls.length;
    }
    expect(healStarts()).toBe(1);
    expect(callsAtHeal).toBe(fightCalls);

    // The heal's four steps, each from the frame that names what it acts on; the close is verified by
    // the page leaving (operator rule 2026-11-07: only the next order, from the current stable frame).
    await runHeal(world, perceiver, clock);
    expect(healed()).toBe(1);

    // The heal owns the tick until a stable frame proves its page is gone, so the tick after it clears
    // that gate and the route's map press is the one after.
    clock.advance(500);
    await world.tick();
    clock.advance(500);
    await world.tick();
    expect(actuator.calls.slice(fightCalls)).toEqual([`key ${SCAN.G} 60`]);
  });

  it('abandons the heal when a battle takes the frame, and dispatches the battle that tick', async () => {
    // The defect the operator named (2026-11-08): the loop was healing when a battle interrupted it. The
    // composite tapped card -> sparkle -> 恢复 -> close blind, so the taps after the interruption landed
    // on the battle screen, and the verify then held the tick 11 s. The sequence drops the heal instead,
    // and the frame in hand is the order.
    const { world, host, actuator, perceiver, clock, healSteps } = makeWorld({ observation: dungeonView });
    await started(world, host);

    perceiver.observation = combatView;
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await world.tick();                                   // the card, from the walking view
    expect(healSteps).toEqual(['card']);

    // The battle takes the frame: the heal is dropped and no further heal step is attempted on it.
    perceiver.observation = combatView;
    clock.advance(500);
    const calls = actuator.calls.length;
    await world.tick();

    expect(host.logRecords.some((record) => record.message.includes('the heal was interrupted by combat'))).toBe(true);
    expect(healSteps).toEqual(['card']);

    // …and the battle is the loop's from that tick: its own settle, then its press.
    clock.advance(1_000);
    await world.tick();
    expect(actuator.calls.length).toBeGreaterThan(calls);
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
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await runHeal(world, perceiver, clock);
    expect(healed()).toBe(1);

    // The flag is spent: more view ticks do not heal again.
    for (let index = 0; index < 6; index += 1) { clock.advance(500); await world.tick(); }
    expect(healed()).toBe(1);

    // A chest sets it again: loot, then the view.
    perceiver.observation = { screen: 'drop-item-claim', atMs: 100, confidence: 1 };
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await runHeal(world, perceiver, clock);
    expect(healed()).toBe(2);
  });

  it('does not start the heal while the chest still owns the game mode', async () => {
    // Live 2026-11-09 04:53-04:56: the chest's post-loot animation interleaves `chest-opening` and the
    // walking view; the heal started on one of the walking frames, opened the page into the animation,
    // was abandoned by it, and the page-close branch then fought the animation (open/close, repeating).
    // A modal mode is left only by two named frames of the next one, and that is the gate.
    const { world, host, perceiver, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);
    const starts = (): number => host.logRecords.filter((record) => record.message.includes('the heal starts')).length;

    perceiver.observation = { screen: 'drop-item-claim', atMs: 100, confidence: 1 };
    for (let index = 0; index < 2; index += 1) { clock.advance(100); await world.tick(); }
    // The chest's last screen closes its interval; one walking frame is not the chest being over.
    perceiver.observation = dungeonView;
    clock.advance(100);
    await world.tick();
    expect(starts()).toBe(0);
    // The second walking frame leaves the modal mode: the heal may start now.
    clock.advance(100);
    await world.tick();
    for (let index = 0; index < 20 && starts() === 0; index += 1) { clock.advance(500); await world.tick(); }
    expect(starts()).toBe(1);
  });

  it('waits out an unnamed page after the card instead of giving up on it', async () => {
    // Live 2026-11-09 03:33: the card opened the page **under the battle's XP/level-up animation**, the
    // frames in between read unknown 0.20, and the heal's 12 s bound spent itself on them — the heal gave
    // up and the World's page-close branch then closed the page it had just opened (0 heals in the run).
    // An unnamed frame is not the heal's time: it must still be waiting when the page is finally named.
    const { world, host, perceiver, clock } = makeWorld({ observation: dungeonView });
    await started(world, host);
    const healed = (): number => host.logRecords.filter((record) => record.message.includes('healed the party')).length;
    const starts = (): number => host.logRecords.filter((record) => record.message.includes('the heal starts')).length;

    perceiver.observation = combatView;
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await world.tick();                                   // the card, from the walking view

    // The page is open under an animation no reader can name, for longer than the heal's own bound.
    perceiver.observation = { screen: 'unknown', atMs: 100, confidence: 0.2 };
    for (let index = 0; index < 14; index += 1) { clock.advance(1_000); await world.tick(); }
    expect(starts()).toBe(1);
    expect(host.logRecords.some((record) => record.message.includes('gave up'))).toBe(false);

    // The page is named: the heal resumes from the step it owed and completes.
    perceiver.observation = characterPageView;
    for (let index = 0; index < 6; index += 1) { clock.advance(1_000); await world.tick(); }
    perceiver.observation = dungeonView;
    for (let index = 0; index < 4; index += 1) { clock.advance(1_000); await world.tick(); }
    expect(healed()).toBe(1);
  });

  it('heals after every Nth completed battle, and not before', async () => {
    // The operator's matrix (2026-11-09): healAfterBattles = 2 is "every second battle", chests off.
    const { world, host, perceiver, clock } = makeWorld({
      observation: combatView,
      cfg: { healAfterBattles: 2, healAfterChests: 0, battleSettleMs: 0 },
    });
    await started(world, host);
    const healed = (): number => host.logRecords.filter((record) => record.message.includes('healed the party')).length;

    await world.tick();                                   // the first battle
    perceiver.observation = dungeonView;
    for (let index = 0; index < 6; index += 1) { clock.advance(500); await world.tick(); }
    expect(healed()).toBe(0);

    perceiver.observation = combatView;                   // the second battle completes the count
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await runHeal(world, perceiver, clock);
    expect(healed()).toBe(1);
  });

  it('re-arms the heal after a give-up instead of losing the debt', async () => {
    // The regression that made every heal fix a new one: the flag was cleared before the sequence ran, so
    // a give-up left the party unhealed for good and the recovery closed the page. The debt now survives
    // one give-up and re-arms after the backoff.
    // The stall clock is the test's to keep out of the way: the give-up takes 38 s of unnamed frames,
    // which is past a default 30 s "no progress" question the run does not ask here.
    const { world, host, perceiver, clock } = makeWorld({ observation: dungeonView, cfg: { stallStopSeconds: 300 } });
    await started(world, host);
    const starts = (): number => host.logRecords.filter((record) => record.message.includes('the heal starts')).length;

    perceiver.observation = combatView;
    clock.advance(100);
    await world.tick();
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    await world.tick();                                   // the card

    // The page never comes: unnamed frames until the sequence's hard wall-clock bound gives up. Ticks
    // stop at the give-up itself: an unnamed frame with no heal on it is the classifier's question, and
    // the test is about the debt, not the escalation.
    perceiver.observation = { screen: 'unknown', atMs: 100, confidence: 0.2 };
    const gaveUp = (): boolean => host.logRecords.some((record) => record.message.includes('the debt re-arms'));
    for (let index = 0; index < 70 && !gaveUp(); index += 1) { clock.advance(1_000); await world.tick(); }
    expect(gaveUp()).toBe(true);

    // The view is back: the debt is still owed, so a fresh attempt starts.
    perceiver.observation = dungeonView;
    await tickUntilLogged(world, host, clock, 'the heal starts');
    expect(starts()).toBe(2);
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
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);
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
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);
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
// The character page: a menu the loop finishes (operator rule 2026-11-03)
// ---------------------------------------------------------------------------------------------

describe('the character page', () => {
  it('never opens the map from a page frame, or from a frame that has not held', async () => {
    // Live 2026-11-07 23:39 / 2026-11-08 00:00: the route pressed open-map, the frame was the page, the
    // page block closed it, and the route asked again — twenty seconds a turn, for minutes.
    const page: Observation = { screen: 'character-page', atMs: 100, confidence: 1 };
    const { world, host, actuator } = makeWorld({ observation: page });
    await started(world, host);
    for (let index = 0; index < 6; index += 1) await world.tick();
    expect(actuator.calls.filter((call) => call === 'key ' + SCAN.G + ' 60')).toEqual([]);
  });

  it('closes a page, and the next frame proves it', async () => {
    // Operator rule 2026-11-03: after open and heal there shall be a close of the character panel, so
    // go back to the dungeon. The page is a named screen now, so the close is verified, not hoped for.
    const page: Observation = { screen: 'character-page', atMs: 100, confidence: 1 };
    const { world, host, actuator, perceiver, clock, escCalls } = makeWorld({ observation: page });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 699,1012']);

    // The page is still up: one tap per pace (700 ms), and the cap says so once.
    for (let index = 0; index < 4; index += 1) { clock.advance(800); await world.tick(); }
    expect(actuator.calls.filter((call) => call === 'tap 699,1012')).toHaveLength(3);
    expect(host.logRecords.filter((line) => line.message.includes('did not close after 3 taps')).length).toBe(1);
    // A page that takes no close is a lost screen, and the measured way out is one Esc — not the
    // stall clock (live 2026-11-07 22:34: three presses returned ok, the page stayed, and the loop
    // waited ~45 s for the escalation to do what this press does at once).
    // The cap's way out goes through the command seam: the World's session field is not the tick's.
    expect(escCalls).toEqual(['esc']);

    // The page left: nothing more is sent.
    perceiver.observation = dungeonView;
    clock.advance(200);
    await world.tick();
    expect(actuator.calls.filter((call) => call === 'tap 699,1012')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// The game's mode: which pipeline owns the screen (operator rule 2026-11-03)
// ---------------------------------------------------------------------------------------------

describe('the mode owns the screens inside it', () => {
  const asked = (host: FakeHost) => host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck');

  it('does not ask about the unnamed frames inside a battle', async () => {
    // The measured case: a member died, the revive QTE draws (testdata/battle-2026-11-02/revive-qte.jpg,
    // unknown 0.80) and the loop used to spend a 90 s question on a battle it was already in.
    const { world, host, perceiver, clock } = makeWorld({ observation: combatView });
    await started(world, host);
    await world.tick();                        // the command phase: battle

    perceiver.observation = unknownButSeen;    // the revive QTE / a skill's resolution
    for (let index = 0; index < 6; index += 1) {
      clock.advance(500);
      await world.tick();
    }
    expect(asked(host)).toHaveLength(0);

    perceiver.observation = combatView;        // the battle carries on
    clock.advance(500);
    await world.tick();
    expect(asked(host)).toHaveLength(0);
  });

  it('does not ask about the unnamed frames inside a chest', async () => {
    const { world, host, perceiver, clock } = makeWorld({ observation: chestPrompt });
    await started(world, host);
    await world.tick();                        // the prompt: chest

    perceiver.observation = unknownButSeen;    // the lid's animation
    for (let index = 0; index < 6; index += 1) {
      clock.advance(500);
      await world.tick();
    }
    expect(asked(host)).toHaveLength(0);
  });

  it('still asks about an unnamed frame outside any mode', async () => {
    const { world, host } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 20 } });
    await started(world, host);

    await world.tick();

    expect(asked(host)).toHaveLength(1);
  });

  it('reports the mode in the console status', async () => {
    const { world, host } = makeWorld({ observation: combatView });
    await started(world, host);
    await world.tick();

    const status = await world.invoke('wvd-console', 'status');
    if (!status.ok) throw new Error('the status call failed');
    expect((status.value as { mode?: string }).mode).toBe('battle');
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
    // nobody answered, so the loop took its own recovery: an unnamed screen is one Esc
    expect(actuator.calls).toEqual([`key ${SCAN.ESC} 60`]);
    // exactly one question, counting pushes: the hourly budget is the loop's
    expect(world.escalationsThisHour()).toBe(1);
  });

  it('files the frame the reader judged, not a second capture', async () => {
    // The evidence rule (2026-11-08): a second capture is a different instant, and twice a saved frame
    // showed the page an `Esc` had just opened while the loop had escalated a correct dungeon. The
    // question now carries the pixels of the frame the verdict was taken on — filed, lossless, beside
    // it — so a triage script re-classifies the same picture the loop saw.
    const source = new ScriptedSource();
    source.script = (atMs) => ({
      atMs,
      width: 8,
      height: 8,
      toRgba: async () => {
        const data = new Uint8Array(8 * 8 * 4);
        for (let index = 0; index < data.length; index += 4) {
          data[index] = 0x42;
          data[index + 3] = 255;
        }
        return { data, width: 8, height: 8 };
      },
    });
    const { world, host, actuator, snapshotCalls } = makeWorld({
      source,
      observation: unknownButSeen,
      cfg: { escalateTimeoutMs: 20, escalationImageWidth: 8 },
    });
    await started(world, host);

    await world.tick();

    const stuck = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toHaveLength(1);
    // No second capture: the evidence did not come from the window.
    expect(snapshotCalls).toEqual([]);
    const blobs = stuck[0]!.event.blobs!;
    expect(blobs.map((blob) => blob.mime)).toEqual(['image/jpeg', 'image/png']);
    const pngBytes = blobs[1]!.bytes;
    if (pngBytes === undefined) throw new Error('the lossless blob carries no bytes');
    const png = decodePng(Buffer.from(pngBytes));
    expect([png.width, png.height]).toEqual([8, 8]);
    expect(Array.from(png.data.subarray(0, 4))).toEqual([0x42, 0, 0, 255]);
    // The fallback is unchanged: an unnamed frame is one Esc.
    expect(actuator.calls).toEqual([`key ${SCAN.ESC} 60`]);
  });

  it('raises the main character\'s death to Coo once, and presses nothing', async () => {
    // Operator rule 2026-11-05: the death is Coo's decision (close the game and the PC?). There is no
    // recovery module, and the escalation's fallback is a wait: a death cutscene is not a screen to
    // press into.
    const dead: Observation = { screen: 'main-character-dead', atMs: 100, confidence: 0.9 };
    const { world, host, actuator } = makeWorld({ observation: dead, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();
    const stuck = host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck');
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.event.text).toContain('Question:');
    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(true);

    await world.tick();                        // the same death: one question, not one per tick
    expect(host.pushed.filter((pushed) => pushed.event.type === 'wvd.stuck')).toHaveLength(1);
  });

  it('stops the session on a death when stopOnDeath is set (the unattended run)', async () => {
    // The operator's farm run (2026-11-05) wants the stop, not a question nobody answers: the death
    // ends the session with the frame attached, and nothing is pressed.
    const dead: Observation = { screen: 'main-character-dead', atMs: 100, confidence: 0.9 };
    const { world, host, actuator } = makeWorld({ observation: dead, cfg: { stopOnDeath: true, escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(world.isRunning()).toBe(false);
    expect(actuator.calls).toEqual([]);
    const note = host.pushed.find((pushed) => pushed.event.type === 'wvd.note');
    expect(note?.event.text).toContain('the main character died');
    expect(note?.event.blobs).toHaveLength(1);
    expect(host.pushed.some((pushed) => pushed.event.type === 'wvd.stopped')).toBe(true);
    expect(host.pushed.some((pushed) => pushed.event.type === 'wvd.stuck')).toBe(false);
  });

  it('stops on a party member\'s revive QTE after two frames, and asks nobody', async () => {
    // The revive QTE is a battle modal (2026-11-05): the first frame may be the modal still drawing,
    // the second is a member down. With stopOnDeath the session ends there; no ring is pressed.
    const revive: Observation = { screen: 'revive-qte', atMs: 100, confidence: 0.85 };
    const { world, host, actuator } = makeWorld({ observation: revive, cfg: { stopOnDeath: true, escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();
    expect(world.isRunning()).toBe(true);
    await world.tick();
    expect(world.isRunning()).toBe(false);
    expect(actuator.calls).toEqual([]);
    expect(host.pushed.some((pushed) => pushed.event.type === 'wvd.stuck')).toBe(false);
    const note = host.pushed.find((pushed) => pushed.event.type === 'wvd.note');
    expect(note?.event.text).toContain('a party member is down');
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
    expect(actuator.calls).toEqual(['key ' + SCAN.G + ' 60']);
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
    expect(actuator.calls.slice(0, 2)).toEqual(['key ' + SCAN.G + ' 60']);
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
    expect(actuator.calls).toEqual([`key ${SCAN.ESC} 60`]);
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

    expect(actuator.calls).toEqual([`key ${SCAN.ESC} 60`]);
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

    expect(actuator.calls).toEqual([`key ${SCAN.ESC} 60`]);
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
    expect(actuator.calls).toEqual([`key ${SCAN.G} 60`]);

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
    // the fallback is screen-chosen: an unnamed screen takes one Esc (policy/recover.ts)
    expect(late.text).toContain('pressed Esc once');
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
    // centre — not a second opener click — but the claim is a new operation and waits the pace since
    // the card click (operator rule 2026-11-03).
    perceiver.observation = { screen: 'drop-item-claim', atMs: 200, confidence: 1 };
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);
    clock.advance(800);
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
    // answer to the prompt click, but its first frame is a transition for the pacing primitive: the
    // card click follows on the frame that holds (operator rule 2026-11-03).
    perceiver.observation = openerPanel;
    clock.advance(4_600);
    await world.tick();

    expect(actuator.calls).toEqual(['tap 955,858']);
    expect(
      host.logRecords.some((record) => record.message.includes('open-chest took effect: the screen is now chest-open')),
    ).toBe(true);

    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858', 'tap 963,784']);
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
    await world.tick();                 // the panel's first frame: a transition to the pacer
    clock.advance(100);
    await world.tick();                 // stable: the card click
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
    // Its first frame is a transition: the card click follows on the frame that holds (pacing primitive).
    perceiver.observation = openerPanel;
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);
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
// The chest module is paced (operator rule 2026-11-03)
// ---------------------------------------------------------------------------------------------

/**
 * The operator's rule: *a tap is one primitive operation in game control; each has to be done with
 * stable frames or animations, with 0.5 to 1 second pacing.* `policy/pacing.ts` implements the
 * primitive and the World applies it to the chest's direct operations outside the QTE sub-loop — the
 * member card that chooses who opens the chest, and the loot taps that claim the item once the chest
 * opens (a trapped chest has the bar before it; an untrapped one goes straight to the loot).
 * The QTE itself is the timing sub-loop and keeps its own clock.
 */
describe('the chest module is paced', () => {
  it('does not click the opener card on the frame the panel arrives', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: chestPrompt });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    // The panel is the answer to 打开, but its first frame is a transition: the card click is one
    // operation and waits for the panel to hold for a second frame.
    perceiver.observation = openerPanel;
    clock.advance(4_600);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858']);

    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 955,858', 'tap 963,784']);
  });

  it('waits the pace between two card clicks, not only for the panel to hold', async () => {
    const timing: QteTimer = async () => ({ ok: false, reason: 'resolved' });
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: openerPanel, timing });
    await started(world, host);

    await world.tick();                 // the seeded session: the first card click
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The bar takes the screen 100 ms later, and the panel comes back 200 ms after the click: two
    // frames would allow a click on the panel's second frame, but one operation per pace has not
    // passed yet. This is the half the panel-appearance test alone does not pin.
    perceiver.observation = qteBar;
    clock.advance(100);
    await world.tick();
    perceiver.observation = openerPanel;
    clock.advance(200);
    await world.tick();                 // the panel's first frame: not stable yet
    expect(actuator.calls).toEqual(['tap 963,784']);
    clock.advance(100);
    await world.tick();                 // stable, but only 400 ms since the first click
    expect(actuator.calls).toEqual(['tap 963,784']);
    clock.advance(300);
    await world.tick();                 // 700 ms since the first click: the second card click is sent
    expect(actuator.calls).toEqual(['tap 963,784', 'tap 963,784']);
  });

  it('does not claim the loot on the frame the card click is answered', async () => {
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: openerPanel });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    // The loot card replaces the panel 100 ms later: claiming it is a new operation and the pace has
    // not passed. Without the pacer the loop tapped the card centre on that very frame.
    perceiver.observation = { screen: 'drop-item-claim', atMs: 200, confidence: 1 };
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784']);

    clock.advance(800);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 963,784', 'tap 960,510']);
  });

  it("paces the loot banner's continue arrow like any other tap", async () => {
    const loot: Observation = { screen: 'drop-item-claim', atMs: 120, confidence: 0.6 };
    const { world, host, actuator, clock } = makeWorld({
      observation: loot,
      cfg: { lootTapMax: 1, lootTapIntervalMs: 1 },
    });
    await started(world, host);

    await world.tick();                 // the card's one tap (lootTapMax = 1)
    expect(actuator.calls).toEqual(['tap 960,510']);

    // The banner is up and the tap interval has passed, but the pace has not: the arrow waits.
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510']);

    clock.advance(800);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510', 'tap 960,880']);
  });

  it('keeps a configured loot interval longer than the pace', async () => {
    const loot: Observation = { screen: 'drop-item-claim', atMs: 120, confidence: 0.6 };
    const { world, host, actuator, clock } = makeWorld({ observation: loot, cfg: { lootTapIntervalMs: 2_000 } });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(800);                 // past the pace, inside the configured 2 s interval
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510']);
    clock.advance(1_300);               // 2.1 s since the last tap: the interval has passed too
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,510', 'tap 960,510']);
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
      timing: async () => ({ ok: false, reason: 'no-reachable-zone' }),
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

  /** The one press of openMap (2026-11-08: the second was a walk order), as the fake records it. */
  const GG = ['key ' + SCAN.G + ' 60'];


  it('reads the harken menu: the named row when it is offered, 归还 when it is not', async () => {
    // Operator rule 2026-11-03: the harken's list is not fixed — it offers a floor only once that
    // floor's harken is reconstructed — so the climb reads the menu instead of assuming a layout.
    const definition: TaskDefinition = {
      ...goalDefinition(),
      goal: {
        site: 'ffxi-gcn',
        zone: 'ffxi-zone3',
        climb: {
          from: CLIMB,
          destination: '第四区-城内2F深处-',
          script: { timeoutMs: 60_000, steps: [{ op: 'wait' as const, ms: 1 }] },
        },
      },
    };
    const { task } = goalTask(definition);
    const rows = [
      { at: { x: 960, y: 484 }, label: '第一区-城外-' },
      { at: { x: 960, y: 556 }, label: '第二区-城内1F-' },
      { at: { x: 960, y: 628 }, label: '第四区-城内2F深处-' },
      { at: { x: 960, y: 700 }, label: '归还' },
    ];
    const menu: Observation = { screen: 'harken-menu', atMs: 100, confidence: 1, rows };
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: menu, task });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,628']);
    expect(host.logRecords.some((line) => line.message.includes('the harken offers 第四区-城内2F深处-'))).toBe(true);

    // The same menu on a harken that offers nothing but 归还: the World backs out, and the stair icon
    // is the way up.
    perceiver.observation = { ...menu, rows: [rows[3]!] };
    clock.advance(800);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,628', 'tap 960,700']);
    expect(host.logRecords.some((line) => line.message.includes('does not offer the farm floor'))).toBe(true);
  });

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
    // The farm floor's first frame is a transition to the pacer; the next one may walk (2026-11-07).
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual(walkCalls(mapOf(farm), CHEST));
  });

  it('stops on a floor it has no measured way off, after its patience and with the frame attached', async () => {
    // Operator rule 2026-11-03: a readable map without the 楼梯-门 icon is a perception miss on the first
    // few frames — the reader found the icon on the same floor and tile minutes earlier — so the World
    // re-reads for its patience and only then stops, leaving the frame as the evidence.
    const { task } = goalTask();
    const { world, host, actuator, clock } = makeWorld({ observation: mapWith(STRANGER), task });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual([]);
    expect(world.isRunning()).toBe(true);

    for (let index = 0; index < 25; index += 1) { clock.advance(200); await world.tick(); }

    expect(world.isRunning()).toBe(false);
    const note = host.pushed.find((pushed) => pushed.event.type === 'wvd.note');
    expect(note?.event.text).toContain('carries no 楼梯-门 icon');
    const stopped = host.pushed.find((pushed) => pushed.event.type === 'wvd.stopped');
    expect(stopped?.event.text).toContain('carries no 楼梯-门 icon');
  });

  it('does not let the orientation starve the battle panel: the owed confirm is pressed on its unnamed frame', async () => {
    // Live 2026-11-07 22:13: the session started inside the previous run's battle and was still
    // orienting; the skill panel read 'unknown', and the orientation's own wait returned the tick
    // before the route or the battle branch — so the confirm the sequence owed never went out: 45 s,
    // the stall clock stopped the run, and the press only landed after the recovery's Esc named the
    // screen again (22:14:20). A battle is not the orientation's business, even when no recogniser
    // names the frame the battle is drawing.
    const { task } = goalTask();
    const reader: BattleMemberReader = { readActiveMember: async () => '爱丽丝' };
    const battle = { openers: [{ name: '爱丽丝', slot: '左下' as const, target: 'enemy' as const }], reader };
    const { world, host, perceiver, slotCalls, confirmCalls, clock } = makeWorld({
      observation: combatView, task, battle, cfg: { battleSettleMs: 0, battleStepMs: 1_000 },
    });
    await started(world, host);

    await world.tick();                              // the first read of the turn card
    await world.tick();                              // the same name again: the slot
    expect(slotCalls).toEqual(['爱丽丝']);

    perceiver.observation = refusedPanel;            // the skill panel: unnamed, inside the battle
    clock.advance(1_000);
    await world.tick();                              // the owed confirm, not a wait for the floor
    expect(confirmCalls).toEqual(['1053,1006']);
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

    // The window is a wait, not a shield: the first named frame closes it and the loop acts — after the
    // pacing primitive sees that screen stable and the pace has passed (operator rule 2026-11-03).
    perceiver.observation = { screen: 'dungeon-select', atMs: 100, confidence: 0.9 } as Observation;
    clock.advance(800);
    await world.tick();                       // the first frame of the new screen: not stable yet
    clock.advance(800);
    await world.tick();                       // stable, and the pace has passed
    expect(travelCalls).toEqual(['ffxi-gcn', 'ffxi-zone3']);
  });

  it('retries the world-map travel once, then stops with the reason', async () => {
    const { task } = goalTask();
    const { world, host, travelCalls, clock } = makeWorld({
      observation: townView,
      task,
      travelResult: { ok: false, reason: 'location-not-found', detail: 'not in view' },
    });
    await started(world, host);

    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn']);
    expect(world.isRunning()).toBe(true);

    // The retry waits the pace: one operation at a time (operator rule 2026-11-03).
    clock.advance(800);
    await world.tick();
    expect(travelCalls).toEqual(['ffxi-gcn', 'ffxi-gcn']);
    expect(world.isRunning()).toBe(false);
  });

  it('does not read a long exit script as a stall', async () => {
    // Live 2026-11-05: the exit script took 48.7 s inside one tick, and the stall clock read that as
    // "nothing changed" and escalated the loop the moment the next cycle began. The script's own
    // screens and presses are progress, even though the loop cannot see them until it returns.
    const definition = goalDefinition();
    let clockRef: { advance(ms: number): void } | null = null;
    const task: SessionTask = {
      enter: async () => ({ ok: true, steps: 0, ms: 0 }),
      runScript: async (name) => {
        if (name === 'exit') clockRef?.advance(49_000);   // the script's own duration, real time
        return { ok: true, steps: 15, ms: name === 'exit' ? 49_000 : 1 };
      },
      abort: () => {},
      orient: { goal: definition.goal!, floor: definition.floor.titleKey },
    };
    const { world, host, perceiver, clock } = makeWorld({
      observation: mapWith(FARM),
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      // A stalled loop asks Coo; the timeout keeps the test from waiting on the question.
      cfg: { cycles: 2, escalateTimeoutMs: 25 },
    });
    clockRef = clock;
    await started(world, host);

    await world.tick();                        // the exit script, 49 s of it inside this tick
    expect(world.isRunning()).toBe(true);

    perceiver.observation = townView;
    clock.advance(800);
    await world.tick();
    clock.advance(800);
    await world.tick();
    expect(world.isRunning()).toBe(true);
    expect(host.pushed.filter((entry) => entry.event.type === 'wvd.stuck')).toEqual([]);
  });

  it('keeps the stage cursor when the game interrupts it, and finishes the stage after', async () => {
    // Operator rule 2026-11-05: a stage is one step per tick, so a battle (or the chest after it)
    // is the loop's to dispatch; the stage yields and resumes. An interruption is not a failure.
    const definition = goalDefinition();
    const screens: (string | null)[] = [];
    let interrupted = true;
    const task: SessionTask = {
      enter: async () => ({ ok: true, steps: 0, ms: 0 }),
      runScript: async (name, observation) => {
        screens.push(observation?.screen ?? null);
        if (interrupted) return { ok: false, step: 0, reason: 'interrupted', detail: 'combat' };
        return { ok: true, steps: 15, ms: 1, complete: true };
      },
      abort: () => {},
      orient: { goal: definition.goal!, floor: definition.floor.titleKey },
    };
    const { world, host, clock } = makeWorld({
      observation: mapWith(FARM),
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 1 },
    });
    await started(world, host);

    await world.tick();
    expect(screens).toEqual(['dungeonmap']);
    expect(world.isRunning()).toBe(true);

    interrupted = false;
    clock.advance(100);
    await world.tick();
    expect(screens).toEqual(['dungeonmap', 'dungeonmap']);
    // The stage completed on the second call, and with one cycle the session is done.
    expect(world.isRunning()).toBe(false);
  });

  it('keeps driving a stage on screens the route has no intent for', async () => {
    // The exit script walks through the Dungeon Select list and a harken menu, screens the route
    // answers with a wait. The stage in progress is still the tick's work (operator rule 2026-11-05),
    // or the loop would wait the stage to death at the first screen it does not own.
    const definition = goalDefinition();
    const screens: (string | null)[] = [];
    let complete = false;
    const task: SessionTask = {
      enter: async () => ({ ok: true, steps: 0, ms: 0 }),
      runScript: async (name, observation) => {
        screens.push(observation?.screen ?? null);
        if (name === 'exit' && !complete) return { ok: true, steps: 1, ms: 1, complete: false };
        return { ok: true, steps: 15, ms: 1, complete: true };
      },
      abort: () => {},
      orient: { goal: definition.goal!, floor: definition.floor.titleKey },
    };
    const { world, host, perceiver, clock } = makeWorld({
      observation: mapWith(FARM),
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 2 },
    });
    await started(world, host);

    await world.tick();                              // the route says exit: the stage starts
    expect(screens).toEqual(['dungeonmap']);

    // The Dungeon Select list: the route waits, the stage must not.
    perceiver.observation = { screen: 'dungeon-select', atMs: 200, confidence: 0.9 };
    clock.advance(200);
    await world.tick();
    expect(screens).toEqual(['dungeonmap', 'dungeon-select']);

    complete = true;
    clock.advance(200);
    await world.tick();
    expect(world.isRunning()).toBe(true);             // cycle 1 done; cycle 2 orients back in
    expect(screens).toEqual(['dungeonmap', 'dungeon-select', 'dungeon-select']);
  });

  it('re-orients after the exit script instead of running a scripted entry', async () => {
    const definition = goalDefinition();
    const { task, calls } = goalTask(definition);
    const { world, host, perceiver, travelCalls, clock } = makeWorld({
      // A farm floor with no chest left: the route next move is the exit.
      observation: mapWith(FARM),
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 2 },
    });
    await started(world, host);

    await world.tick();
    expect(calls).toEqual(['exit']);

    // The exit script ends in town; the next cycle must orient back in, not run an entry — after the
    // pacing primitive sees the town stable and the pace has passed.
    perceiver.observation = townView;
    clock.advance(800);
    await world.tick();
    clock.advance(800);
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
    const { world, host, actuator, clock } = makeWorld({
      observation: twoChests,
      moveResult: { ok: false, reason: 'timeout', detail: 'the tile raised no 自動移動 element' },
    });
    await started(world, host);

    // Each walk is a paced operation: the pace between two of them is real time (2026-11-07).
    for (let index = 0; index < 5; index += 1) {
      await world.tick();
      clock.advance(800);
    }

    // Each chest is refused twice before it is skipped: the first refusal is often the map's fade,
    // and the operator's rule is to claim every chest that is available. With both skipped, the farm
    // leaves by the exit.
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
    const skips = host.logRecords.filter((line) => line.message.includes('cannot be walked to'));
    expect(skips.filter((line) => line.message.includes('trying once more'))).toHaveLength(2);
    expect(skips.filter((line) => line.message.includes('skipping it this cycle'))).toHaveLength(2);
    expect(skips[0]!.message).toContain('the tile raised no 自動移動 element');
  });

  it('does not mark a chest unreachable when the walk could not be aimed', async () => {
    // Live 2026-11-06 02:05 (`t-mw3veimb-ppbm9u`): the map read that aimed the tap was stale, every tap
    // landed three cells off, and two reachable chests were put on the unreachable list and left behind.
    // A walk nobody could aim is no evidence about the cell, so it is retried, never skipped.
    const { world, host, actuator, clock } = makeWorld({ observation: twoChests, blindAim: true });
    await started(world, host);

    await world.tick();
    clock.advance(800);
    await world.tick();

    // Two walks were attempted, neither tapped a point, and nothing was skipped or exited.
    expect(actuator.calls).toEqual([`key ${SCAN.R} 60`, `key ${SCAN.R} 60`]);
    expect(host.logRecords.some((line) => line.message.includes('the walk was not aimed'))).toBe(true);
    expect(host.logRecords.some((line) => line.message.includes('cannot be walked to'))).toBe(false);
    expect(host.logRecords.some((line) => line.message.includes('skipping it this cycle'))).toBe(false);
    expect(world.isRunning()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The cycle's rest at the inn (operator rule 2026-11-06)
// ---------------------------------------------------------------------------------------------

describe("the cycle's rest", () => {
  const FARM = '000000007f3ffe007ffeff00220bb600';
  const INN_AT = { x: 916, y: 488 };
  const village: Observation = { screen: 'town', atMs: 100, confidence: 0.9 };
  const farmMap: Observation = {
    screen: 'dungeonmap',
    atMs: 100,
    confidence: 0.9,
    map: { floorTitle: 'B1F', titleKey: FARM, player: { x: 19, y: 21 }, origin: { x: 960, y: 540 }, icons: [] },
  };

  function restTask(timeoutMs: number): { task: SessionTask; definition: TaskDefinition } {
    const definition: TaskDefinition = {
      id: 'ffxi-4f',
      label: '[Chest] FFXI 4F',
      floor: { titleKey: FARM },
      goal: { site: 'ffxi-gcn', zone: 'ffxi-zone3' },
      exit: { timeoutMs: 1_000, steps: [{ op: 'tap' as const, at: [1, 2] as const }] },
      rest: { at: INN_AT, timeoutMs },
    };
    const task: SessionTask = {
      enter: async () => ({ ok: true, steps: 0, ms: 0 }),
      runScript: async () => ({ ok: true, steps: 15, ms: 1, complete: true }),
      abort: () => {},
      orient: { goal: definition.goal!, floor: definition.floor.titleKey },
      rest: definition.rest,
    };
    return { task, definition };
  }

  it('taps the town\'s inn control and waits for the visit before counting the cycle', async () => {
    // The exit script only brings the party back to the town; the cycle ends asleep at the inn
    // (operator rule 2026-11-06: the rest module reads the inn, the town is one measured tap away).
    const { task, definition } = restTask(90_000);
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: farmMap,
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 1 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls.at(-1)).toBe(`tap ${INN_AT.x},${INN_AT.y}`);
    expect(world.isRunning()).toBe(true);
    expect(host.logRecords.some((line) => line.message.includes('the cycle ends with a rest at the inn'))).toBe(true);

    // The inn dialog: the plug-in's, and the visit the gate waits for. The cycle must not count here.
    perceiver.observation = {
      screen: 'inn',
      atMs: 200,
      confidence: 0.9,
      rows: [{ at: { x: 1114, y: 606 }, label: '标准房' }],
    };
    // The plug-in is paced: two frames on the same screen, then one tap per pace.
    clock.advance(100);
    await world.tick();
    expect(actuator.calls.at(-1)).toBe(`tap ${INN_AT.x},${INN_AT.y}`);
    clock.advance(100);
    await world.tick();
    expect(world.isRunning()).toBe(true);
    expect(actuator.calls.at(-1)).toBe('tap 1114,606');

    // Back on the town's own screen: the rest is over, and this is where the cycle ends.
    perceiver.observation = village;
    clock.advance(100);
    await world.tick();
    expect(world.isRunning()).toBe(false);
    expect(host.logRecords.some((line) => line.message.includes('the rest is over; the cycle ends here'))).toBe(true);
  });

  it('counts the rest scene as the visit and advances it with its own mark', async () => {
    // Live 2026-11-07 00:44: the rest scene came up ~10 s after the inn tap and the gate never saw it —
    // the loop named it chest-opening 0.60, waited its full 90 s, called the cycle unrested, and the
    // scene then blocked the next cycle's orientation for 45 s.
    const { task, definition } = restTask(90_000);
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: farmMap,
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 1 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls.at(-1)).toBe(`tap ${INN_AT.x},${INN_AT.y}`);

    // The rest scene is the visit itself: one tap on its own continue mark advances it. The scene's
    // first frame is a transition to the pacer; the second may tap.
    perceiver.observation = { screen: 'inn-rest', atMs: 200, confidence: 0.75, at: { x: 794, y: 672 } };
    clock.advance(800);
    await world.tick();
    clock.advance(100);
    await world.tick();
    expect(actuator.calls.at(-1)).toBe('tap 794,672');
    expect(host.logRecords.some((line) => line.message.includes('the inn rest scene: advancing it'))).toBe(true);
    expect(world.isRunning()).toBe(true);

    // The town again: the rest is over and the cycle ends there, not 90 s later.
    perceiver.observation = village;
    clock.advance(800);
    await world.tick();
    expect(world.isRunning()).toBe(false);
    expect(host.logRecords.some((line) => line.message.includes('the rest is over; the cycle ends here'))).toBe(true);
    expect(host.logRecords.some((line) => line.message.includes('did not take the party'))).toBe(false);
  });

  it('ends the cycle unrested, with a warning, when the inn never takes the party', async () => {
    // One missed tap must not wedge an unattended run: the gate gives up after the task's own bound.
    const { task, definition } = restTask(5_000);
    const { world, host, actuator, perceiver, clock } = makeWorld({
      observation: farmMap,
      task,
      policy: createTaskPolicy(() => definition, routePolicy),
      cfg: { cycles: 1 },
    });
    await started(world, host);

    await world.tick();
    expect(actuator.calls.at(-1)).toBe(`tap ${INN_AT.x},${INN_AT.y}`);

    // The tap missed: the town stays town, and nothing else is sent while the gate holds the tick.
    perceiver.observation = village;
    clock.advance(1_000);
    await world.tick();
    expect(world.isRunning()).toBe(true);
    expect(actuator.calls).toEqual([`tap ${INN_AT.x},${INN_AT.y}`]);

    clock.advance(5_000);
    await world.tick();
    expect(world.isRunning()).toBe(false);
    expect(host.logRecords.some((line) => line.message.includes('the cycle ends unrested'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The rest town's inn (operator, 2026-11-06)
// ---------------------------------------------------------------------------------------------

describe("the game's one-off message box", () => {
  const box: Observation = { screen: 'message', atMs: 100, confidence: 0.85, at: { x: 960, y: 570 } };

  it('advances the box with one tap at the frame\'s own point, once per pace', async () => {
    const { world, host, actuator, clock } = makeWorld({ observation: box });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,570']);
    expect(host.logRecords.some((line) => line.message.includes('advanced the message box'))).toBe(true);

    // The pace is the pacing primitive's: a second tap waits for it.
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,570']);
    clock.advance(1_200);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,570', 'tap 960,570']);
    expect(world.isRunning()).toBe(true);
  });
});

describe('the knowledge base pages', () => {
  const records: Observation = {
    screen: 'ui-menu',
    atMs: 100,
    confidence: 0.93,
    page: 'records',
    title: '记录 (records menu)',
    exit: { x: 960, y: 870 },
  };

  it('closes a named page by the catalog exit, once per pace', async () => {
    const { world, host, actuator, clock } = makeWorld({ observation: records });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,870']);
    expect(host.logRecords.some((line) => line.message.includes('记录 (records menu): leaving by its exit'))).toBe(true);

    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,870']);
    clock.advance(1_200);
    await world.tick();
    expect(actuator.calls).toEqual(['tap 960,870', 'tap 960,870']);
    expect(world.isRunning()).toBe(true);
  });
});

describe("the inn's rest", () => {
  const roomList = [
    { at: { x: 1114, y: 549 }, label: '马房' },
    { at: { x: 1114, y: 606 }, label: '标准房' },
    { at: { x: 1114, y: 660 }, label: '返回' },
  ];
  const innView: Observation = { screen: 'inn', atMs: 100, confidence: 0.9, rows: roomList };

  it('takes the room the World is configured for', async () => {
    const { world, host, actuator } = makeWorld({ observation: innView, cfg: { innRoom: '马房' } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap 1114,549']);
    expect(host.logRecords.some((line) => line.message.includes('the inn: rest at 马房'))).toBe(true);
    expect(world.isRunning()).toBe(true);
  });

  it('takes 标准房 when the configured room is not offered', async () => {
    const { world, host, actuator } = makeWorld({ observation: innView, cfg: { innRoom: '上等房' } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap 1114,606']);
    expect(host.logRecords.some((line) => line.message.includes('the inn: rest at 标准房'))).toBe(true);
  });

  it('answers the rest confirmation once the visit has rested, instead of cancelling it', async () => {
    // Live 2026-11-06 02:03: the room tap committed the rest, the 确定 / 取消 confirmation came up, and
    // the rested branch backed out of it with 取消 — the party left the inn without sleeping.
    const { world, host, actuator, perceiver, clock } = makeWorld({ observation: innView });
    await started(world, host);

    await world.tick();
    // 标准房 is the configured default: the rest is committed here.
    expect(actuator.calls).toEqual(['tap 1114,606']);

    perceiver.observation = {
      screen: 'inn',
      atMs: 200,
      confidence: 0.9,
      rows: [
        { at: { x: 854, y: 675 }, label: '取消' },
        { at: { x: 1062, y: 675 }, label: '确定' },
      ],
    };
    clock.advance(1_200);
    await world.tick();

    // The confirmation belongs to the rest already committed, so it is answered, not cancelled.
    expect(actuator.calls).toEqual(['tap 1114,606', 'tap 1062,675']);
    expect(host.logRecords.some((line) => line.message.includes('the inn: confirm at 确定'))).toBe(true);
  });

  it('backs out of a room list with no room it can take, and warns once', async () => {
    const bare: Observation = {
      screen: 'inn',
      atMs: 100,
      confidence: 0.9,
      rows: [
        { at: { x: 1114, y: 549 }, label: '对话' },
        { at: { x: 1114, y: 660 }, label: '离开' },
      ],
    };
    const { world, host, actuator } = makeWorld({ observation: bare });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap 1114,660']);
    expect(host.logRecords.some((line) => line.message.includes('the inn: leave at 离开'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The recovery policy in the loop (operator, 2026-11-07)
// ---------------------------------------------------------------------------------------------

describe('the recovery', () => {
  /** The named page the stepper leaves by its own exit; the frame carries the measured point. */
  const records: Observation = {
    screen: 'ui-menu',
    atMs: 100,
    confidence: 0.93,
    page: 'records',
    title: '记录 (records menu)',
    exit: { x: 960, y: 870 },
  };
  const townView: Observation = { screen: 'town', atMs: 100, confidence: 0.9 };

  it('leaves a named page by its exit step, and records the intent', async () => {
    const { world, host, actuator } = makeWorld({ observation: records });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap 960,870']);
    expect(host.logRecords.some((line) => line.message.includes('记录 (records menu): leaving by its exit'))).toBe(true);
    // The page's close is now the recovery intent, not a private tap in the tick.
    const status = outcome(await tool(world, 'wvd_status').handler({}, CTX));
    expect(status.text).toContain('last intent recover');
  });

  it('collapses the party panel when the town page is the lost screen', async () => {
    // The route on town says exit, and the exit is the map's own command — but the town's world map
    // is behind the party panel (operator, 2026-11-07). The lost path is answered by the same
    // fallback the question's timeout takes: the collapse control, not a blind G.
    const { world, host, actuator } = makeWorld({ observation: townView });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['tap ' + PARTY_PANEL_COLLAPSE.x + ',' + PARTY_PANEL_COLLAPSE.y]);
    expect(host.logRecords.some((line) => line.message.includes('party panel'))).toBe(true);
  });

  it('takes one Esc on an unnamed screen when the question times out', async () => {
    // The stepper's answer for a screen nothing named: one Esc, the transition's own key. The map
    // press this used to take belongs to the dungeon-like frame, not to a lost screen.
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();

    expect(actuator.calls).toEqual(['key ' + SCAN.ESC + ' 60']);
    expect(host.logRecords.some((line) => line.message.includes('has no name'))).toBe(true);
  });

  it('records what an unnamed frame was, once the probe s Esc is answered', async () => {
    // Operator rule 2026-11-08: an unnamed frame is a probe, and its result is evidence. Live 14:02 a
    // HUD-less cutscene held the run for four minutes and the log could only say "unknown 0.20"; one Esc
    // returns the walking view, and that is what the frame was.
    const { world, host, perceiver, actuator, clock } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 25 } });
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual(['key ' + SCAN.ESC + ' 60']);
    expect(host.logRecords.some((line) => line.message.includes('it was dungeon'))).toBe(false);

    perceiver.observation = dungeonView;
    clock.advance(500);
    await world.tick();

    const answer = host.logRecords.find((line) => line.message.includes('one Esc cleared the unnamed frame'));
    expect(answer?.message).toContain('it was dungeon');
  });

  it('does not recover the same screen more than three times', async () => {
    // Six stalled reads of one page: the first three leave it, the rest wait for the stall clock.
    const { world, host, actuator, clock } = makeWorld({ observation: records });
    await started(world, host);

    for (let tick = 0; tick < 6; tick += 1) {
      await world.tick();
      clock.advance(1_200);
    }

    expect(actuator.calls).toEqual(['tap 960,870', 'tap 960,870', 'tap 960,870']);
    expect(host.logRecords.some((line) => line.message.includes('did not recover after 3 steps'))).toBe(true);
  });

  it('sends nothing of its own when the stepper is done: the existing fallback stands', async () => {
    // The 3-D view is a screen the route can act on, so the stepper is `done`: no tap, no Esc — the
    // loop's own fallback (open the map) is what happens.
    const { world, host, actuator, clock } = makeWorld({
      observation: dungeonView,
      cfg: { stallStopSeconds: 2, escalateTimeoutMs: 25 },
    });
    await started(world, host);

    clock.advance(600);
    await world.tick();

    expect(actuator.calls).toEqual(['key ' + SCAN.G + ' 60']);
    // Not a recover intent at all: the loop's own fallback is the last decision it took.
    expect(host.logRecords.some((line) => line.message.includes('no step to press'))).toBe(false);
    const status = outcome(await tool(world, 'wvd_status').handler({}, CTX));
    expect(status.text).toContain('last intent open-map');
  });
});
