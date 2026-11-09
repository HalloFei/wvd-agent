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
import { automoveToChest, automoveToExit, automoveToTile, openMap } from './actions/automove.ts';
import { BATTLE_OPENERS, tapOpenerConfirm, tapOpenerSlot } from './actions/battle.ts';
import { locateSkillPanelConfirm } from './perception/battle-panel.ts';
import { acceptChestPrompt, cancelQte, dismissLoot, pressBattleAuto, pressBattleSpeed, reenterChest, tapLoot } from './actions/chest.ts';
import { restAtInn } from './actions/inn.ts';
import { closeCharacterPage, confirmAutoHeal, openAutoHeal, openCharacterPage } from './actions/heal.ts';
import { timeQte } from './actions/qte.ts';
import { createQteFileRecorder } from './actions/qte-record.ts';
import { travelTo } from './actions/worldmap.ts';
import type { TaskDefinition } from './contracts.ts';
import type { WvdConfigSection } from './config.ts';
import { connectEngine, startEngine } from './engine/child.ts';
import { writeFile } from 'node:fs/promises';
import { CaptureHost } from './engine/vision/capture-host.ts';
import { openMapping } from './engine/vision/channel-mapping.ts';
import { createChannel, layoutChannel, type FrameChannel } from './engine/vision/frame-channel.ts';
import { captureJpeg, capturePng, focusGame, sendInput, Win32Capture } from './engine/win32.ts';
import { takeSnapshot } from './escalation/image.ts';
import { ChestPerceiver } from './perception/chest.ts';
import { ocrReader } from './perception/readers/index.ts';
import { activePartyMember } from './perception/party.ts';
import { CompositePerceiver } from './perception/composite.ts';
import { ACTING_CONFIDENCE_FLOOR, screenRecognisers } from './perception/reader-set.ts';
import { TRAVEL_IDS } from './perception/locations.ts';
import { MapPerceiver, tileOnScreen } from './perception/map.ts';
import { FFXI_GCN } from './perception/sites/ffxi-gcn.ts';
import { routePolicy } from './policy/route.ts';
import { createTaskPolicy } from './tasks/policy.ts';
import { createTaskRunner } from './tasks/runner.ts';
import { parseTask } from './tasks/schema.ts';
import { classify } from './policy/session.ts';
import { WvdWorld, type SessionOpen, type WvdSession } from './world.ts';

export interface WvdComposition {
  /** The live `worlds.wvd` section. Keys are read per decision; nothing is copied into a module. */
  cfg: WvdConfigSection;
  timezone: string;
}

/** Builds the World this deployment runs. Touches no engine until a session starts. */
export function createWvdWorld(composition: WvdComposition): WvdWorld {
  const { cfg, timezone } = composition;
  let world: WvdWorld | null = null;
  let host: CaptureHost | null = null;
  // The task the running session farms with; the decorator reads it per tick, so a session that
  // loaded no file behaves exactly like the v1 route.
  let task: TaskDefinition | null = null;
  // The session that owns the engine right now. Only the orientation's travel needs it: every other
  // command goes through the actuator alone, while a travel reads frames, so the composition root
  // keeps the live session for the one command that is bound to it.
  let live: WvdSession | null = null;

  /** The package root: `tasks/` sits beside `src/`, and a relative `taskFile` resolves from here. */
  const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

  /**
   * The frame channel's fixed layout: the game's client area at 1920×1080 (contracts §0.5, §8). The
   * child publishes raw BGRA into it and the World reads the newest slot; it is the frame's transport,
   * so the size is a contract of the vision module, not a per-session guess.
   */
  const FRAME_CHANNEL = { width: 1920, height: 1080, slots: 2 } as const;

  interface SessionChannel {
    readonly name: string;
    readonly bytes: number;
    readonly channel: FrameChannel;
    dispose(): void;
  }

  /** The one channel a session's child publishes into. Created with the child, disposed with it. */
  let frameChannel: SessionChannel | null = null;
  let channelSeq = 0;

  const openFrameChannel = (): SessionChannel => {
    const layout = layoutChannel(FRAME_CHANNEL);
    // A per-session name: a region from a previous session is never reused with stale slots in it.
    const name = `wvd-frame-${process.pid}-${++channelSeq}`;
    const mapping = openMapping(name, layout.bytes);
    try {
      // createChannel writes the header the child reads (and refuses another version's region)
      return {
        name,
        bytes: layout.bytes,
        channel: createChannel(mapping.memory, layout),
        dispose: () => mapping.dispose(),
      };
    } catch (error) {
      mapping.dispose();
      throw error;
    }
  };

  const channelOf = (): SessionChannel => {
    frameChannel ??= openFrameChannel();
    return frameChannel;
  };

  /**
   * The session's engine: the supervisor over the child, spawned on first use and restarted by the
   * host if it dies (the vision module, Task 6). Every request the World makes — input, capture,
   * foreground — goes through it, so a restart is invisible to the loop apart from the report.
   */
  const connect = (): CaptureHost => {
    if (host === null) {
      // The host creates the region before the child opens it: the child's channel is the session's.
      const channel = channelOf();
      host = new CaptureHost({
        launch: () => connectEngine(
          startEngine({
            title: cfg.gameWindowTitle,
            hotkey: cfg.stopHotkey,
            channel: { name: channel.name, bytes: channel.bytes },
          }),
          { timeoutMs: cfg.engineTimeoutMs },
        ),
        channel: channel.channel,
      });
    }
    return host;
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
  // The map reader is also the aim's reader: the walk asks it where a cell is on the frame it taps
  // (see `automoveToTile` below), so one instance serves the loop and the tap.
  // The readout's OCR escalation (operator, 2026-11-07): a package reads the numbers when the local
  // digit reader refuses them. Off unless the harness names an interpreter that has it.
  const ocrPython = process.env.WVD_OCR_PYTHON;
  const ocrScript = process.env.WVD_OCR_SCRIPT;
  // The site's evidence policy travels with the reader: a per-site ink band, not a constant in the
  // parser (site.ts, 2026-11-08). A new location is a descriptor, not a code change.
  const mapReader = new MapPerceiver(
    ocrPython !== undefined && ocrScript !== undefined
      ? { python: ocrPython, script: ocrScript, timeoutMs: 20_000 }
      : undefined,
    FFXI_GCN,
  );
  // The opener's escalation is the OCR tier directly (ruling R9): a 陷阱 field its own 'template'
  // strategy (R4) refuses goes to OCR, never to a chain whose 'auto' default starts with the rule
  // tier — that tier names this font's 4 as a 3 and would silently name a refused field 93 where the
  // screen says 92. The seam's strategy is a constructor argument (R12), not a config value: the
  // config switch returns with the map readout migration, its first real consumer.
  /**
   * The operator's allowance for the 由谁打开 page, ms (2026-11-08): it must be read and pressed inside
   * four seconds, never sat on. The template tier answers in **milliseconds** (4.5 ms median on the
   * live panel), so this window bounds only the fallback — how late a *second* OCR call may start; the
   * call's own bound is the harness's 3 s.
   */
  const PANEL_OCR_WINDOW_MS = 2_500;
  const chestPerceiver = new ChestPerceiver({
    trapReader: ocrReader,
    ocrWindowMs: PANEL_OCR_WINDOW_MS,
    // The tier mix, once per panel (acceptance 2): a run that starts falling to the escalation must
    // be visible in the log before it dies, and the line names the counts, never a glyph.
    onOpenerTiers: ({ template, ocr }) => world?.note(
      `wvd: opener panel: ${template} fields on the template tier, ${ocr} escalated`,
    ),
  });
  // The order and the try-order comments live in **one** place (perception/reader-set.ts), so the app,
  // the live CLI and the triage script compose the same chain and a saved frame answers the question
  // the loop asked. Only the ingredients differ here — the site, the OCR tiers, the trust book.
  // Verification by action: the World's outcome record scales each screen's floor (policy/trust.ts).
  const perceiver = new CompositePerceiver(
    screenRecognisers({ map: mapReader, chest: chestPerceiver }, ACTING_CONFIDENCE_FLOOR),
    {
      // The loop's own outcome record, per screen: a screen that keeps being right may act from a
      // weaker read; one the loop just contradicted must clear a higher bar (policy/trust.ts).
      floorFactor: (screen) => world?.trustFactor(screen) ?? 1,
    },
  );

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
    // The session's frame source: the child's metadata reply plus the published pixels, read from
    // the channel this session opened. The snapshot path encodes its JPEG here, in the World.
    const sessionChannel = channelOf();
    const source = new Win32Capture(client, sessionChannel.channel);
    const session: WvdSession = {
      source,
      perceiver,
      actuator,
      // The escalation's snapshot: the newest frame, downscaled to `escalationImageWidth` and
      // encoded in the World (contracts §5). A failure is null, not a throw: the question still goes
      // out without an image.
      snapshot: {
        capturePng: async (maxWidth?: number) => {
          const live = host;
          if (live === null) return null;
          const sessionChannel = channelOf();
          return await capturePng(source, sessionChannel.channel, maxWidth);
        },
        captureJpeg: async (maxWidth?: number) => {
          try {
            return await captureJpeg(source, sessionChannel.channel, maxWidth, cfg.jpegQuality);
          } catch {
            return null;
          }
        },
      },
      onEngineEvent: (listener: (event: EngineEvent) => void) => client.onEvent(listener),
      close: () => {
        live = null;
        host?.close();
        host = null;
        frameChannel?.dispose();
        frameChannel = null;
      },
    };
    live = session;
    const taskRunner = loaded === null ? undefined : createTaskRunner({
      task: loaded,
      source: session.source,
      perceiver: session.perceiver,
      actuator: session.actuator,
      log: (line) => world?.note(line),
      // The floors the leave goal may cross and recognise: the site's own list, beside the reader
      // that reads them (the composition root is where the site descriptor lives).
      knownFloors: FFXI_GCN.floors.map((floor) => floor.titleKey),
    });
    return taskRunner === undefined ? { ok: true, session } : { ok: true, session, task: taskRunner };
  };

  // The QTE recorder (operator rule 2026-11-05): on when the operator asks, one JSONL per deployment
  // under .tmp/record/. It records the bar the chest path times — readings, plan, press timing and
  // the carry time from the park — and changes nothing about the timing itself.
  const qteRecord = process.env.WVD_RECORD_QTE === '1'
    ? createQteFileRecorder(`.tmp/record/qte-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    : undefined;
  world = new WvdWorld({
    cfg,
    timezone,
    policy: createTaskPolicy(() => task, routePolicy),
    classify,
    // The QTE sub-loop is a dependency like the policy: `timeQte` is the production timing.
    timing: qteRecord === undefined ? timeQte : (options) => timeQte({ ...options, record: qteRecord }),
    commands: {
      // `pressHoldMs` is read per command, like every other key this World owns (§0.3).
      openMap: () => openMap(actuator, pressHoldMs()),
      // The walk finds the 自動移動 element instead of tapping a fixed 81 px above the cell: near the
      // panel's top edge that rise lands on the title bar, and a cell with no path raises nothing
      // (measured 2026-11-02). The frame comes from the live session, like the orientation's travel.
      // The walk is aimed where the map itself draws the marker, read from a frame captured at tap
      // time: the World hands the grid cell and the pixel is this binding's business (2026-11-06,
      // `t-mw3veimb-ppbm9u`). A capture that fails is `null`, never a guess.
      automoveToTile: (cell, pointerOn) => {
        const session = live;
        if (session === null) return automoveToTile(actuator, cell, pressHoldMs(), undefined, pointerOn);
        return automoveToTile(actuator, cell, pressHoldMs(), {
          locate: async () => {
            try {
              const frame = await session.source.capture();
              const observation = await mapReader.observe(frame);
              if (observation.screen !== 'dungeonmap') return null;
              const map = observation.map;
              const icon = map.icons.find((one) => one.at.x === cell.x && one.at.y === cell.y);
              // The located marker's own cell; a frame that reads the cell without its glyph (the
              // reader misses one now and then) still has that cell's place on it.
              return tileOnScreen(map, icon === undefined ? cell : icon.at);
            } catch {
              return null;
            }
          },
          capture: () => session.source.capture(),
        }, pointerOn);
      },
      automoveToExit: () => automoveToExit(actuator, pressHoldMs()),
      // 移动至宝箱 (E): the last reachable-chest check before the exit (policy/chest-probe.ts).
      automoveToChest: () => automoveToChest(actuator, pressHoldMs()),
      acceptChestPrompt: () => acceptChestPrompt(actuator),
      tapLoot: () => tapLoot(actuator),
      dismissLoot: () => dismissLoot(actuator),
      // One step of the heal per call: the loop's sequence decides which, from the frame it holds.
      healStep: (step) =>
        step === 'card' ? openCharacterPage(actuator)
          : step === 'sparkle' ? openAutoHeal(actuator)
            : step === 'restore' ? confirmAutoHeal(actuator)
              : closeCharacterPage(actuator),
      // The character page's own close: the X 关闭 tile the reader matched (2026-11-09), else its
      // measured point. The heal episode closes with Esc first and falls back to this.
      closeCharacterPage: (at) => (at === undefined ? closeCharacterPage(actuator) : actuator.tap(at)),
      // A control perception named: the harken menu's row (contracts §2 harken-menu).
      tapPoint: (at) => actuator.tap(at),
      // The inn's row: the rest module's one act (operator, 2026-11-06: a rest plug-in).
      restAtInn: (at) => restAtInn(actuator, at),
      // The battle's two toggles, one press each: speed → opener → auto → finish (operator 2026-11-03).
      battleSpeed: () => pressBattleSpeed(actuator),
      battleAuto: () => pressBattleAuto(actuator),
      // The cast's two taps (contracts §11). The World's battle sequence sends them as two paced
      // operations, so the settle between them is the sequence's, not a sleep here.
      battleSlot: async (opener) => {
        const tapped = await tapOpenerSlot(actuator, opener);
        // Measurement hook (`WVD_CAPTURE_CAST=1`): the panel the cast acts on is on screen between the
        // slot tap and the resolving press, so that is when a frame is kept — the operator's 确认 button
        // has never been recorded, and no point is guessed on the cast path. A failed capture never
        // breaks the cast.
        if (tapped.ok && process.env.WVD_CAPTURE_CAST === '1' && live !== null) {
          const snapshot = await takeSnapshot(live.snapshot, 1920);
          if (snapshot !== null) {
            const path = `.tmp/cast-panel-${Date.now()}.jpg`;
            try {
              await writeFile(path, Buffer.from(snapshot.bytes));
              world?.note(`wvd: cast panel captured to ${path}`);
            } catch {
              // a measurement, not a command
            }
          }
        }
        return tapped;
      },
      // The panel's 確定 is located on the frame, so this command presses the point it is given.
      battleConfirm: (at) => tapOpenerConfirm(actuator, at),
      // One Esc, through the command seam: this.#session is not the tick's session.
      escape: () => actuator.holdKey(0x01, pressHoldMs()),
      // The attempt-vs-reroll policy's action: leave the QTE (free, chest §4) and re-click a card.
      cancelQte: () => cancelQte(actuator),
      reenterChest: () => reenterChest(actuator, cfg.hazardEscapeHoldMs),
      // The orientation's one long command. It reads frames, so it is bound to the live session's
      // own source and perceiver; the atlas is the stored map (contracts §10, the goal form).
      travel: async (to, abort) => {
        const session = live;
        if (session === null) return { ok: false, reason: 'capture-unavailable', detail: 'no session is open' };
        return travelTo(to, {
          actuator: session.actuator,
          capture: () => session.source.capture(),
          observe: (frame) => session.perceiver.observe(frame),
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          abort,
          log: (line) => world?.note(line),
          atlas: true,
          // The pose source for the atlas travel: the banners (default) or the registration localiser
          // (perception/map-localiser.ts). WVD_LOCALISER=registration switches it.
          localiser: process.env.WVD_LOCALISER === 'registration' ? 'registration' : 'anchor',
          focus: () => focusGame(connect()),
          // The senses path is **withheld until it can see the icons** (2026-11-09 01:26: two live runs,
          // cropped or uncropped art, found no target and no landmark at level 0, while the atlas
          // confirmed the same node on the same frames — and seven unmeasured pushes left the map where
          // even the atlas could not place the site). The modules and the machine stay; the default does
          // not depend on them.
          navigation: process.env.WVD_NAV === 'senses' ? 'senses' : 'legacy',
        });
      },
    },
    // The opener list the operator configured, and the reader that names the ACTIVE member off the
    // battle frame (contracts §11 `BattleMemberReader`): the party panel's gold card, mapped to the
    // roster the operator filled in. A frame that does not say which card is up answers null, the
    // filter takes that as a miss, and the battle falls through to auto.
    battle: {
      openers: BATTLE_OPENERS,
      reader: { readActiveMember: async (frame) => activePartyMember(await frame.toRgba()) },
      // The cast's resolving press is **located**, not assumed (operator, 2026-11-07): the skill panel's
      // 確定 is found on the frame the cast is on, and a frame without the panel answers null — nothing
      // is pressed, and the confirm stays owed for the next paced look.
      locateConfirm: async (frame) => locateSkillPanelConfirm(await frame.toRgba())?.at ?? null,
    },
    openSession,
  });
  return world;
}
