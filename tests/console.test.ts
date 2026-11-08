/**
 * The operator console (plan Task 13): the panel's **methods**, not its DOM. The page is a rendered
 * view of the same snapshot, so what is asserted here is what the page can know:
 *
 * - `webUi()` declares one panel, read-only methods over GET, and an invoke/stream surface;
 * - `status` answers exactly one of the six states the design fixes, derived from the World;
 * - `start` refuses with a reason when there is nothing to run — no engine, no window — and refuses
 *   a second session while one is live, without spawning a second child;
 * - `stop` works from `escalating` too, cancels the open question first, ends the session with the
 *   reason the loop pushes, and is idempotent;
 * - `cancel-escalation` closes the question and lets the paused tick take its own fallback;
 * - an unknown method is a typed failure, never a throw;
 * - `stream` sends one snapshot per socket and survives a socket that throws.
 *
 * No engine, no window, no game, no network: the World is driven by fakes, as in `world.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, WorldHost, WorldStreamSocket } from 'cortico/core/types.ts';
import type {
  ActionResult,
  Actuator,
  Frame,
  FrameSource,
  Observation,
  Perceiver,
  Point,
} from '../src/contracts.ts';
import { WVD_DEFAULTS, type WvdConfigSection } from '../src/config.ts';
import { automoveToExit, automoveToTile, openMap } from '../src/actions/automove.ts';
import { acceptChestPrompt, cancelQte, dismissLoot, pressBattleAuto, pressBattleSpeed, reenterChest, tapLoot } from '../src/actions/chest.ts';
import { timeQte } from '../src/actions/qte.ts';
import { tileOnScreen } from '../src/perception/map.ts';
import { routePolicy } from '../src/policy/route.ts';
import { classify } from '../src/policy/session.ts';
import { WvdWorld, type WvdSession } from '../src/world.ts';
import type { ConsoleLogEntry, ConsoleStatus } from '../src/webui/protocol.ts';

/** The typed answer every method returns; the panel renders the failure instead of a toast. */
type Result<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

const PANEL = 'wvd-console';

// ---------------------------------------------------------------------------------------------
// Fakes: everything the loop is allowed to know
// ---------------------------------------------------------------------------------------------

function frame(atMs: number): Frame {
  return {
    atMs,
    width: 1920,
    height: 1080,
    toRgba: async () => ({ data: Uint8Array.of(0, 0, 0, 255), width: 1, height: 1 }),
  };
}

class ScriptedSource implements FrameSource {
  throwOnCapture = false;
  async capture(): Promise<Frame> {
    if (this.throwOnCapture) throw new Error('window-not-found');
    return frame(100);
  }
}

class ScriptedPerceiver implements Perceiver {
  throwOnObserve = false;
  constructor(public observation: Observation) {}
  async observe(): Promise<Observation> {
    if (this.throwOnObserve) throw new Error('the perceiver broke');
    return this.observation;
  }
}

class ScriptedActuator implements Actuator {
  readonly calls: string[] = [];
  async tap(at: Point): Promise<ActionResult> {
    this.calls.push(`tap ${at.x},${at.y}`);
    return { ok: true };
  }
  async doubleTap(at: Point): Promise<ActionResult> {
    this.calls.push(`doubleTap ${at.x},${at.y}`);
    return { ok: true };
  }
  async holdKey(scan: number, holdMs: number): Promise<ActionResult> {
    this.calls.push(`key ${scan} ${holdMs}`);
    return { ok: true };
  }
  async drag(from: Point, to: Point, durationMs: number): Promise<ActionResult> {
    this.calls.push(`drag ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
    return { ok: true };
  }
}

class FakeHost {
  readonly pushed: Array<{ type: string; text: string }> = [];
  private cursor = 0;

  get modelFacts() {
    return {
      model: () => 'fake-model',
      accepts: (mime: string): boolean => mime.startsWith('image/'),
      contextWindow: () => 0,
    };
  }

  get log() {
    const noop = (): void => undefined;
    const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, emit: noop, child: () => logger };
    return logger;
  }

  async pushEvent(event: { type: string; text: string }): Promise<EventEnvelope> {
    this.cursor += 1;
    this.pushed.push({ type: event.type, text: event.text });
    return { ...event, cursor: this.cursor, origin: 'external', contextDelivery: 'deliver' } as unknown as EventEnvelope;
  }
}

class FakeSocket implements WorldStreamSocket {
  readonly sent: string[] = [];
  readonly closes: string[] = [];
  open = true;
  throwOnSend = false;
  #closeCallbacks: Array<() => void> = [];

  send(data: string): void {
    if (this.throwOnSend) throw new Error('this socket is gone');
    this.sent.push(data);
  }

  close(reason?: string): void {
    this.open = false;
    this.closes.push(reason ?? '');
    for (const callback of this.#closeCallbacks.splice(0)) callback();
  }

  onMessage(): void {}

  onClose(callback: () => void): void {
    this.#closeCallbacks.push(callback);
  }

  /** The last frame as the panel's client receives it. */
  frame(): { type: string; value: ConsoleStatus } {
    const text = this.sent.at(-1);
    if (!text) throw new Error('no frame was sent');
    return JSON.parse(text) as { type: string; value: ConsoleStatus };
  }
}

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
    origin: { x: 960, y: 540 },
    icons: [
      { kind: 'chest', at: { x: 14, y: 18 } },
      { kind: 'hazard', at: { x: 10, y: 10 } },
    ],
  },
};

/** A screen the route will not act on: the stall clock turns it into a question. */
const waiting: Observation = { screen: 'loading', atMs: 100, confidence: 0.9 };

function makeConsole(options: {
  cfg?: Partial<WvdConfigSection>;
  observation?: Observation;
  /** No engine at all: the World cannot reach a game window. */
  noEngine?: boolean;
  /** The engine is wired but could not attach to the window (returns null). */
  engineRefuses?: boolean;
  /** Held open to keep a start inside its engine handshake while the test looks at the page. */
  openSessionGate?: Promise<void>;
} = {}) {
  const source = new ScriptedSource();
  const perceiver = new ScriptedPerceiver(options.observation ?? dungeonMap);
  const actuator = new ScriptedActuator();
  const session: WvdSession = { source, perceiver, actuator };
  const cfg: WvdConfigSection = { ...structuredClone(WVD_DEFAULTS), tickMs: 50, ...options.cfg };
  const host = new FakeHost();
  const clock = new TestClock();
  let openSessionCalls = 0;
  const world = new WvdWorld({
    cfg,
    timezone: 'Asia/Shanghai',
    policy: routePolicy,
    classify,
    // The real sub-loop: this harness never shows a bar, so it can only refuse — honestly.
    timing: timeQte,
    commands: {
      openMap: () => openMap(actuator, cfg.pressHoldMs),
      // The aim `main.ts` gives, over this harness's scripted map.
      automoveToTile: (cell) => automoveToTile(actuator, cell, cfg.pressHoldMs, {
        locate: async () => {
          const observation = perceiver.observation;
          return observation.screen === 'dungeonmap' ? tileOnScreen(observation.map, cell) : null;
        },
      }),
      automoveToExit: () => automoveToExit(actuator, cfg.pressHoldMs),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      tapLoot: () => tapLoot(actuator),
      dismissLoot: () => dismissLoot(actuator),
      healStep: async () => ({ ok: true }),
      closeCharacterPage: async () => ({ ok: true }),
      tapPoint: (at) => actuator.tap(at),
      restAtInn: (at) => actuator.tap(at),
      battleSpeed: () => pressBattleSpeed(actuator),
      battleAuto: () => pressBattleAuto(actuator),
      battleSlot: async () => ({ ok: true }),
      battleConfirm: async () => ({ ok: true }),
      escape: async () => ({ ok: true }),
      cancelQte: () => cancelQte(actuator),
      reenterChest: () => reenterChest(actuator, cfg.hazardEscapeHoldMs),
      // This harness never orients: the World runs the built-in route with no task file.
      travel: async () => ({ ok: true }),
    },
    openSession: options.noEngine
      ? undefined
      : async () => {
        openSessionCalls += 1;
        if (options.openSessionGate) await options.openSessionGate;
        return options.engineRefuses ? { ok: false, reason: 'no-engine' } : { ok: true, session };
      },
    autoTick: false,
    now: clock.now,
  });
  return {
    world, host, source, perceiver, actuator, cfg, clock,
    openSessionCalls: () => openSessionCalls,
  };
}

/** Mounts the World with `enabled` off, so a test decides when the console starts a session. */
async function mount(world: WvdWorld, host: FakeHost): Promise<void> {
  await world.start(host as unknown as WorldHost);
}

async function call<T>(world: WvdWorld, method: string, args: unknown[] = []): Promise<Result<T>> {
  const invoke = world.webUi().invoke;
  expect(invoke, 'the console declares invoke').toBeTypeOf('function');
  return (await invoke!(PANEL, method, args)) as Result<T>;
}

async function statusOf(world: WvdWorld): Promise<ConsoleStatus> {
  const result = await call<ConsoleStatus>(world, 'status');
  if (!result.ok) throw new Error(`status failed: ${result.error}`);
  return result.value;
}

async function logOf(world: WvdWorld): Promise<ConsoleLogEntry[]> {
  const result = await call<ConsoleLogEntry[]>(world, 'log');
  if (!result.ok) throw new Error(`log failed: ${result.error}`);
  return result.value;
}

async function until(condition: () => boolean | Promise<boolean>, label: string, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------------------------

describe('the console declaration', () => {
  it('declares one panel, its read-only methods and the invoke/stream surface', async () => {
    const { world, host } = makeConsole();
    await mount(world, host);

    const decl = world.webUi();
    expect(decl.label).toBeTypeOf('string');
    expect(decl.lamps?.length).toBeGreaterThan(0);
    expect(decl.badges?.map((badge) => badge.label)).toEqual(['state', 'escalations']);
    expect(decl.panels).toEqual([
      expect.objectContaining({ id: PANEL, title: expect.any(String), getMethods: ['status', 'log'] }),
    ]);
    expect(decl.invoke).toBeTypeOf('function');
    expect(decl.stream).toBeTypeOf('function');
    expect(decl.config?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The six states
// ---------------------------------------------------------------------------------------------

describe('status', () => {
  it('answers each of the six states from the World, never from a guess', async () => {
    const { world, host, cfg, perceiver, clock } = makeConsole({ cfg: { stallStopSeconds: 1 } });
    await mount(world, host);

    // offline: the World is not enabled. The detail says what to fix.
    let status = await statusOf(world);
    expect(status.state).toBe('offline');
    expect(status.detail).toContain('disabled');
    expect(status.canStart).toEqual({ ok: false, reason: expect.stringContaining('disabled') });

    cfg.enabled = true;
    status = await statusOf(world);
    expect(status.state).toBe('idle');
    expect(status.lamp).toBe('online');
    expect(status.canStart).toEqual({ ok: true });

    const started = await call<ConsoleStatus>(world, 'start');
    expect(started.ok).toBe(true);
    status = await statusOf(world);
    expect(status.state).toBe('running');
    expect(status.lamp).toBe('online');

    // The live strip reads the loop's own last observation, not a fresh capture.
    await world.tick();
    status = await statusOf(world);
    expect(status.screen).toBe('dungeonmap');
    expect(status.floor).toBe('B1F');
    expect(status.x).toBe(19);
    expect(status.y).toBe(21);
    expect(status.chestsLeft).toBe(1);
    expect(status.intent).toBe('move');
    expect(status.frameAgeMs).toBe(900);
    expect(status.escalationsThisHour).toBe(0);
    expect(status.escalateMaxPerHour).toBe(cfg.escalateMaxPerHour);

    // escalating: a paused tick with an open question. The first tick after the screen changes is
    // still inside the stall window; the second one has nothing new and asks.
    perceiver.observation = waiting;
    await world.tick();
    clock.advance(600);
    const paused = world.tick();
    await until(async () => (await statusOf(world)).state === 'escalating', 'the open question');
    status = await statusOf(world);
    expect(status.question).not.toBeNull();
    expect(status.question!.text).toContain('screen');
    expect(status.question!.timeoutMs).toBe(cfg.escalateTimeoutMs);
    expect(status.canCancel).toBe(true);

    // stopped: the operator's stop closes the question and the session.
    expect((await call<ConsoleStatus>(world, 'stop')).ok).toBe(true);
    await paused;
    status = await statusOf(world);
    expect(status.state).toBe('stopped');
    expect(status.detail).toBe('the session was stopped');
    expect(status.question).toBeNull();

    // error: a module failed across its boundary; the session ended rather than retried.
    expect((await call<ConsoleStatus>(world, 'start')).ok).toBe(true);
    perceiver.throwOnObserve = true;
    await world.tick();
    status = await statusOf(world);
    expect(status.state).toBe('error');
    expect(status.lamp).toBe('error');
    expect(status.detail).toContain('perception failed');
  });

  it('is offline when no engine is wired, and says so', async () => {
    const { world, host, cfg } = makeConsole({ noEngine: true });
    await mount(world, host);
    cfg.enabled = true;

    const status = await statusOf(world);
    expect(status.state).toBe('offline');
    expect(status.lamp).toBe('offline');
    expect(status.detail).toContain('no engine');
    expect(status.canStart).toEqual({ ok: false, reason: expect.stringContaining('no engine') });
  });
});

// ---------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------

describe('start', () => {
  it('refuses with a reason when the engine cannot reach a window', async () => {
    const { world, host, cfg, openSessionCalls } = makeConsole({ engineRefuses: true });
    await mount(world, host);
    cfg.enabled = true;
    const before = openSessionCalls();

    const result = await call<ConsoleStatus>(world, 'start');
    // The engine is asked once. A refusal is a value the panel renders; nothing retries in a loop.
    expect(openSessionCalls() - before).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('engine child did not start');

    const status = await statusOf(world);
    expect(status.state).toBe('error');
    expect(status.detail).toContain('engine child did not start');
  });

  it('refuses a second session while one is running, without opening a second engine', async () => {
    const { world, host, cfg, openSessionCalls } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;
    expect((await call<ConsoleStatus>(world, 'start')).ok).toBe(true);
    const opened = openSessionCalls();

    const second = await call<ConsoleStatus>(world, 'start');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('already running');
    expect(openSessionCalls()).toBe(opened);
  });

  it('is refused while a session is starting, and the lamp says loading', async () => {
    // A start in flight is observable: the lamp is loading, the state is still idle, and a second
    // start is refused instead of spawning a second engine.
    let release = (): void => {};
    const openSessionGate = new Promise<void>((resolve) => { release = resolve; });
    const { world, host, cfg, openSessionCalls } = makeConsole({ openSessionGate });
    await mount(world, host);
    cfg.enabled = true;

    const first = call<ConsoleStatus>(world, 'start');
    const opening = await statusOf(world);
    expect(opening.state).toBe('idle');
    expect(opening.lamp).toBe('loading');
    expect(opening.detail).toContain('starting');
    expect(opening.canStart).toEqual({ ok: false, reason: expect.stringContaining('starting') });

    const second = await call<ConsoleStatus>(world, 'start');
    if (second.ok) throw new Error('a second start must not be accepted while the first is opening');
    expect(openSessionCalls()).toBe(1);

    release();
    expect((await first).ok).toBe(true);
    expect((await statusOf(world)).state).toBe('running');
  });
});

// ---------------------------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------------------------

describe('stop', () => {
  it('ends a running session with the reason the loop pushes, and is idempotent', async () => {
    const { world, host, cfg } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;
    await call<ConsoleStatus>(world, 'start');
    await world.tick();

    const stopped = await call<ConsoleStatus>(world, 'stop');
    expect(stopped.ok).toBe(true);
    if (stopped.ok) {
      expect(stopped.value.state).toBe('stopped');
      expect(stopped.value.detail).toBe('the session was stopped');
    }
    expect(world.isRunning()).toBe(false);

    const again = await call<ConsoleStatus>(world, 'stop');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.state).toBe('stopped');

    const reports = host.pushed.filter((pushed) => pushed.type === 'wvd.stopped');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('the session was stopped');
  });

  it('cancels an open question first, and the paused tick never takes its fallback', async () => {
    const { world, host, cfg, actuator, clock } = makeConsole({ observation: waiting, cfg: { stallStopSeconds: 1 } });
    await mount(world, host);
    cfg.enabled = true;
    await call<ConsoleStatus>(world, 'start');
    await world.tick();
    expect(actuator.calls).toEqual([]);

    clock.advance(600);
    const paused = world.tick();
    await until(async () => (await statusOf(world)).question !== null, 'the open question');

    const stopped = await call<ConsoleStatus>(world, 'stop');
    expect(stopped.ok).toBe(true);
    await paused;

    const status = await statusOf(world);
    expect(status.state).toBe('stopped');
    expect(status.question).toBeNull();
    expect(world.isRunning()).toBe(false);
    // The question was cancelled before the session ended: no fallback input after the stop.
    expect(actuator.calls).toEqual([]);

    const reports = host.pushed.filter((pushed) => pushed.type === 'wvd.stopped');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('the session was stopped');
    expect(host.pushed.filter((pushed) => pushed.type === 'wvd.stuck')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// cancel-escalation
// ---------------------------------------------------------------------------------------------

describe('cancel-escalation', () => {
  it('closes the question and lets the paused tick take its own fallback', async () => {
    const { world, host, cfg, actuator, clock } = makeConsole({ observation: waiting, cfg: { stallStopSeconds: 1 } });
    await mount(world, host);
    cfg.enabled = true;
    await call<ConsoleStatus>(world, 'start');
    await world.tick();

    clock.advance(600);
    const paused = world.tick();
    await until(async () => (await statusOf(world)).question !== null, 'the open question');

    const cancelled = await call<ConsoleStatus>(world, 'cancel-escalation');
    expect(cancelled.ok).toBe(true);
    await paused;

    const status = await statusOf(world);
    expect(status.state).toBe('running');
    expect(status.question).toBeNull();
    expect(status.canCancel).toBe(false);
    // The resumed tick takes the loop's own fallback: opening the map (G twice, never F blind).
    expect(actuator.calls).toEqual(['key 34 60']);
    expect(host.pushed.filter((pushed) => pushed.type === 'wvd.stopped')).toHaveLength(0);
  });

  it('is a typed failure when no question is open', async () => {
    const { world, host, cfg } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;
    const result = await call<ConsoleStatus>(world, 'cancel-escalation');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no question');
  });
});

// ---------------------------------------------------------------------------------------------
// The typed surface
// ---------------------------------------------------------------------------------------------

describe('the typed surface', () => {
  it('answers an unknown method with a failure, not a throw', async () => {
    const { world, host, cfg } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;

    const result = await call<ConsoleStatus>(world, 'launch-the-game');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('launch-the-game');
      expect(result.error).toContain('console');
    }

    const otherPanel = await world.webUi().invoke!('another-panel', 'status', []);
    expect(otherPanel).toEqual({ ok: false, error: expect.stringContaining('another-panel') });
  });

  it('keeps the recent transitions with times, and the last stop reason', async () => {
    const { world, host, cfg, clock } = makeConsole({ observation: waiting, cfg: { stallStopSeconds: 1, escalateTimeoutMs: 20 } });
    await mount(world, host);
    cfg.enabled = true;
    await call<ConsoleStatus>(world, 'start');
    await world.tick();

    // The question times out: the log must tell that story in order.
    clock.advance(600);
    await world.tick();
    await call<ConsoleStatus>(world, 'stop');

    const log = await logOf(world);
    expect(log.map((entry) => entry.kind)).toEqual(['started', 'escalated', 'timed-out', 'stopped']);
    for (const entry of log) {
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isFinite(entry.atMs)).toBe(true);
    }
    expect(log.at(-1)!.text).toContain('the session was stopped');
    expect(log.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------------------------
// stream
// ---------------------------------------------------------------------------------------------

describe('stream', () => {
  it('sends one snapshot per socket, and the same snapshot to a second one', async () => {
    const { world, host } = makeConsole();
    await mount(world, host);

    const first = new FakeSocket();
    const second = new FakeSocket();
    world.webUi().stream!(PANEL, first);
    world.webUi().stream!(PANEL, second);

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    const frame = first.frame();
    expect(frame.type).toBe('status');
    expect(frame.value.state).toBe('offline');
    expect(second.sent[0]).toBe(first.sent[0]);
  });

  it('survives a socket that throws on send, and keeps the others', async () => {
    const { world, host, cfg } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;

    const broken = new FakeSocket();
    broken.throwOnSend = true;
    const healthy = new FakeSocket();

    expect(() => world.webUi().stream!(PANEL, broken)).not.toThrow();
    expect(() => world.webUi().stream!(PANEL, healthy)).not.toThrow();
    expect(healthy.sent).toHaveLength(1);

    // The connection that threw is dropped; the next push still reaches the one that works.
    await call<ConsoleStatus>(world, 'start');
    expect(healthy.sent.length).toBeGreaterThan(1);
    expect(healthy.frame().value.state).toBe('running');
  });

  it('pushes the new state to a socket that stays open', async () => {
    const { world, host, cfg, clock } = makeConsole();
    await mount(world, host);
    cfg.enabled = true;

    const socket = new FakeSocket();
    world.webUi().stream!(PANEL, socket);
    socket.sent.length = 0;

    await call<ConsoleStatus>(world, 'start');
    expect(socket.frame().value.state).toBe('running');

    const before = socket.sent.length;
    await world.tick();
    clock.advance(600);
    await world.tick();
    expect(socket.sent.length).toBeGreaterThan(before);
    expect(socket.frame().value.state).toBe('running');

    await call<ConsoleStatus>(world, 'stop');
    expect(socket.frame().value.state).toBe('stopped');
  });

  it('closes a stream for a panel it does not serve', async () => {
    const { world, host } = makeConsole();
    await mount(world, host);

    const socket = new FakeSocket();
    world.webUi().stream!('other-panel', socket);
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toHaveLength(1);
  });
});
