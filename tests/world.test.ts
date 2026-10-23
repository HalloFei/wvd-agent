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
import type { EventEnvelope, ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import type {
  ActionResult,
  Actuator,
  EngineEvent,
  Frame,
  FrameSource,
  Observation,
  Perceiver,
  Point,
} from '../src/contracts.ts';
import { automoveToChest, automoveToExit, openMap } from '../src/actions/automove.ts';
import { WVD_DEFAULTS, type WvdConfigSection } from '../src/config.ts';
import { routePolicy } from '../src/policy/route.ts';
import { classify } from '../src/policy/session.ts';
import { WvdWorld, type WvdSession } from '../src/world.ts';

const CTX = {} as ToolCallContext;
/** The Windows set-1 codes the World's receipts report; the commands' own are in `actions/`. */
const SCAN = { W: 0x11, F: 0x21, G: 0x22, L: 0x26 };

// ---------------------------------------------------------------------------------------------
// The fakes the brief asks for: a source, a perceiver and an actuator
// ---------------------------------------------------------------------------------------------

function frame(atMs: number): Frame {
  return {
    atMs,
    width: 1920,
    height: 1080,
    toRgba: async () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
  };
}

class ScriptedSource implements FrameSource {
  captures = 0;
  /** Captures that will fail before a good one is served. */
  failures = 0;
  /** When set, `capture()` waits for it: the test decides when the tick may finish. */
  gate: Promise<void> | null = null;

  async capture(): Promise<Frame> {
    this.captures += 1;
    const gate = this.gate;
    if (gate) await gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('capture timeout: no-frame');
    }
    return frame(this.captures * 100);
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

  get log() {
    const noop = (): void => undefined;
    const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, emit: noop, child: () => logger };
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
    player: { x: 19, y: 21 },
    icons: [
      { kind: 'chest', at: { x: 14, y: 18 } },
      { kind: 'hazard', at: { x: 10, y: 10 } },
    ],
  },
};

const unknownButSeen: Observation = { screen: 'unknown', atMs: 100, confidence: 0.2 };
const nothingSeen: Observation = { screen: 'unknown', atMs: 100, confidence: 0 };
const waiting: Observation = { screen: 'loading', atMs: 100, confidence: 0.9 };
const dungeonView: Observation = { screen: 'dungeon', atMs: 100, confidence: 0.9 };

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
    commands: {
      openMap: () => openMap(actuator),
      automoveToChest: () => automoveToChest(actuator),
      automoveToExit: () => automoveToExit(actuator),
    },
    openSession: async () => {
      openSessionCalls += 1;
      if (options.openSessionGate) await options.openSessionGate;
      return session;
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
    expect(actuator.calls).toEqual([`key ${SCAN.L} 60`]);
    expect(host.pushed).toEqual([]);
  });

  it('sends one command and waits for the screen to answer it', async () => {
    const { world, host, actuator, perceiver, clock } = makeWorld();
    await started(world, host);

    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.L} 60`]);

    // The route re-derives 'move' on the next tick; the loop must not press L again while the map
    // is still on screen. This is the defect the review found: a stateless policy is not a memory.
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.L} 60`]);

    // automoveStillSeconds passes with the screen unchanged: the command gave up and is not re-sent.
    clock.advance(5000);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.L} 60`]);

    // The farm advanced — the party is somewhere else on the map — so a command may be sent again.
    perceiver.observation = {
      ...dungeonMap,
      map: { ...dungeonMap.map, player: { x: 12, y: 18 } },
    };
    clock.advance(100);
    await world.tick();
    expect(actuator.calls).toEqual([`key ${SCAN.L} 60`, `key ${SCAN.L} 60`]);
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
    // no answer → the policy's own recovery: leave the dungeon (F)
    expect(actuator.calls).toContain(`key ${SCAN.F} 60`);
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
    // nobody answered, so the loop took its own recovery
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
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
    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
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

    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
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

    expect(actuator.calls).toEqual([`key ${SCAN.F} 60`]);
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
    expect(late.text).toContain('leaves the dungeon');
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

  it('wvd_resume validates the intent it is given, and move needs no tile', async () => {
    const { world, host, actuator } = makeWorld({ observation: unknownButSeen, cfg: { escalateTimeoutMs: 5000 } });
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

    // 移动至宝箱 cannot be aimed: the game chooses the chest, so there is no tile to name.
    const moved = outcome(await resume.handler({ intent: { kind: 'move' }, note: 'walk to the chest' }, CTX));
    expect(moved.failed).toBeUndefined();
    expect(moved.text).toBe('resumed: the loop takes move');
    await tick;
    expect(actuator.calls).toContain(`key ${SCAN.L} 60`);
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
