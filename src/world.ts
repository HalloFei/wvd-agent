/**
 * The WVD World: the loop that runs the modules, the four tools, and the escalation exchange.
 *
 * The loop is the only thing in this package that knows *when*; every *what* arrives through a
 * contract (contracts §0.1, §0.2). `FarmPolicy`, `SessionClassifier`, `RouteCommands`,
 * `FrameSource`, `Perceiver`, `Actuator` and `SnapshotSource` are constructor arguments; `main.ts`
 * decides which realizations they are. That is what lets a replay source, a template perceiver or a
 * fake in `tests/world.test.ts` run this same loop.
 *
 * The rulings that shape the tick:
 *
 * - **One command at a time, until its own effect is answered.** The policy is stateless, so it
 *   re-derives the same intent on every tick; the loop is what remembers that it just pressed a key.
 *   A command stays in flight **through the screens it produces itself** — `move`'s own effect is
 *   the map closing, so a screen change is not an answer — and is released only by its own evidence:
 *   `open-map` by the map arriving, a walk by **arrival**, which is the scene going still for
 *   `automoveStillSeconds` (`src/frames/stillness.ts`). A command that timed out is not sent again
 *   until the farm has advanced. Without that, `dungeon` (the walking view) gets a second `G` 100 ms
 *   after the first, and the party is asked to open the map in the middle of every walk.
 * - **Progress is state, not screen identity.** The party's position and the chest count on the map
 *   are what say the farm advanced; a dungeon ↔ map alternation at the same position is not
 *   progress, however many screens it cycles through. While a walk is outstanding a changed map
 *   read is that walk moving, not the farm advancing: it keeps the stall clock alive, and it does
 *   not re-open a command the walk has not answered.
 * - **One clock.** `atMs` is `performance.now()`; the engine reports `ageMs` only, and
 *   `Win32Capture` already subtracts it. A decision is dated by `frame.atMs`, never by "just
 *   received".
 * - **No overlapping ticks.** A tick that is still running is skipped, not queued: a tick that
 *   overruns is a bug, not a backlog. During an escalation the paused tick *is* the pause.
 * - **Warm-up.** The first capture after an idle gap can answer `timeout` while the child starts
 *   rendering, so capture failures are retried for three ticks before the engine is called absent.
 * - **Stalls are the loop's.** `classify` is stateless and deliberately so; "no progress" is
 *   measured here, turned into an escalation at a quarter of `stallStopSeconds` and into a stop at
 *   all of it.
 * - **Engine failure is a stop.** No window, a dead child, a capture that keeps failing: the session
 *   ends and says why (contracts §0.6).
 */
import type {
  EventEnvelope,
  ToolCallContext,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldStreamSocket,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { MAX_PRESS_HOLD_MS } from './contracts.ts';
import type {
  ActionResult,
  Actuator,
  EngineEvent,
  FarmPolicy,
  Frame,
  FrameSource,
  Intent,
  Observation,
  Perceiver,
  Point,
  RouteState,
  ScreenId,
  GameMode,
  ScriptResult,
  SessionTask,
  SessionVerdict,
  TravelOutcome,
  BattleMemberReader,
  BattleOpener,
} from './contracts.ts';
import { WVD_CONFIG_GROUP, WVD_ID, type WvdConfigSection } from './config.ts';
import { DISARM_SCAN } from './actions/chest.ts';
import { chooseQtePass, type QtePass } from './policy/qte.ts';
import { advanceMode, INITIAL_MODE, type ModeMemory } from './policy/mode.ts';
import { OPERATION_PACE_MS, Pacer } from './policy/pacing.ts';
import { BattleSequence } from './policy/battle-sequence.ts';
import {
  fallbackPhrase,
  observationLine,
  stoppedEvent,
  stuckEvent,
  type WvdEvent,
} from './escalation/event.ts';
import { sceneIsStill, sceneSignature, type SceneSignature } from './frames/stillness.ts';
import { nowIso } from 'cortico/core/util.ts';
import { snapshotBlob, takeSnapshot, type SnapshotSource } from './escalation/image.ts';
import { Supervisor, type EscalationOutcome } from './escalation/supervisor.ts';
import { tapOpenerCard } from './actions/opener.ts';
import { bandSampler, REFERENCE_FRAME, type QteOutcome, type QteRefusal, type QteTimer } from './actions/qte.ts';
import { openerCardCentre, openerSlot } from './perception/opener.ts';
import { tileOnScreen } from './perception/map.ts';
import { openerFor } from './actions/battle.ts';
import { chooseOpener } from './policy/chest.ts';
import { nextOrientStep, type OrientCommand } from './policy/orient.ts';
import {
  CONSOLE_GET_METHODS,
  CONSOLE_LOG_LIMIT,
  CONSOLE_PANEL_ID,
  type ConsoleFrame,
  type ConsoleLamp,
  type ConsoleLogEntry,
  type ConsoleLogKind,
  type ConsoleResult,
  type ConsoleStart,
  type ConsoleState,
  type ConsoleStatus,
} from './webui/protocol.ts';

/** `classify` from `policy/session.ts` (contracts §6, §9): a verdict, never an action. */
export type SessionClassifier = (
  state: RouteState,
  escalationsThisHour: number,
  escalateMaxPerHour: number,
) => SessionVerdict;

/** The commands of `actions/automove.ts`, bound to an `Actuator` by the composition root. */
export interface RouteCommands {
  openMap(): Promise<ActionResult>;
  /** Walk to one tile of the open map: its screen point, converted from the map's grid here. */
  automoveToTile(at: Point): Promise<ActionResult>;
  automoveToExit(): Promise<ActionResult>;
  /** Accept the `打开` prompt of the chest the party stands at. */
  acceptChestPrompt(): Promise<ActionResult>;
  /** Collect the chest loot card with one tap at its measured centre. */
  tapLoot(): Promise<ActionResult>;
  /** Dismiss the loot result banner (the card's own continue arrow) when the card taps do not leave it. */
  dismissLoot(): Promise<ActionResult>;
  /** The game's one-key heal: party card, sparkle, 恢复, close, with its own settles. */
  healParty(): Promise<ActionResult>;
  /** Leave the character page: its measured X 关闭 tile (2026-11-03; the page is a named screen). */
  closeCharacterPage(): Promise<ActionResult>;
  /**
   * One tap at a point **perception named** — the harken menu's row, today. Not a blind tile: the
   * caller passes a control the frame itself reported (contracts §2 `harken-menu`).
   */
  tapPoint(at: Point): Promise<ActionResult>;
  /** The battle's 倍速 toggle: one press, sent only when the frame says it is off (contracts §2). */
  battleSpeed(): Promise<ActionResult>;
  /** The battle's 自動 toggle: one press, sent only when the frame says it is off. */
  battleAuto(): Promise<ActionResult>;
  /**
   * The cast's first tap: the configured opener's quick slot. The World's battle sequence sends it as
   * one operation and waits out its own pace before the resolving press (operator rule 2026-11-04).
   */
  battleSlot(opener: BattleOpener): Promise<ActionResult>;
  /** The cast's second tap: the skill's own 确认 when configured, the side its target resolves over. */
  battleConfirm(opener: BattleOpener): Promise<ActionResult>;
  /**
   * Leave the chest QTE without spending an attempt (chest §4): the round ✕ at the left of the
   * hotbar. Used by the attempt-vs-reroll policy, which changes the bar's speed by re-selecting the
   * opener; cancelling a floor chest's QTE is free.
   */
  cancelQte(): Promise<ActionResult>;
  /**
   * Re-engage the chest after a cancel: **S then W**. The party stands *on* the chest's tile then, so
   * no prompt is offered, and stepping off alone leaves the screen silent (measured 2026-10-31); the
   * step off plus the step back on draws 打开 on the next frame. The hold is `hazardEscapeHoldMs`.
   */
  reenterChest(): Promise<ActionResult>;
  /**
   * Travel to a catalogued node on the world map: the orientation's one long command (contracts §10,
   * the goal form). Unlike the single gestures above it reads frames — it opens the map, locates the
   * view, pans and zooms, and confirms the node — so the deployment binds it to a source and a
   * perceiver of its own, and `abort` is the session's signal for a stop that lands mid-travel.
   */
  travel(to: string, abort: AbortSignal): Promise<TravelOutcome>;
}

/** One session's collaborators: everything the loop drives, for as long as it runs. */
export interface WvdSession {
  readonly source: FrameSource;
  readonly perceiver: Perceiver;
  readonly actuator: Actuator;
  /** The engine's own JPEG for the escalation image (contracts §5 `capture { maxWidth }`). */
  readonly snapshot?: SnapshotSource | undefined;
  /** The child's unsolicited messages (stop hotkey, capability problems); returns an unsubscribe. */
  readonly onEngineEvent?: ((listener: (event: EngineEvent) => void) => () => void) | undefined;
  readonly close?: (() => void) | undefined;
}

/**
 * What one `openSession()` produced: the engine's collaborators, and — when the deployment
 * configured a task file — the task that owns the session's entry and exit (contracts §10).
 * A refusal is typed, so the World can report *why* a session did not start.
 */
export type SessionOpen =
  | { readonly ok: true; readonly session: WvdSession; readonly task?: SessionTask | undefined }
  | { readonly ok: false; readonly reason: 'no-engine' | 'task-file-invalid'; readonly detail?: string };

export interface WvdWorldOptions {
  /** Live reference to `worlds.wvd`; the keys this World owns are read per decision, not copied. */
  cfg: WvdConfigSection;
  /** Deployment timezone; event timestamps use it. */
  timezone: string;
  policy: FarmPolicy;
  classify: SessionClassifier;
  commands: RouteCommands;
  /**
   * The QTE timing sub-loop (`actions/qte.ts`, contracts §7). Required, not optional: a World that
   * silently declined to time the bar would be lying about the chest step, so a deployment must say
   * which realization it runs — `timeQte` in `main.ts`, a scripted one in tests.
   */
  timing: QteTimer;
  /** Builds the engine for one session; absent means this World cannot farm at all. */
  openSession?: (() => Promise<SessionOpen>) | undefined;
  /**
   * The battle openers the operator configured, and the reader that names the member whose command
   * phase is up (contracts §11). Absent leaves every battle to auto. A name that is not on the list —
   * including a null from a reader that cannot tell — takes the default action and lets the battle run.
   */
  battle?: { readonly openers: readonly BattleOpener[]; readonly reader: BattleMemberReader } | undefined;
  /** The loop's scheduler: on in production, off in tests so a tick runs only when asked. */
  autoTick?: boolean | undefined;
  /** The one clock. `performance.now()` unless a test says otherwise. */
  now?: (() => number) | undefined;
}

// --- constants the loop owns ----------------------------------------------------------------

/** Capture failures retried before the engine is treated as absent: warm-up, not failure (§5). */
const WARMUP_TICKS = 3;
/**
 * **Deliberate choice, not a spec value.** No contracts §8 key fixes how long a stall waits before
 * the loop asks for help. A quarter of `stallStopSeconds` leaves the model the other three quarters
 * to answer — 30 s at the defaults — which is also exactly `stallStopSeconds - escalateTimeoutMs`
 * (120 − 90), so an unanswered question still lands inside the session. Changing either key moves
 * this threshold; if that relationship matters, it belongs in the next spec revision.
 */
const STALL_ESCALATE_DIVISOR = 4;
/** Below this a stall-escalate floor would ask a question about a screen that is still settling. */
const MIN_STALL_ESCALATE_MS = 500;

/** One hour on the loop's clock: `escalateMaxPerHour`'s window. */
const HOUR_MS = 60 * 60 * 1000;
/** A stream pushes at most twice a second: a 10 Hz tick is not a 10 Hz repaint. */
const BROADCAST_MIN_INTERVAL_MS = 500;
/** `wvd_act` holdKey defaults, mirroring contracts §8.3's `hazardEscapeHoldMs` and §4's floor. */
const DEFAULT_ACT_HOLD_MS = 250;
const MIN_ACT_HOLD_MS = 40;
/** Windows set-1 scan codes for the WASD keys; the model names letters, the engine gets integers. */
const MOVEMENT_SCAN: Readonly<Record<string, number>> = { w: 0x11, a: 0x1e, s: 0x1f, d: 0x20 };
/**
 * What the loop does when nobody answers: reach for the map, the only surface the route can act
 * from — `F` is 移動至出口 only on the map, and 調査 in the 3D view (navigation §3d), so a blind
 * `F` is not a recovery. On the map the recovery is the exit itself (contracts §6).
 */
/**
 * Screens that can only be on screen while the party stands at something: the chest prompt, the
 * opener panel, the loot card, a battle. They answer a walk by themselves, because the stillness
 * rule cannot: the chest prompt animates its highlight (live 2026-11-01: two captures 0.5 s apart
 * differ on 394k pixels), so the frame never stands still and a walk handed over to the prompt
 * would never arrive — the loop then escalates instead of pressing 打开.
 */
const ARRIVAL_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'chest-prompt', 'chest-open', 'drop-item-claim', 'combat',
]);

function fallbackIntent(screen: ScreenId | null): Intent {
  // On the main character's death there is nothing to press: the question is Coo's (operator rule
  // 2026-11-05), and the game's own transition is the screen's business. A key here could skip a
  // revive prompt or land on a menu nobody named.
  if (screen === 'main-character-dead') return { kind: 'wait', ms: 1_000 };
  return screen === 'dungeonmap' ? { kind: 'exit' } : { kind: 'open-map' };
}

/**
 * The refusals that are the normal end of a pass, not a failed attempt: a dimmed 解除 (which our own
 * successful press produces for the bar's remaining ~3 s, chest spec §8a) and a bar that left. Logged
 * as warnings they would be ~30 false alarms per chest, so they are `info`; every other refusal is a
 * state where the loop wanted to press and could not, and stays `warn` (review, Important).
 */
function routineQteRefusal(reason: QteRefusal): boolean {
  return reason === 'resolved' || reason === 'bar-gone';
}

/**
 * **Deliberate choice, not a spec value.** Contracts §6's `RouteState` needs a chest budget and
 * contracts §8 has no key for one, so the loop uses "what the last map read showed". Before the
 * first map read there is no count, and 1 is the smallest number that makes the first decision
 * `open-map` rather than `exit`.
 */
const INITIAL_CHEST_BUDGET = 1;

/**
 * How many times the orientation may travel, and may climb, before it gives up (contracts §10).
 * One retry per step: the world map's travel retries its own gestures inside, so a whole-travel
 * retry is for a transition that landed badly; a second failed climb means the measured stair is
 * not where the party stands, and a third attempt would walk the same tile again.
 */
const ORIENT_TRAVEL_TRIES = 2;
const ORIENT_CLIMB_TRIES = 2;

/**
 * How many refusals before a cell is called unreachable. Two: the first walk after the map is named
 * can be eaten by the map's fade (live 2026-11-02), and the operator's rule is to claim every chest
 * that is available — the retry runs on a settled map and costs one tick.
 */
const WALK_RETRIES = 2;

/**
 * How many consecutive frames must answer the **same** ACTIVE member before the opener trusts it
 * (operator rule 2026-11-04: *until we get a stable frame, then confirm the current state*). One
 * readable frame can be a transition; two are the command phase. The wait it bounds is
 * `battleOpenerTimeoutMs`, not a fixed window.
 */
const BATTLE_STABLE_READS = 2;

/** How many X 关闭 taps a character page may take before the loop leaves it to the stall clock. */
const PAGE_CLOSE_TRIES = 3;

/**
 * How many ticks a readable map that carries no 楼梯-门 icon gets before the orientation stops. The
 * reader can miss the glyph on one frame (live 2026-11-03 22:07: the same floor and party tile as a
 * frame where it was found) — a frame is not a dead end, and twenty ticks are two seconds of looking.
 */
const ORIENT_MAP_ICON_PATIENCE = 20;

/**
 * How long after a battle's or a chest's last screen a heal is still owed. The flag is set by the
 * battle/chest and spent on the 3-D view; a trip through the dungeon (a climb, a travel) cancels it,
 * and this bound is the backstop so a stale flag cannot fire on a later arrival.
 */
const HEAL_WINDOW_MS = 30_000;

/**
 * How long the game may take to load after an orientation travel or a climb. The travel returns when
 * the world map leaves — or the Dungeon Select row is accepted — and the frames after it are the
 * load's own fade: black, or a flat colour, at confidence 0. The session classifier must stop on
 * such a frame, and live 2026-11-02 it ended two runs that had just arrived (北穿幽冥城, then 第三区).
 *
 * So the window is a *watch*: while it is open the loop keeps perceiving and keeps its stall clock,
 * but takes no verdict and sends nothing. The first named frame closes it early; the bound is what
 * keeps a load that never ends fatal. The entry script's `wait` + `expect dungeon` is the same fact
 * stated in data.
 */
const ORIENT_SETTLE_MS = 20_000;
/** The intents that send one command, as opposed to the ones that only hand the decision back. */
const COMMAND_KINDS: ReadonlySet<Intent['kind']> = new Set<Intent['kind']>([
  'open-map',
  'move',
  'exit',
  'open-chest',
]);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The badge tone for a state: running is on, offline is off, the rest are neutral. */
function stateTone(state: ConsoleState): 'on' | 'off' | 'plain' {
  if (state === 'running' || state === 'escalating') return 'on';
  return state === 'offline' ? 'off' : 'plain';
}

/** Every tool the escalation path needs; all four are wired by this loop. */
export const WVD_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wvd_status',
    description:
      'Report the WVD farming session: whether one is running, what it last decided, whether a question '
      + 'is waiting, and how much of the hourly escalation budget is left. Takes no arguments.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_look',
    description:
      'Capture the game window again and return the frame as an image together with what this World '
      + 'recognizes on it. Use it when the frame in the question is not enough, and after wvd_act to see '
      + 'what the input did. Works whether the loop is paused or running.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_act',
    description:
      'Send one input to the game window: a tap, a double tap, or a held movement key. Accepted only '
      + 'while a question from this World is waiting for you. x and y are pixels of the last image this '
      + 'World sent you — its size is in the [blob …] line; the World maps them onto the window. The '
      + 'receipt says whether the input was sent, not what the game did: call wvd_look to see that.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['tap', 'doubleTap', 'holdKey'],
          description: 'tap: one click at x, y. doubleTap: two clicks at the same place. holdKey: hold key for holdMs.',
        },
        x: { type: 'integer', minimum: 0, description: 'Pixel column on the last image, 0 at its left edge. tap and doubleTap only.' },
        y: { type: 'integer', minimum: 0, description: 'Pixel row on that image, 0 at its top edge. tap and doubleTap only.' },
        key: { type: 'string', enum: ['w', 'a', 's', 'd'], description: 'holdKey only: the movement key to hold.' },
        // The ceiling is contracts §4's: a longer hold could outlive the engine's teardown and
        // leave the key down (contracts §5), so it is refused rather than attempted.
        holdMs: { type: 'integer', minimum: 40, maximum: MAX_PRESS_HOLD_MS, description: `holdKey only: how long to hold, default 250, at most ${MAX_PRESS_HOLD_MS}.` },
      },
      required: ['kind'],
    },
  },
  {
    name: 'wvd_resume',
    description:
      'Answer the waiting question and let the farming loop run again. Call it once, after wvd_act and '
      + 'wvd_look have done what you want. intent is the decision for the loop; leave it out and the loop '
      + 'reads the screen again and lets the route policy decide. "move" walks to the nearest chest the '
      + 'last map read showed. "wait" lets the loop look again. '
      + 'The loop stays paused until this call or its own timeout, and then it takes its own fallback.',
    tags: ['flow'],
    barrierAfter: true,
    endsTurn: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: {
          type: 'object',
          additionalProperties: false,
          description: 'What the loop should do as soon as it resumes.',
          properties: {
            kind: { type: 'string', enum: ['open-map', 'move', 'open-chest', 'fight', 'exit', 'wait', 'stop'] },
            reason: { type: 'string', description: 'stop only: why the session should end.' },
          },
          required: ['kind'],
        },
        note: { type: 'string', description: 'One line for the session log: what you saw and why this is right.' },
      },
    },
  },
];

/** An intent the model named, or why it could not be read. A value, not a throw. */
export type ParsedIntent = { readonly ok: true; readonly intent: Intent | null } | { readonly ok: false; readonly detail: string };

/**
 * Map `wvd_resume`'s `intent` argument onto contracts §6's closed union.
 *
 * Only `kind` — and a stop's `reason` — is read. The model names no coordinate: a cell it picked out
 * of an image is not a cell this loop can check, and `wait`'s duration is the loop's cadence. So the
 * schema carries neither, and the two fields contracts §6 requires anyway are filled with a
 * placeholder the caller replaces: `move`'s target from the loop's last map read, `wait`'s duration
 * from nothing at all.
 */
export function parseIntent(value: unknown): ParsedIntent {
  if (value === undefined || value === null) return { ok: true, intent: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, detail: 'intent must be an object' };
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case 'open-map':
    case 'open-chest':
    case 'fight':
    case 'exit':
      return { ok: true, intent: { kind: record.kind } };
    // The route chooses the cell; the placeholder target is replaced by `#moveTarget()`.
    case 'move':
      return { ok: true, intent: { kind: 'move', target: { x: 0, y: 0 } } };
    // The tick cadence is the wait; contracts §6 requires a duration and nothing reads it.
    case 'wait':
      return { ok: true, intent: { kind: 'wait', ms: 0 } };
    case 'stop':
      return {
        ok: true,
        intent: {
          kind: 'stop',
          reason: typeof record.reason === 'string' && record.reason.trim() !== ''
            ? record.reason
            : 'the model asked to stop',
        },
      };
    default:
      return { ok: false, detail: `unknown intent kind: ${String(record.kind)}` };
  }
}

/**
 * A command that has been sent and whose own effect has not been answered yet.
 *
 * The screen is not the evidence: `move`'s effect *is* the map closing, so the screen changes as
 * soon as the key works. What releases a walk is arrival — the scene standing still — and what
 * releases `open-map` is the map itself.
 */
interface InFlight {
  readonly kind: 'open-map' | 'move' | 'exit' | 'open-chest' | 'fight';
  /** The screen the key was pressed on, for the "did this key belong here" evidence. */
  readonly fromScreen: ScreenId;
  readonly sinceMs: number;
  /** The last instant the arrival evidence moved; stillness is measured from here. */
  evidenceAtMs: number;
  /** The scene signature of the last frame measured, or null before the first measurement. */
  signature: SceneSignature | null;
  /** True once the walk is under way (the map closed, or the readout moved): only arrival ends it. */
  walking: boolean;
  /** The map readout at press time, so a party walking under an open map is not "no effect". */
  readonly readAtPress: MapRead | null;
  /**
   * The cell a `move` was aimed at. A walk that never started is a chest the game cannot path to,
   * and this is what lets the loop name it and skip it next time (operator rule 2026-11-02).
   */
  readonly target: Point | null;
  /**
   * The screens that answer this command. Absent keeps the default rule ("any screen but the one it
   * was pressed on"); present, only those screens answer — a modal sequence whose next frame is not
   * the answer, e.g. a QTE cancel answered by the 打开 prompt coming back.
   */
  readonly answers?: readonly ScreenId[] | undefined;
  /**
   * One action the loop may send while the answer has not arrived, on the screens that justify it.
   * The re-engage uses it for the step off the chest's tile: after a cancel the party stands on the
   * chest, so the prompt cannot be offered until it steps away (operator, 2026-10-31).
   */
  readonly whileWaiting?: {
    readonly when: readonly ScreenId[];
    readonly send: () => Promise<ActionResult>;
    sent: boolean;
  } | undefined;
}

/** What the last map read said: the loop's only measure of whether the farm advanced. */
interface MapRead {
  readonly floor: string;
  readonly player: Point;
  readonly chests: readonly Point[];
}

/**
 * The tick's own evidence, handed to `#execute` so a command that must ask for help can escalate on
 * the frame that decided it — the opener panel with no usable member is the first such command.
 */
interface TickContext {
  readonly session: WvdSession;
  readonly frame: Frame;
  readonly observation: Observation;
  readonly now: number;
}

/** Did the readout move on the map? That is the party walking, not the farm advancing. */
function mapReadMoved(previous: MapRead, next: MapRead): boolean {
  return previous.floor !== next.floor
    || previous.player.x !== next.player.x
    || previous.player.y !== next.player.y
    || previous.chests.length !== next.chests.length;
}

export class WvdWorld implements World {
  readonly id = WVD_ID;

  #host: WorldHost | null = null;
  #session: WvdSession | null = null;
  /** The task that owns this session's entry and exit (contracts §10); null without a task file. */
  #task: SessionTask | null = null;
  /** Completed exit scripts this session; the loop re-enters until `cfg.cycles` is reached. */
  #cyclesDone = 0;
  /**
   * Battles entered this session. The opener belongs to the **first** one (operator rule 2026-11-04,
   * refined 2026-11-04): the first battle of the first cycle is disengaged and cast; every later
   * battle is left to 自動 — the loop only makes sure it is on.
   */
  #battlesEntered = 0;
  /**
   * The battle's operation sequence (policy/battle-sequence.ts): created on the battle mode's first
   * frame, dropped when the mode leaves. One tap per tick, paced by `battleStepMs`.
   */
  #battleSequence: BattleSequence | null = null;
  /** The battle's five one-line notes: each is said once per battle, not once per tick. */
  #battleReadWarned = false;
  #battleSpeedWarned = false;
  #battleAutoWarned = false;
  #battleNotListedWarned = false;
  #battleAutoStuckWarned = false;
  /** The cast went out (a slot tap landed) — the opener was not given up. */
  #battleCastSent = false;
  /** The opener was given up for this battle: no confirmed turn card. Said once. */
  #battleOpenerGaveUp = false;
  /** The ACTIVE-member read and how many consecutive frames it has answered the same; per battle. */
  #battleRead: { readonly value: string | null; readonly frames: number } | null = null;
  /** The death scene has been sent to Coo for this death (one question, not one per tick). */
  #deathEscalated = false;
  /** Character-page close taps sent for the page on screen; the page's own name re-arms them. */
  #pageCloseTries = 0;
  #pageCloseWarned = false;
  /** Ticks in a row with a readable map that carries no 楼梯-门 icon (the orientation's patience). */
  #mapIconWaits = 0;
  /** The pacing primitive for the loop's direct taps (policy/pacing.ts): stable frame, one per pace. */
  #pacer = new Pacer();
  /**
   * The map was asked for before the question, once per unnamed episode (operator rule 2026-11-03):
   * an unnamed frame is often the 3-D view with something drawn over it, and the map names the floor
   * in text. Cleared by the next named screen.
   */
  #askedForMap = false;
  readonly #battle: { readonly openers: readonly BattleOpener[]; readonly reader: BattleMemberReader } | undefined;
  #unsubscribe: (() => void) | null = null;
  #running = false;
  #starting = false;
  #ticking = false;
  /** Every tick call gets an id, so a session that ends mid-tick cannot clear a later tick's flag. */
  #tickId = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  #sessionStartedAtMs = 0;
  /** Which pipeline owns the screen, held through unnamed frames (policy/mode.ts, contracts §6). */
  #mode: ModeMemory = INITIAL_MODE;
  #lastProgressAtMs = 0;
  #lastScreen: ScreenId | null = null;
  #lastMapRead: MapRead | null = null;
  #lastIntent: { readonly intent: Intent; readonly atMs: number } | null = null;
  #lastObservation: Observation | null = null;
  #ticks = 0;
  #captureFailures = 0;
  #willpower: readonly number[] = [];
  #chestsRemaining = INITIAL_CHEST_BUDGET;
  /**
   * The cells whose walk was given up on this cycle: no 自動移動 element, no movement, no path
   * (operator rule 2026-11-02). The route skips them and exits once none is left; a new cycle
   * clears the list, so a chest that failed once is attempted again on the next visit.
   */
  #unreachable: Point[] = [];
  /**
   * How many times a walk to a cell has been refused. A tile is only *unreachable* after two: the
   * first refusal is often the map's own fade eating the pointer gesture (live 2026-11-02), and the
   * operator's rule is to claim every chest that is available, skip only the ones that are not.
   */
  #walkFailures = new Map<string, number>();
  /** Rerolls spent on the chest's QTE; reset when a chest starts or ends (operator rule). */
  #qteRerolls = 0;
  /** The pass the policy saw on the last decision, recorded only while the baseline is filling. */
  #lastQtePass: QtePass | null = null;
  /** The reroll budget is spent with nothing better: the bar is taken as the last attempt. */
  #qteGivenUp = false;
  /**
   * A battle or a chest happened: heal when the loop is back on the 3-D view — and only then. The flag
   * is bounded (`#healDueAtMs`) and cancelled by an orientation command, so entering the dungeon on a
   * climb or a travel never heals (operator rule 2026-11-03: *only heal after battle and chest open*).
   */
  #healDue = false;
  #healDueAtMs = 0;

  /**
   * The orientation phase (contracts §10, the goal form). True from the session start until the map
   * shows the farm floor; while it is true the loop sends the orientation's commands and lets the
   * farm route answer the screens it owns (a chest, a bar, a fight).
   */
  #orienting = false;
  /** Aborts an orientation travel or climb when the session ends under it. */
  #orientAbort: AbortController | null = null;
  #orientTravelFailures = 0;
  #orientClimbs = 0;
  /** Until this instant the loop only watches: a travel or a climb just landed on a loading fade. */
  #settleUntilMs = 0;
  /** The screen the settle started from: the frame that still shows it is not the load finishing. */
  #settleFrom: ScreenId | null = null;
  /** The loot card's tap clock and count, so a modal that never leaves is bounded (lootTap*). */
  #lootTapAtMs: number | null = null;
  #lootTaps = 0;
  /** The result banner's continue arrow was sent for this visit to the item-claim screen. */
  #lootDismissed = false;
  /** Commands sent and waiting for their screen to answer (one at a time). */
  #inFlight: InFlight | null = null;
  /** Commands that changed nothing on this screen epoch: never re-sent until the farm advances. */
  #failed: Set<Intent['kind']> = new Set();
  /**
   * Why the last parsed opener panel had no usable member, for the question the escalation asks.
   * Set while the panel is on screen and cleared when it leaves (or a choice succeeds).
   */
  #openerRefusal: string | null = null;
  /** Push timestamps inside the hourly window; the count is a query, not a counter. */
  #escalationPushes: number[] = [];
  #escalationCooldownUntilMs = 0;
  /** When the screen became unnamed; null while it is named. The settle window's clock. */
  #unnamedSinceMs: number | null = null;
  /** Since when every frame has been unperceivable: a transition, until it proves otherwise. */
  #blankSinceMs: number | null = null;
  /** The cooldown window already reported: one wait is one line, not one per tick. */
  #cooldownNotedUntilMs = -1;
  #nextEscalationId = 1;
  #engineProblem: string | null = null;
  #lastStopReason: string | null = null;
  /** Whether the last session ended in a failure, which is the `error` state. */
  #lastFailed = false;
  /** The console's bounded transition log, oldest first. */
  #entries: ConsoleLogEntry[] = [];
  /** Open console streams. Empty unless the operator opened the panel. */
  #streams = new Set<WorldStreamSocket>();
  #lastBroadcastAtMs = 0;

  readonly #supervisor: Supervisor;
  readonly #cfg: WvdConfigSection;
  readonly #timezone: string;
  readonly #policy: FarmPolicy;
  readonly #classify: SessionClassifier;
  readonly #commands: RouteCommands;
  readonly #timing: QteTimer;
  readonly #openSession: (() => Promise<SessionOpen>) | undefined;
  readonly #autoTick: boolean;
  readonly #now: () => number;

  constructor(options: WvdWorldOptions) {
    this.#cfg = options.cfg;
    this.#timezone = options.timezone;
    this.#policy = options.policy;
    this.#classify = options.classify;
    this.#commands = options.commands;
    this.#timing = options.timing;
    this.#openSession = options.openSession;
    this.#autoTick = options.autoTick !== false;
    this.#battle = options.battle;
    this.#now = options.now ?? (() => performance.now());
    this.#supervisor = new Supervisor(() => this.#host, this.#now);
  }

  /** No environment section yet: the tool receipts carry what the model needs to know. */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  tools(): ToolDef[] {
    return WVD_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.#handlerFor(decl.name) }));
  }

  webUi(): WorldWebUiDecl {
    const status = this.#consoleStatus();
    return {
      label: 'WVD',
      lamps: [{ label: 'WVD', state: status.lamp, hint: status.detail ?? status.state }],
      badges: [
        { label: 'state', value: status.state, tone: stateTone(status.state) },
        { label: 'escalations', value: `${status.escalationsThisHour}/${status.escalateMaxPerHour}` },
      ],
      panels: [{
        id: CONSOLE_PANEL_ID,
        title: 'WVD console',
        description: 'The session state, the live strip, the open question and the recent log.',
        getMethods: CONSOLE_GET_METHODS,
      }],
      invoke: (panel, method) => this.invoke(panel, method),
      stream: (panel, socket) => this.stream(panel, socket),
      config: [WVD_CONFIG_GROUP],
    };
  }

  /**
   * One panel method, as a value: the panel renders a failure instead of a toast that disappears.
   * `getMethods` limits GET to the two read-only ones; this surface does not care how it arrived.
   */
  async invoke(panel: string, method: string): Promise<ConsoleResult<unknown>> {
    if (panel !== CONSOLE_PANEL_ID) return { ok: false, error: `no panel ${panel} on this World` };
    switch (method) {
      case 'status':
        return { ok: true, value: this.#consoleStatus() };
      case 'log':
        return { ok: true, value: this.#consoleLog() };
      case 'start':
        return this.#consoleStart();
      case 'stop':
        return this.#consoleStop();
      case 'cancel-escalation':
        return this.#consoleCancel();
      default:
        return {
          ok: false,
          error: `no method ${method} on the ${CONSOLE_PANEL_ID} console`,
          detail: 'status, log, start, stop, cancel-escalation',
        };
    }
  }

  /**
   * One push connection: a whole snapshot at once, so reconnecting never needs a diff. The World
   * broadcasts to every open connection itself; a socket that throws is dropped, never rethrown.
   */
  stream(panel: string, socket: WorldStreamSocket): void {
    if (panel !== CONSOLE_PANEL_ID) {
      socket.close(`no stream for ${panel}`);
      return;
    }
    socket.onClose(() => {
      this.#streams.delete(socket);
    });
    this.#streams.add(socket);
    this.#send(socket, this.#statusFrame());
  }

  async #consoleStart(): Promise<ConsoleResult<ConsoleStatus>> {
    const refusal = this.#startRefusal();
    if (!refusal.ok) return { ok: false, error: refusal.reason };
    if (!await this.startSession()) {
      return { ok: false, error: this.#lastStopReason ?? 'the session did not start' };
    }
    this.#broadcast(this.#now(), true);
    return { ok: true, value: this.#consoleStatus() };
  }

  async #consoleStop(): Promise<ConsoleResult<ConsoleStatus>> {
    // The question is closed before the session ends: a question must not outlive its run. The
    // paused tick then finds a stopped World and sends nothing.
    if (this.#supervisor.cancel()) this.#record('cancelled', 'the open question was cancelled first');
    await this.#endSession('the session was stopped', { report: true });
    return { ok: true, value: this.#consoleStatus() };
  }

  async #consoleCancel(): Promise<ConsoleResult<ConsoleStatus>> {
    if (!this.#supervisor.cancel()) return { ok: false, error: 'no question is open' };
    this.#broadcast(this.#now(), true);
    return { ok: true, value: this.#consoleStatus() };
  }

  /** Why `start` cannot run now, in the operator's words. The console shows it beside the button. */
  #startRefusal(): ConsoleStart {
    if (!this.#cfg.enabled) return { ok: false, reason: 'the World is disabled' };
    if (!this.#openSession) return { ok: false, reason: 'no engine is wired to this World' };
    if (this.#starting) return { ok: false, reason: 'a session is starting' };
    if (this.#running) return { ok: false, reason: 'a session is already running' };
    return { ok: true };
  }

  /**
   * The snapshot, derived from the World on every call. A state is never remembered separately from
   * the fact that produced it, so the panel cannot disagree with the loop.
   */
  #consoleStatus(): ConsoleStatus {
    const now = this.#now();
    const enabled = this.#cfg.enabled;
    const engine = this.#openSession !== undefined;
    const question = this.#supervisor.open;
    const state: ConsoleState =
      !enabled || !engine ? 'offline'
        // Opening a session is not a state of its own: nothing runs yet, and the lamp says loading.
        : this.#starting ? 'idle'
          : this.#running ? (question ? 'escalating' : 'running')
            : this.#lastFailed ? 'error'
              : this.#lastStopReason !== null ? 'stopped'
                : 'idle';
    const lamp: ConsoleLamp =
      !enabled || !engine ? 'offline'
        : this.#starting ? 'loading'
          : this.#running ? 'online'
            : this.#lastFailed ? 'error'
              : 'online';
    const observation = this.#lastObservation;
    const read = this.#lastMapRead;
    const intent = this.#lastIntent;
    const detail =
      state === 'offline'
        ? enabled ? 'no engine is wired to this World, so there is no game window to capture'
          : 'the World is disabled; enable it to start a session'
        : this.#starting ? 'a session is starting'
          : state === 'running' ? (this.#engineProblem === null ? null : `the engine reported a problem: ${this.#engineProblem}`)
            : this.#lastStopReason;
    return {
      state,
      lamp,
      detail,
      nowMs: now,
      screen: observation?.screen ?? null,
      mode: this.#mode.mode,
      floor: read?.floor ?? null,
      x: read?.player.x ?? null,
      y: read?.player.y ?? null,
      chestsLeft: read ? read.chests.length : null,
      intent: intent?.intent.kind ?? null,
      intentAgeMs: intent === null ? null : Math.max(0, now - intent.atMs),
      frameAgeMs: observation === null ? null : Math.max(0, now - observation.atMs),
      escalationsThisHour: this.#spentThisHour(now),
      escalateMaxPerHour: this.#cfg.escalateMaxPerHour,
      question: question === null ? null : {
        id: question.id,
        text: question.question,
        askedAtMs: question.atMs,
        timeoutMs: question.timeoutMs,
      },
      canStart: this.#startRefusal(),
      canCancel: question !== null,
    };
  }

  #consoleLog(): readonly ConsoleLogEntry[] {
    return [...this.#entries];
  }

  /** One transition, dated by both clocks: the wall time is what a morning reader has to go on. */
  #record(kind: ConsoleLogKind, text: string): void {
    this.#entries.push({ at: new Date().toISOString(), atMs: this.#now(), kind, text });
    if (this.#entries.length > CONSOLE_LOG_LIMIT) this.#entries.splice(0, this.#entries.length - CONSOLE_LOG_LIMIT);
  }

  #statusFrame(): string {
    const frame: ConsoleFrame = { type: 'status', value: this.#consoleStatus() };
    return JSON.stringify(frame);
  }

  #send(socket: WorldStreamSocket, text: string): void {
    try {
      socket.send(text);
    } catch {
      this.#streams.delete(socket);
    }
  }

  /**
   * Push the current snapshot to every open console. Costs nothing while no panel is open: the loop
   * must run exactly as it did before the panel existed.
   */
  #broadcast(now: number, force = false): void {
    if (this.#streams.size === 0) return;
    if (!force && now - this.#lastBroadcastAtMs < BROADCAST_MIN_INTERVAL_MS) return;
    this.#lastBroadcastAtMs = now;
    const text = this.#statusFrame();
    for (const socket of [...this.#streams]) this.#send(socket, text);
  }

  /** Mounting announces nothing; a session starts only when `enabled` is set or the operator asks. */
  /** One line for the operator console, from a module this World owns (the task runner). */
  note(line: string): void {
    this.#host?.log.info(line);
  }

  async start(host: WorldHost): Promise<void> {
    this.#host = host;
    if (this.#cfg.enabled && !this.#running) await this.startSession();
  }

  async stop(): Promise<void> {
    await this.#endSession('the session was stopped', { report: true });
  }

  // --- session lifecycle ---------------------------------------------------------------------

  isRunning(): boolean {
    return this.#running;
  }

  escalationsThisHour(): number {
    return this.#spentThisHour(this.#now());
  }

  /**
   * Open a session: build the engine's collaborators, reset the session's counters and start the
   * loop. Returns false when there is nothing to run, with the reason kept for `wvd_status`.
   * A second call while one is opening returns false rather than spawning a second child.
   */
  async startSession(): Promise<boolean> {
    if (this.#running) return true;
    if (this.#starting) return false;
    if (!this.#host || !this.#openSession) {
      this.#lastStopReason = 'no engine is wired to this World';
      return false;
    }
    this.#starting = true;
    try {
      let opened: SessionOpen;
      try {
        opened = await this.#openSession();
      } catch (error) {
        this.#lastStopReason = `the engine could not be started: ${message(error)}`;
        this.#lastFailed = true;
        this.#record('error', this.#lastStopReason);
        return false;
      }
      if (!opened.ok) {
        this.#lastStopReason = opened.reason === 'task-file-invalid'
          ? `the task file is invalid: ${opened.detail ?? 'no reason given'}`
          : 'the engine child did not start';
        this.#lastFailed = true;
        this.#record('error', this.#lastStopReason);
        return false;
      }
      const session = opened.session;
      this.#task = opened.task ?? null;

      this.#session = session;
      const now = this.#now();
      this.#running = true;
      this.#sessionStartedAtMs = now;
      // A new session starts with no mode: the first named frame sets it (the game may be anywhere).
      this.#mode = INITIAL_MODE;
      this.#lastProgressAtMs = now;
      this.#lastScreen = null;
      this.#lastMapRead = null;
      this.#lastIntent = null;
      this.#lastObservation = null;
      this.#qteRerolls = 0;
      this.#lastQtePass = null;
      this.#qteGivenUp = false;
      this.#lootTapAtMs = null;
      this.#lootTaps = 0;
      this.#ticks = 0;
      this.#captureFailures = 0;
      this.#willpower = [];
      this.#chestsRemaining = INITIAL_CHEST_BUDGET;
      this.#unreachable = [];
      this.#walkFailures = new Map();
      this.#inFlight = null;
      this.#failed = new Set();
      this.#openerRefusal = null;
      this.#escalationCooldownUntilMs = 0;
      this.#lastStopReason = null;
      this.#lastFailed = false;
      this.#engineProblem = null;
      this.#cyclesDone = 0;
      this.#battlesEntered = 0;
      this.#orienting = false;
      this.#orientAbort = null;
      this.#orientTravelFailures = 0;
      this.#orientClimbs = 0;
      this.#settleUntilMs = 0;
      this.#blankSinceMs = null;
      this.#rearmBattle();
      this.#record('started', 'the session started');
      this.#unsubscribe = session.onEngineEvent?.((event) => {
        void this.onEngineEvent(event);
      }) ?? null;
      // A goal task has no entry script: the loop orients from whatever screen the party is on, and
      // the first tick starts that work (contracts §10, the goal form). A scripted task instead runs
      // its entry before the first tick: nothing is farmed until the task's own floor gate has
      // passed. Both are cancellable because `#running` is already true.
      if (this.#task?.orient !== undefined) {
        this.#orienting = true;
        this.#host?.log.info(
          `wvd: orienting to ${this.#task.orient.goal.site} (farm floor ${this.#task.orient.floor})`,
        );
      } else if (this.#task !== null) {
        const entered = await this.#task.enter();
        if (!this.#running) return false;
        if (!entered.ok) {
          await this.#endSession(
            entered.reason === 'cancelled'
              ? 'the session was stopped during the task entry'
              : `the task entry stopped at step ${entered.step}: ${entered.reason}`,
            { report: true, failed: entered.reason !== 'cancelled' },
          );
          return false;
        }
        // The entry may end with a game-driven walk still under way (the 3F stair walks the party to
        // 第四区). The loop may not command a walking party, so the hand-off starts the arrival
        // bookkeeping with that walk: the first command waits for the scene to stand still.
        this.#handOffEntry(this.#now());
      }
      if (this.#autoTick) this.#schedule();
      return true;
    } finally {
      this.#starting = false;
    }
  }

  /**
   * Hand the party from a task entry script to the loop.
   *
   * A script is blind: its last step may start a game-driven walk (`自动移动` to a stair) and return
   * while the party is still walking. The loop's own rule is one command at a time — a `move` owns
   * the loop until the scene stands still — and the entry's walk is the same fact, so the hand-off
   * starts that bookkeeping with `walking: true`. The first command then waits for arrival exactly as
   * it does after the loop's own move, bounded by `automoveArrivalTimeoutMs`. The entry is progress,
   * so the stall clock restarts here too.
   *
   * Nothing is sent. If the walk was already over, the hand-off releases after the same stillness
   * window every arrival uses.
   */
  #handOffEntry(now: number): void {
    this.#lastProgressAtMs = now;
    this.#inFlight = {
      kind: 'move',
      fromScreen: 'dungeon',
      sinceMs: now,
      evidenceAtMs: now,
      signature: null,
      walking: true,
      readAtPress: null,
      target: null,
    };
  }

  /**
   * One tick. Public because the scheduler and the tests are the two callers, and because a skipped
   * tick must be observable: while one runs, every other call returns at once (no queue, no overlap).
   */
  async tick(): Promise<void> {
    if (!this.#running || this.#ticking) return;
    const session = this.#session;
    if (!session) return;
    this.#ticking = true;
    const id = ++this.#tickId;
    try {
      await this.#step(session);
    } catch (error) {
      // A module threw across its boundary (contracts §0.6): that is the loop's failure to handle.
      await this.#endSession(`a module failed: ${message(error)}`, { report: true, failed: true });
    } finally {
      if (this.#tickId === id) this.#ticking = false;
    }
    this.#broadcast(this.#now());
  }

  // --- the tick body -------------------------------------------------------------------------

  async #step(session: WvdSession): Promise<void> {
    this.#ticks += 1;

    const frame = await this.#capture(session);
    if (!frame || !this.#running || this.#session !== session) return;

    let observation: Observation;
    try {
      observation = await session.perceiver.observe(frame);
    } catch (error) {
      await this.#endSession(`perception failed: ${message(error)}`, { report: true, failed: true });
      return;
    }
    if (!this.#running || this.#session !== session) return;

    const now = this.#now();
    this.#lastObservation = observation;
    // The game's mode (operator rule 2026-11-03): a named screen moves it, an unnamed or loading frame
    // holds it — the battle keeps its mode through a skill's resolution and the revive QTE, the chest
    // through its bar's fades. The tick dispatches by this, not by the single frame.
    this.#mode = advanceMode(this.#mode, observation);
    // The session's first frame is the state the loop opened on, not a transition through it: seeding
    // the pacer there keeps a loop that starts on a static screen from spending a tick proving it.
    if (this.#ticks === 1) this.#pacer.observe(observation.screen);
    this.#pacer.observe(observation.screen);
    this.#track(observation);
    this.#measureProgress(observation, now);

    // A travel or a climb just landed: the game is in its load. A named frame means the load is over
    // and the loop carries on in this same tick; while the frame is nameless the loop only watches.
    // A black frame here is the transition itself, not a screen nobody could perceive — but the
    // window is bounded, so a load that never ends falls through to the classifier's stop.
    if (now < this.#settleUntilMs) {
      // A named frame ends the window — unless it is the very screen the command was sent from,
      // which is the tap that has not landed yet (live 2026-11-02: the still-visible Dungeon Select
      // list re-armed the travel three times).
      if (observation.confidence <= 0 || observation.screen === this.#settleFrom) return;
      this.#settleUntilMs = 0;
    }

    if (this.#cfg.sessionMaxMinutes > 0 && now - this.#sessionStartedAtMs >= this.#cfg.sessionMaxMinutes * 60_000) {
      await this.#endSession('the session time limit was reached', { report: true });
      return;
    }
    const stalledMs = now - this.#lastProgressAtMs;
    if (stalledMs >= this.#cfg.stallStopSeconds * 1000) {
      await this.#endSession(`nothing changed for ${this.#cfg.stallStopSeconds} s`, { report: true });
      return;
    }

    // The main character's death is Coo's decision, not the route's (operator rule 2026-11-05): the
    // World raises the frame to Coo once per death, and Coo decides whether to close the game and the
    // PC. Nothing is pressed here — there is no recovery module.
    if (observation.screen === 'main-character-dead') {
      if (!this.#deathEscalated) {
        this.#deathEscalated = true;
        this.#host?.log.warn('wvd: the main character died; asking Coo what to do');
        await this.#escalate(session, frame, observation, now);
      }
      return;
    }

    // The bar is a modal, sub-second window, and this tick's one command is the timing sub-loop. It
    // runs before the walk-aware in-flight book-keeping on purpose: the press is the time-critical
    // act, and a walk is not answered by a bar. The one record the bar *does* answer — an outstanding
    // opener click, whose panel dismissed into this screen — is released here, with the same "took
    // effect" book-keeping as `#advanceInFlight`'s own release, so a panel that comes back after the
    // bar is a fresh decision instead of a command still waiting. No intent is taken from the policy
    // and no route command is sent while the QTE is on screen.
    if (observation.screen === 'chest-qte') {
      // A cancel waiting for the prompt is not re-timed: the bar on screen is the one it just left,
      // or a frame the game has not retired yet. Only a press without a declared answer (the card
      // click) is answered here.
      if (this.#inFlight?.kind === 'open-chest' && this.#inFlight.answers === undefined) {
        this.#openerClickAnswered(observation.screen, now);
      }
      if (this.#inFlight?.answers === undefined) await this.#timeQte(session, frame);
      return;
    }

    // One command at a time: a sent command owns the loop until its own effect answers it. The
    // verdict is still taken — a stalled action has to be able to escalate — but nothing is sent.
    const waiting = await this.#advanceInFlight(observation, frame, now);

    // The heal is the game's own quick heal, and it is only valid from the 3-D view: a battle or a
    // chest set the flag, this tick spends it as one command (the four taps carry their own settles).
    if (this.#healDue && now - this.#healDueAtMs > HEAL_WINDOW_MS) this.#healDue = false;
    if (!waiting && this.#healDue && observation.screen === 'dungeon') {
      this.#healDue = false;
      const healed = await this.#commands.healParty();
      if (healed.ok) this.#host?.log.info('wvd: healed the party');
      else this.#host?.log.warn(`wvd: the heal was refused (${healed.reason})`);
      return;
    }

    // The character page: a menu the heal (or an operator) opens, and a screen the loop *finishes* —
    // operator rule 2026-11-03: *after open and heal there shall be a close of the character panel, so
    // go back to the dungeon*. Its X 关闭 tile is the evidence that names it, so the close is verified
    // by the next frame rather than hoped for; a page that stays costs one tap per tick, capped.
    if (!waiting && observation.screen === 'character-page') {
      // Paced (operator rule 2026-11-03): the page animates while it closes, and a tap sent into that
      // animation lands on the 3-D view and opens another member's page. One tap per pace, on a frame
      // that has stopped moving.
      if (!this.#pacer.ready(now)) return;
      this.#pacer.act(now);
      if (this.#pageCloseTries >= PAGE_CLOSE_TRIES) {
        if (!this.#pageCloseWarned) {
          this.#pageCloseWarned = true;
          this.#host?.log.warn(`wvd: the character page did not close after ${PAGE_CLOSE_TRIES} taps`);
        }
        return;
      }
      this.#pageCloseTries += 1;
      const closed = await this.#commands.closeCharacterPage();
      if (closed.ok) this.#host?.log.info('wvd: closed the character page');
      else this.#host?.log.warn(`wvd: the character page close was refused (${closed.reason})`);
      return;
    }

    // The harken's floor menu (operator rule 2026-11-03): the list is not fixed — a harken offers a
    // floor only once that floor's harken is reconstructed — so the climb reads it. The task names the
    // farm floor's row; when the menu offers it the World taps it (the teleport). When it does not, the
    // 归还 row backs the party out and the stair icon is the way up.
    if (!waiting && observation.screen === 'harken-menu') {
      if (!this.#pacer.ready(now)) return;
      const destination = this.#task?.orient?.goal.climb?.destination;
      const wanted = destination === undefined
        ? null
        : observation.rows.find((row) => row.label === destination) ?? null;
      if (wanted !== null) {
        this.#pacer.act(now);
        const tapped = await this.#commands.tapPoint(wanted.at);
        if (tapped.ok) this.#host?.log.info(`wvd: the harken offers ${destination}; tapping its row`);
        else this.#host?.log.warn(`wvd: the harken row tap was refused (${tapped.reason})`);
        return;
      }
      const backOut = observation.rows.find((row) => row.label === '归还') ?? null;
      if (backOut === null) return;
      this.#pacer.act(now);
      const tapped = await this.#commands.tapPoint(backOut.at);
      if (tapped.ok) this.#host?.log.info('wvd: the harken does not offer the farm floor; backing out with 归还');
      else this.#host?.log.warn(`wvd: the harken 归还 tap was refused (${tapped.reason})`);
      return;
    }

    const state: RouteState = {
      observation,
      mode: this.#mode.mode,
      willpower: this.#willpower,
      chestsRemaining: this.#chestsRemaining,
      unreachable: this.#unreachable,
    };
    const spent = this.#spentThisHour(now);
    // A transition is unnamed for a few ticks and resolves by itself: the clock starts on the first
    // unnamed frame and a named screen clears it, so the question is only asked once the screen has
    // stayed nameless for `escalateSettleMs` (`worlds.wvd.escalateSettleMs`). The stall clock below is
    // the backstop for a transition that never ends.
    // A frame nobody perceived is a transition far more often than a dead game: the load fades and the
    // battle's own fades both read as `unknown` at confidence 0 (live 2026-11-02 — a battle's fade
    // ended an unattended run two minutes after the climb and the chest had both worked). The
    // classifier's stop is held for `escalateSettleMs` while the frames stay blank; the bound is what
    // keeps a dead game fatal, and the stall clock is the backstop behind it.
    const blank = observation.confidence <= 0;
    if (blank) this.#blankSinceMs ??= now;
    else this.#blankSinceMs = null;

    const unnamed = observation.screen === 'unknown' && observation.confidence > 0;
    // The frame's own evidence says the dungeon view, but no recogniser named it: the 3-D view with
    // something drawn over it. That is the frame the loop asks the game's map about (§3, operator rule
    // 2026-11-03).
    const dungeonLike = observation.screen === 'unknown' && observation.dungeonLike === true;
    if (unnamed) this.#unnamedSinceMs ??= now;
    else {
      this.#unnamedSinceMs = null;
      this.#askedForMap = false;
    }
    const unnamedSinceMs = this.#unnamedSinceMs;

    let verdict = this.#classify(state, spent, this.#cfg.escalateMaxPerHour);
    if (verdict === 'escalate' && unnamedSinceMs !== null && now - unnamedSinceMs < this.#cfg.escalateSettleMs) {
      verdict = 'ok';
    }
    // Operator rule 2026-11-03: inside a known mode an unnamed frame is that mode's own business — a
    // battle is still the battle while its skill resolves or its revive QTE is up, a chest still the
    // chest while its bar fades. Only the unknown mode asks the model about a frame nothing named.
    if (verdict === 'escalate' && unnamed && this.#mode.mode !== 'unknown') verdict = 'ok';
    // The nothing-perceived stop is the transition's, not one frame's: hold it while the blank frames
    // are still young. A session whose frames never come back stops at `escalateSettleMs`.
    if (verdict === 'stop' && blank && now - (this.#blankSinceMs ?? now) < this.#cfg.escalateSettleMs) {
      return;
    }
    if (verdict === 'ok' && stalledMs >= this.#stallEscalateMs()) verdict = 'escalate';

    // Operator rule 2026-11-03: ask the game before asking the model. An unnamed frame is often the
    // 3-D view with something over it — the menu legend draws a panel whose ink reads as a map title,
    // and a bright scene fills the title band (measured on
    // testdata/screens/2026-11-03-gmenu/gmenu-3d-view.jpg: minimap arrow 35 px, title-band ink 5 119 px,
    // t-mvy23qe2). The map states the floor in text and is one command away, so that command is sent
    // once per unnamed episode; only a frame still unnamed afterwards becomes a question. This is the
    // same recovery the question's own timeout already takes, moved in front of the 90 s.
    if (verdict === 'escalate' && dungeonLike && !this.#askedForMap && !waiting) {
      this.#askedForMap = true;
      this.#host?.log.info('wvd: the frame is unnamed; opening the map to ask the game before the question');
      await this.#execute(fallbackIntent(observation.screen), observation.screen, {
        session,
        frame,
        observation,
        now,
      });
      return;
    }

    switch (verdict) {
      case 'stop':
        await this.#endSession(this.#stopReason(observation, spent), { report: true });
        return;
      case 'escalate':
        await this.#escalate(session, frame, observation, now);
        return;
      case 'ok':
        break;
    }

    if (waiting) return;

    // The orientation (contracts §10, the goal form): from whatever screen the session started on,
    // one command per tick until the map shows the farm floor. A screen the farm owns — a chest,
    // the bar, the loot card, a battle — yields to the route below, so the orientation never
    // abandons something the party is in the middle of.
    if (this.#orienting) {
      const orient = this.#task?.orient;
      if (orient === undefined) {
        this.#orienting = false;
      } else {
        const decision = nextOrientStep(observation, orient);
        if (decision.kind === 'arrived') {
          this.#orienting = false;
          this.#host?.log.info(`wvd: on the farm floor (${orient.floor}); the farm takes over`);
        } else if (decision.kind === 'wait') {
          if (decision.reason !== 'map-icon') return;
          this.#mapIconWaits += 1;
          if (this.#mapIconWaits <= ORIENT_MAP_ICON_PATIENCE) return;
          const icons = observation.screen === 'dungeonmap'
            ? observation.map.icons.map((icon) => icon.kind).join(', ') || 'none'
            : 'not the map';
          await this.#stopWithEvidence(
            session,
            frame,
            `the map carries no 楼梯-门 icon after ${ORIENT_MAP_ICON_PATIENCE} reads (icons: ${icons})`,
          );
          return;
        } else if (decision.kind === 'stop') {
          await this.#stopWithEvidence(session, frame, decision.reason);
          return;
        } else if (decision.kind === 'command') {
          this.#mapIconWaits = 0;
          await this.#orientTo(decision.command, observation.screen);
          return;
        }
        // 'yield' falls through: the farm route finishes the chest or the fight the party is in.
      }
    }

    const intent = this.#policy.next(state);
    if (COMMAND_KINDS.has(intent.kind) && this.#failed.has(intent.kind)) {
      // A blind retry is not a decision: `openMap`'s second `G` on an already-open map is
      // 移动至目的地. The stall clock turns this into an escalation instead.
      this.#host?.log.warn(`wvd: ${intent.kind} already changed nothing on this screen; not sending it again`);
      return;
    }
    await this.#execute(intent, observation.screen, { session, frame, observation, now });
  }

  /** Warm-up aware capture: a failure is a skipped tick until the retries are spent (§5). */
  async #capture(session: WvdSession): Promise<Frame | null> {
    try {
      const frame = await session.source.capture();
      this.#captureFailures = 0;
      return frame;
    } catch (error) {
      this.#captureFailures += 1;
      if (this.#captureFailures <= WARMUP_TICKS) {
        this.#host?.log.warn(
          `wvd: capture failed (${this.#captureFailures}/${WARMUP_TICKS}); the engine may still be warming up`,
          message(error),
        );
        return null;
      }
      await this.#endSession(`the engine stopped answering: ${message(error)}`, { report: true, failed: true });
      return null;
    }
  }

  /** Drop the battle's sequence: the next battle's settle, counts and notes start fresh. */
  #rearmBattle(): void {
    this.#battleSequence = null;
    this.#rearmBattleNotes();
  }

  /** The three once-per-battle notes, cleared with the sequence they annotate. */
  #rearmBattleNotes(): void {
    this.#battleReadWarned = false;
    this.#battleSpeedWarned = false;
    this.#battleAutoWarned = false;
    this.#battleNotListedWarned = false;
    this.#battleAutoStuckWarned = false;
    this.#battleCastSent = false;
    this.#battleOpenerGaveUp = false;
    this.#battleRead = null;
  }

  /** The two counts the route's `RouteState` needs, from the observation that carries them. */
  #track(observation: Observation): void {
    if (observation.screen !== 'main-character-dead') this.#deathEscalated = false;
    if (observation.screen !== 'chest-open') this.#openerRefusal = null;
    if (observation.screen !== 'character-page') {
      this.#pageCloseTries = 0;
      this.#pageCloseWarned = false;
    }
    // The battle's sequence lives as long as the battle **mode** does (operator rule 2026-11-04): an
    // unnamed frame inside a battle (a skill's resolution, a fade) is still the battle, and re-arming
    // there would let the opener be cast a second time.
    if (this.#mode.mode === 'battle') {
      if (this.#battleSequence === null) {
        // The opener is the **first battle of the first cycle**'s (operator rule 2026-11-04, refined):
        // that one is disengaged — 自動 off, the opener cast once, 自動 on. Every later battle is left
        // to 自動, which the sequence presses on when it is off; no cast, no turn-card read.
        const firstBattle = this.#cyclesDone === 0 && this.#battlesEntered === 0;
        this.#battlesEntered += 1;
        this.#battleSequence = new BattleSequence({
          settleMs: Math.max(0, this.#cfg.battleSettleMs),
          stepMs: Math.max(OPERATION_PACE_MS, this.#cfg.battleStepMs),
          openerTimeoutMs: Math.max(1, this.#cfg.battleOpenerTimeoutMs),
          toggleAttempts: Math.max(1, this.#cfg.autoBattleEnableAttempts),
          openers: firstBattle && !this.#cfg.dryRun ? (this.#battle?.openers ?? []) : [],
        });
        this.#battleSequence.enter(this.#now());
        this.#rearmBattleNotes();
      }
    } else {
      this.#rearmBattle();
    }
    if (observation.screen !== 'drop-item-claim') {
      this.#lootTapAtMs = null;
      this.#lootTaps = 0;
      this.#lootDismissed = false;
    }
    if (observation.screen === 'chest-open') {
      // A willpower the panel did not show (the main character draws no heart) or could not read is
      // not a spendable number: it is left out of the budget rather than counted as zero or as a
      // substitute, so "every member is at zero" still means every *read* value is at zero.
      this.#willpower = observation.opener.members
        .map((member) => member.willpower)
        .filter((willpower): willpower is number => willpower !== null && Number.isFinite(willpower));
    }
    if (observation.screen === 'dungeonmap') {
      // The map is the only chest count the loop has: what the map still shows is the budget.
      this.#chestsRemaining = observation.map.icons.filter((icon) => icon.kind === 'chest').length;
    }
  }

  /**
   * Whether the farm advanced. **State, not screen identity**: the party's position, the floor and
   * the chest count are the map readout's facts, and entering a screen a walk produces is the other
   * signal. A dungeon ↔ map cycle at the same position therefore counts for nothing, which is what
   * stops an alternation masquerading as progress (Task 10 review, Critical).
   *
   * The two questions are kept apart. *Activity* is anything happening on screen, and it keeps the
   * stall clock alive; *advance* is the farm moving on, and only that re-opens a command that
   * failed. While a walk is outstanding a changed readout is the party walking — navigation §3d:
   * automove does not care whether the map is open, so the map can stay up during the walk — so it
   * is activity, not advance. Otherwise every readout tick would clear `#failed` mid-walk and the
   * command the walk never answered could be sent again the moment it gave up (Critical 2).
   */
  #measureProgress(observation: Observation, now: number): void {
    let advanced = false;
    let active = false;
    switch (observation.screen) {
      case 'dungeonmap': {
        const read: MapRead = {
          floor: observation.map.floorTitle,
          player: observation.map.player,
          chests: observation.map.icons.filter((icon) => icon.kind === 'chest').map((icon) => icon.at),
        };
        const previous = this.#lastMapRead;
        const changed = previous === null
          || previous.floor !== read.floor
          || previous.player.x !== read.player.x
          || previous.player.y !== read.player.y
          || previous.chests.length !== read.chests.length;
        this.#lastMapRead = read;
        if (changed) {
          active = true;
          advanced = !this.#walkOutstanding();
        }
        break;
      }
      case 'chest-prompt':
      case 'chest-open':
      case 'chest-qte':
      case 'chest-opening':
      case 'drop-item-claim':
      case 'combat':
        // A screen a walk produces. Staying on one is not progress, so a fight that never ends stalls.
        // The prompt is here because the game returns to it by itself after a chest's animation: that
        // arrival is the farm alive again, and the loop must be given the tick to press 打开 (live
        // 2026-11-03: the prompt appeared on the very tick the stall clock stopped the session).
        advanced = this.#lastScreen !== observation.screen;
        active = advanced;
        break;
      default:
        // `dungeon`, `loading`, `town`, `worldmap`, `unknown`: the map readout is the measure.
        break;
    }
    // The reroll budget is per chest: the prompt starts one, and the item claim or a battle closes it. The
    // panel (`chest-open`) deliberately does not reset it — a reroll goes QTE → panel → QTE.
    // Not at `chest-prompt`: a reroll's own re-engagement passes through it, and the budget belongs
    // to the chest, not to the approach.
    if (observation.screen === 'drop-item-claim' || observation.screen === 'combat') {
      this.#qteRerolls = 0;
      this.#lastQtePass = null;
      this.#qteGivenUp = false;
      // Both are the moments after which the party is hurt: heal once the loop is back on the view.
      this.#healDue = true;
      this.#healDueAtMs = now;
    }
    // A screen that changed is not the screen the command failed on: the lockout is per screen, not
    // per episode. (The map-open press can fail by toggling an already-open map shut; without this the
    // orientation refused G forever and the stall clock ended the session — live 2026-11-03 21:49.)
    if (this.#lastScreen !== observation.screen) this.#failed.clear();
    this.#lastScreen = observation.screen;
    if (active) this.#lastProgressAtMs = now;
    // The farm moved on: a command that failed before may be worth sending again.
    if (advanced) this.#failed.clear();
  }

  /** Is a walk (a command whose effect is the party moving) still un-answered? */
  #walkOutstanding(): boolean {
    return this.#inFlight !== null && (this.#inFlight.kind === 'move' || this.#inFlight.kind === 'exit');
  }

  /**
   * The opener click was answered: the screen moved off the one the click was made on — the panel
   * for a prompt press, the bar for a trapped chest, loot, or a battle for a card press. The command
   * is released and the change is progress, so a command that failed before may be worth sending
   * again.
   */
  #openerClickAnswered(screen: ScreenId, now: number): void {
    this.#inFlight = null;
    this.#lastProgressAtMs = now;
    this.#failed.clear();
    this.#host?.log.info(`wvd: open-chest took effect: the screen is now ${screen}`);
  }

  /**
   * Book-keeping for the command sent on an earlier tick. Returns true while it is still waiting.
   *
   * The release rules are per command, because "what this key produces" is per command:
   *
   * - `open-map` is answered by **the map arriving** (that is the key's whole purpose), or by the
   *   screen moving somewhere else on its own (a battle, a loading pause) — then the presses are
   *   moot and the route decides what the new screen wants. It gives up when the scene has been
   *   still for `automoveStillSeconds` (the menu opened but the map never did) or after
   *   `mapOpenTimeoutMs`, the key the config declares for exactly this wait.
   * - `move`/`exit` are answered by **arrival**: the walk starts (the map closes, or the readout
   *   moves under an open map) and ends when the scene stands still for `automoveStillSeconds`.
   *   While the walk is outstanding, no other command is sent — that is the whole point. A walk that
   *   never starts (the map stays put, nothing moves) has changed nothing and is recorded failed; one
   *   that never arrives is given up at `automoveArrivalTimeoutMs`, also failed.
   * - `open-chest` is answered by **the screen moving off the one the press was made on**: for a
   *   prompt press the panel is the answer, for a card press the QTE, loot or battle that follows it
   *   (chest §3a). The screen the press was made on is *not* an answer — a prompt that stays up has
   *   not taken the click yet — and neither is `unknown`, which is the opening animation or a fade.
   *   The loop must not wait for a bar that may never come. A press still unanswered after
   *   `openerPanelTimeoutMs` (the live panel arrived 4.6–8 s after the click, so this is its own
   *   key, not the map's) has changed nothing and is recorded failed, like any other command.
   *
   * Arrival is not a failure: the farm advanced, so the command is not held against the next tick.
   */
  async #advanceInFlight(observation: Observation, frame: Frame, now: number): Promise<boolean> {
    const inFlight = this.#inFlight;
    if (!inFlight) return false;

    // The opener click is answered by the screen moving off the one it was made on: the panel for
    // the prompt's 打开, what follows the panel for a card (the QTE for a trapped chest included,
    // chest §3a). The screen the press was made on and `unknown` are not answers: the prompt may
    // not have taken the click yet, and the opening animation or a fade is a frame nothing named.
    if (inFlight.kind === 'open-chest') {
      // A declared answer set (the QTE cancel): only those screens answer, and while the answer is
      // still owed the loop may send exactly one intermediate action. The route policy never runs
      // in this window, which is the whole point — the frame after a cancel is a plain 3-D view,
      // and the route's answer to that is `open-map` (a G pressed over the chest).
      if (inFlight.answers !== undefined) {
        if (inFlight.answers.includes(observation.screen)) {
          this.#openerClickAnswered(observation.screen, now);
          return false;
        }
        const step = inFlight.whileWaiting;
        if (step !== undefined && !step.sent && step.when.includes(observation.screen)) {
          step.sent = true;
          const sent = await step.send();
          this.#host?.log[sent.ok ? 'info' : 'warn'](sent.ok
            ? 'wvd: re-engaging the chest: stepped off its tile'
            : `wvd: the chest re-engage step was refused (${sent.reason})`);
        }
        const waitedMs = now - inFlight.sinceMs;
        const timeoutMs = Math.max(1, this.#cfg.openerPanelTimeoutMs);
        if (waitedMs >= timeoutMs) {
          this.#inFlight = null;
          this.#failed.add('open-chest');
          this.#host?.log.warn(
            `wvd: the chest did not come back after the QTE cancel (${Math.round(waitedMs)} ms); `
              + 'not re-engaging it until the farm advances',
          );
          return false;
        }
        return this.#inFlight !== null;
      }
      // The answer is a *change*: the panel for a prompt press, the QTE/loot/battle for a card
      // press. The screen the press was made on and `unknown` are both not answers.
      if (observation.screen !== 'unknown' && observation.screen !== inFlight.fromScreen) {
        this.#openerClickAnswered(observation.screen, now);
        return false;
      }
      const waitedMs = now - inFlight.sinceMs;
      const timeoutMs = Math.max(1, this.#cfg.openerPanelTimeoutMs);
      if (waitedMs >= timeoutMs) {
        this.#inFlight = null;
        this.#failed.add('open-chest');
        this.#host?.log.warn(
          'wvd: the opener panel never answered the click; not clicking it again until the farm advances',
          { waitedMs, timeoutMs },
        );
      }
      return this.#inFlight !== null;
    }

    const isWalk = inFlight.kind !== 'open-map';

    // 0. A screen that can only exist when the party has stopped answers the walk itself, before
    //    stillness is measured: those screens animate, so the stillness rule can never fire on them.
    if (isWalk && ARRIVAL_SCREENS.has(observation.screen)) {
      this.#inFlight = null;
      this.#lastProgressAtMs = now;
      this.#failed.clear();
      this.#host?.log.info(`wvd: ${inFlight.kind} arrived: the screen is ${observation.screen}`);
      return false;
    }

    // 1. The command's own key working ------------------------------------------------------------
    if (!isWalk) {
      if (observation.screen === 'dungeonmap') {
        this.#inFlight = null;
        this.#host?.log.info('wvd: open-map took effect: the map is open');
        return false;
      }
      if (observation.screen !== inFlight.fromScreen && observation.screen !== 'unknown') {
        // The screen moved on without the map: a battle, a loading pause, a chest panel. Not a
        // failure — the farm did not stay put — and the route decides what the new screen wants.
        this.#inFlight = null;
        this.#host?.log.info(`wvd: open-map was overtaken: the screen is now ${observation.screen}`);
        return false;
      }
    } else if (!inFlight.walking) {
      // The walk has started if the map closed, or if the party is already moving under an open one.
      const moved = inFlight.readAtPress !== null && this.#lastMapRead !== null
        && mapReadMoved(inFlight.readAtPress, this.#lastMapRead);
      if (observation.screen !== 'dungeonmap' || moved) {
        inFlight.walking = true;
        inFlight.evidenceAtMs = now;
        inFlight.signature = null;
        const where = observation.screen === 'dungeonmap'
          ? 'the party is moving on the map'
          : `the map closed (${observation.screen})`;
        this.#host?.log.info(`wvd: ${inFlight.kind} took effect: ${where}`);
      }
    }

    // 2. Stillness: contracts §8.3's `automoveStillSeconds`, measured on the frame ---------------
    const stillMs = await this.#measureStillness(frame, inFlight, now);
    const stillForMs = Math.max(1, this.#cfg.automoveStillSeconds * 1000);
    const waitedMs = now - inFlight.sinceMs;

    if (stillMs !== null && stillMs >= stillForMs) {
      if (inFlight.walking) {
        // Arrival: the party stopped. The walk is over and it succeeded, so it is progress.
        this.#inFlight = null;
        this.#lastProgressAtMs = now;
        this.#failed.clear();
        this.#host?.log.info(`wvd: ${inFlight.kind} arrived: the scene has been still for ${stillMs} ms`);
        return false;
      }
      this.#inFlight = null;
      this.#gaveUp(inFlight, { stillMs, waitedMs });
      return false;
    }

    // 3. The hard give-up, by the key that owns it ------------------------------------------------
    const timeoutMs = isWalk ? this.#cfg.automoveArrivalTimeoutMs : this.#cfg.mapOpenTimeoutMs;
    if (waitedMs >= Math.max(1, timeoutMs)) {
      this.#inFlight = null;
      this.#gaveUp(inFlight, { waitedMs, timeoutMs });
      return false;
    }
    return true;
  }

  /**
   * A command that changed nothing. Two outcomes, and the difference is the operator's rule
   * (2026-11-02):
   *
   * - a **`move` that never started** is a chest the game has no path to — the tap raised no 自動移動
   *   element and the party did not move. Its cell goes on the cycle's skip list, so the route aims
   *   at another chest (or exits when none is left) instead of treating the whole farm as stuck. The
   *   command is *not* recorded failed: the next move is a different chest, not a blind retry.
   * - every other command is recorded failed, as before: it is not re-sent until the farm advances.
   */
  #gaveUp(inFlight: InFlight, evidence: Record<string, number>): void {
    const target = inFlight.target;
    if (inFlight.kind === 'move' && target !== null) {
      this.#skip(target, 'the walk never started', evidence);
      return;
    }
    this.#failed.add(inFlight.kind);
    this.#host?.log.warn(
      `wvd: ${inFlight.kind} changed nothing; not sending it again until the farm advances`,
      evidence,
    );
  }

  /**
   * A cell the game will not walk to goes on this cycle's skip list (operator rule, 2026-11-02): the
   * route aims at the next chest, and a floor whose chests are all here is done — the exit is the next
   * stage. It is not a failed command: the next `move` is a different chest, not a blind retry.
   */
  #skip(target: Point, why: string, evidence: Record<string, number> = {}): void {
    const key = `${target.x},${target.y}`;
    const failures = (this.#walkFailures.get(key) ?? 0) + 1;
    this.#walkFailures.set(key, failures);
    // One refusal is often the map's fade eating the pointer gesture (the map is read on its first
    // named frame, the walk follows within ~200 ms). The rule is to claim every chest that is
    // available and skip only the ones that are not, so a cell is marked unreachable on the second
    // refusal — the retry runs on a settled map and costs one tick.
    if (failures < WALK_RETRIES) {
      this.#host?.log.warn(
        `wvd: the chest at ${target.x},${target.y} cannot be walked to (${why}); trying once more`,
        evidence,
      );
      return;
    }
    const known = this.#unreachable.some((cell) => cell.x === target.x && cell.y === target.y);
    if (!known) this.#unreachable.push(target);
    this.#host?.log.warn(
      `wvd: the chest at ${target.x},${target.y} cannot be walked to (${why}); skipping it this cycle`,
      evidence,
    );
  }

  /**
   * Compare this frame's scene signature with the last one and answer **how long the scene has been
   * still**, or null when there are no pixels to compare (a decode failure is no evidence either
   * way: the timeouts above end the wait).
   */
  async #measureStillness(frame: Frame, inFlight: InFlight, now: number): Promise<number | null> {
    let signature: SceneSignature;
    try {
      signature = sceneSignature(await frame.toRgba());
    } catch {
      return null;
    }
    if (inFlight.signature === null || !sceneIsStill(inFlight.signature, signature)) {
      inFlight.evidenceAtMs = now;
    }
    inFlight.signature = signature;
    return now - inFlight.evidenceAtMs;
  }

  // --- the escalation ------------------------------------------------------------------------

  async #escalate(session: WvdSession, frame: Frame, observation: Observation, now: number): Promise<void> {
    if (this.#supervisor.isOpen()) return;
    if (now < this.#escalationCooldownUntilMs) {
      // One line per cooldown, not one per tick: the cooldown is `escalateTimeoutMs` long and the
      // loop ticks at ~10 Hz inside it (measured 2026-10-31: ~900 lines in 90 s).
      if (this.#cooldownNotedUntilMs !== this.#escalationCooldownUntilMs) {
        this.#cooldownNotedUntilMs = this.#escalationCooldownUntilMs;
        this.#host?.log.warn('wvd: still cooling down after the last question; not asking again yet');
      }
      return;
    }
    const spent = this.#spentThisHour(now);
    if (spent >= this.#cfg.escalateMaxPerHour) {
      await this.#endSession('the escalation budget for this hour is spent', { report: true });
      return;
    }

    // The snapshot is a second capture at the escalation width; the verdict's frame stays the
    // authority for the decision, and its `atMs` is what the event dates the question by.
    const maxWidth = this.#cfg.escalationImageWidth;
    const snapshot = await takeSnapshot(session.snapshot, maxWidth);
    // A stop can land inside that capture. Nothing may be asked — or acted on — after it.
    if (!this.#running || this.#session !== session) return;
    const image = snapshot ? snapshotBlob(snapshot) : null;
    const imageVisible = this.#supervisor.imageAccepted();
    const question = this.#question(observation);
    const id = `esc-${this.#nextEscalationId++}`;
    const timeoutMs = this.#cfg.escalateTimeoutMs;
    // The recovery the model is told about, and the one the loop takes, are the same decision:
    // on the map it is the exit; anywhere else it is opening the map — never `F` blind (§3d).
    const fallback = fallbackIntent(observation.screen);

    const envelope = stuckEvent({
      timezone: this.#timezone,
      at: new Date(),
      atMs: frame.atMs,
      escalationId: id,
      ticksStuck: Math.max(1, Math.round((now - this.#lastProgressAtMs) / Math.max(1, this.#cfg.tickMs))),
      observation,
      question,
      fallbackLine: fallbackPhrase(fallback),
      timeoutMs,
      fallback,
      escalationsThisHour: spent,
      maxPerHour: this.#cfg.escalateMaxPerHour,
      image,
      imageVisible,
    });

    const outcome: EscalationOutcome = await this.#supervisor.escalate({
      envelope,
      question,
      id,
      atMs: now,
      frameWidth: frame.width,
      image: snapshot ? { width: snapshot.width, height: snapshot.height } : null,
      fallback,
      timeoutMs,
      onPush: () => {
        // The count arms the cap at the push, not at the answer: an unanswered question is spent.
        this.#recordEscalation(now);
        this.#record('escalated', question);
        this.#broadcast(this.#now(), true);
      },
    });

    // The session may have been stopped while the question was open. A cancelled outcome says so,
    // but a stop that raced the push settles nothing; either way a stopped loop sends no input.
    if (!this.#running || this.#session !== session) return;

    switch (outcome.kind) {
      case 'answered':
        this.#record('answered', outcome.note === null ? 'the question was answered' : `the question was answered: ${outcome.note}`);
        if (outcome.intent) {
          // The model redirected the loop: that is progress, whatever the screen does next.
          this.#lastProgressAtMs = this.#now();
          this.#failed.clear();
          await this.#execute(outcome.intent, this.#lastObservation?.screen ?? null, {
            session,
            frame,
            observation,
            now,
          });
        }
        // No intent is a diagnosis only: the loop re-reads the screen, as promised by the receipt.
        return;
      case 'timeout':
      case 'undelivered':
        this.#record(
          outcome.kind === 'timeout' ? 'timed-out' : 'undelivered',
          outcome.kind === 'timeout'
            ? `the question timed out after ${Math.max(1, Math.round(outcome.waitedMs / 1000))} s`
            : `the question never reached the session (${outcome.why})`,
        );
        // One wait's worth of cooldown: a screen that stays unknown must not spend the hour in a
        // minute (research §5.2).
        this.#escalationCooldownUntilMs = this.#now() + Math.max(1, timeoutMs);
        await this.#execute(fallback, observation.screen, { session, frame, observation, now });
        return;
      case 'cancelled':
        // The operator closed the question from the console: the loop resumes on the same tick with
        // its own recovery, exactly as if the wait had run out (design §4).
        this.#record('cancelled', 'the question was cancelled from the console');
        await this.#execute(fallback, observation.screen, { session, frame, observation, now });
        return;
    }
  }

  /** The question the model is asked. One line, about the screen the loop actually refused. */
  #question(observation: Observation): string {
    switch (observation.screen) {
      case 'unknown':
        return 'The screen is not one this World can name. What is it showing, and what should the loop do next?';
      case 'dungeonmap':
        return 'The map is open but the route cannot act on what it reads. Which chest should the loop take, or should it leave?';
      case 'chest-qte':
        return 'The chest QTE is on screen and this World will not gamble a tap. Where is the safe window?';
      case 'chest-open':
        // A parsed panel that chose nobody carries its reason; a panel nobody parsed keeps the old line.
        return this.#openerRefusal === null
          ? 'The opener panel is up and the route will not choose blindly. Who should open this chest?'
          : `The opener panel is up, but ${this.#openerRefusal}. Who should open this chest, or should the loop leave it?`;
      default:
        return `The screen has been ${observation.screen} longer than the loop expects. Is it seeing the right thing, and what should it do?`;
    }
  }

  /** Why a `stop` verdict ended the session, in the words the operator and Coo read. */
  #stopReason(observation: Observation, spent: number): string {
    if (spent >= this.#cfg.escalateMaxPerHour) {
      return `the escalation budget for this hour is spent (${spent}/${this.#cfg.escalateMaxPerHour})`;
    }
    if (observation.screen === 'unknown' && observation.confidence <= 0) {
      return 'nothing on the screen could be perceived';
    }
    return `the session classifier stopped on a ${observation.screen} screen`;
  }

  /** The escalation width, floored so a mid-stall question is not asked about an unreadable screen. */
  #stallEscalateMs(): number {
    return Math.max(MIN_STALL_ESCALATE_MS, (this.#cfg.stallStopSeconds * 1000) / STALL_ESCALATE_DIVISOR);
  }

  /**
   * `escalateMaxPerHour`'s window, a rolling hour: the count is a query over the push timestamps, so
   * reading it cannot move the window (and `wvd_status` cannot spend the budget by being asked).
   */
  #spentThisHour(now: number): number {
    let spent = 0;
    for (const pushedAt of this.#escalationPushes) {
      if (pushedAt <= now && now - pushedAt < HOUR_MS) spent += 1;
    }
    return spent;
  }

  #recordEscalation(now: number): void {
    this.#escalationPushes = this.#escalationPushes.filter((pushedAt) => now - pushedAt < HOUR_MS);
    this.#escalationPushes.push(now);
  }

  // --- acting --------------------------------------------------------------------------------

  /**
   * The one path from an `Intent` to an `Actuator` call: the escalation must not grow a second.
   *
   * **Every key is gated on the screen it is that command on** (navigation §3d). The map's legend is
   * a set of commands — `L` 移動至宝箱, `F` 移動至出口 — and the same keys mean something else
   * elsewhere: `F` in the 3D view is 調査, and `G` **on the map** is 移動至目的地, an unintended
   * automove. So:
   *
   * - `move` is pressed on the map and nowhere else; off the map there is no chest command to press.
   * - `exit` is pressed on the map. Off the map the loop opens the map first and lets the next tick
   *   take the exit from it — the route returns `exit` for the 3D view once the chest budget is
   *   spent (`route.ts`), so translating it here is what keeps that state reachable.
   * - `open-map` is pressed anywhere **but** the map: G is the menu-then-map key in the 3D view, and
   *   on the map it is 移動至目的地.
   * - `open-chest` clicks a **card of the opener panel**, and only while the panel is the screen: the
   *   choice comes from `chooseOpener` over the parsed panel, and a panel with no qualifying member
   *   is escalated instead — the loop never clicks a card it did not choose (chest §5).
   */
  /**
   * Between cycles the farm restarts from the same floor: the counters that describe "how far this
   * cycle has got" reset, and nothing that describes the session does.
   */
  #resetCycle(): void {
    this.#chestsRemaining = INITIAL_CHEST_BUDGET;
    this.#unreachable = [];
    this.#walkFailures = new Map();
    this.#lastMapRead = null;
    this.#lastScreen = null;
    this.#inFlight = null;
    this.#failed = new Set();
    this.#willpower = [];
    this.#openerRefusal = null;
    this.#escalationCooldownUntilMs = 0;
    // Per-cycle QTE/battle state: a give-up or a partly spent reroll budget in one cycle must not
    // silence the next cycle's bar.
    this.#qteGivenUp = false;
    this.#qteRerolls = 0;
    this.#lastQtePass = null;
    this.#rearmBattle();
    this.#askedForMap = false;
    this.#pacer.reset();
    this.#lootTapAtMs = null;
    this.#lootTaps = 0;
    // A new cycle orients afresh: the climb budget is per cycle, and the next cycle may leave the
    // dungeon by the same measured stair the last one came up.
    this.#orienting = false;
    this.#orientTravelFailures = 0;
    this.#orientClimbs = 0;
    this.#settleUntilMs = 0;
  }

  /**
   * Hand the tick to the QTE timing sub-loop (`actions/qte.ts`, contracts §7). The World owns what
   * the sub-loop must not: the client-size invariant, the press's session, and the session that may
   * end during the wait.
   *
   * - **A dry run records and sends nothing**, exactly as `#press` does for every other command;
   *   it reports the intent whatever the window size, because it sends nothing either way.
   * - **The size gate is `qteWindow`'s precondition.** The crop is asked for in the reference frame's
   *   coordinates whatever the client area is, so another size would read the wrong pixels with full
   *   confidence. `actions/qte.ts` names this as the composition root's promise; this is where the
   *   promise becomes code (contracts §0.5).
   * - **The routine refusals are `info`, not `warn`**: a dimmed 解除 — what our own successful press
   *   produces for the bar's remaining ~3 s — and a bar that left are how a pass ends normally.
   * - **A throw from `press` or `now` is a skipped press, not a dead session.** `timeQte` returns a
   *   value for every sampler refusal, but those two closures are the World's; without this catch a
   *   throw would reach the tick's catch and end the session as "a module failed".
   * - **A stop during the wait sends nothing**: `press` re-checks the session, and an outcome that
   *   arrives after the session ended is dropped rather than logged as this session's.
   *
   * The success line is the fit input for `qteDecelPxPerS2` (chest spec §3, task #18): the recorded
   * speed, the planned delay (`delayMs` — never `atMs`, which everywhere else is a clock stamp,
   * contracts §0.4), the zone centre, where the marker was, where it parked and whether that read
   * settled. An unsettled `restX` is a moving marker, not a rest, and the fit must be able to tell.
   */
  async #timeQte(session: WvdSession, frame: Frame): Promise<void> {
    // The reroll budget is spent and nothing beat the baseline: the bar is pressed as the last
    // attempt instead of being left on screen (the p2 card's option b). A miss costs an attempt and
    // the trap still grants the loot, so the chest resolves and the loop moves on.
    // The dry run reports the intent whatever the window size: it sends nothing either way, and an
    // operator reading it must see what the live loop would do, not a live-sounding refusal.
    if (this.#cfg.dryRun) {
      this.#host?.log.info('wvd: dry run, would time the chest QTE and press the disarm key');
      return;
    }
    if (frame.width !== REFERENCE_FRAME.width || frame.height !== REFERENCE_FRAME.height) {
      this.#host?.log.warn(
        `wvd: not timing the chest QTE: the game window is ${frame.width}x${frame.height}, not `
          + `${REFERENCE_FRAME.width}x${REFERENCE_FRAME.height}`,
      );
      return;
    }
    const cfg = this.#cfg;
    let outcome: QteOutcome;
    try {
      outcome = await this.#timing({
        sampler: bandSampler(session.source),
        // The disarm is Space, held for the configured duration — a key, not the 解除 click (§3b).
        press: async () => {
          if (!this.#running || this.#session !== session) {
            return { ok: false, reason: 'unavailable', detail: 'the session ended during the wait' };
          }
          return session.actuator.holdKey(DISARM_SCAN, cfg.pressHoldMs);
        },
        now: () => this.#now(),
        // The wait must not hold the process open: `stop()` clears the scheduler's timer, but a
        // sleep already in flight cannot be settled without new state for one waiter, so the handle
        // is `unref`'d exactly as `#schedule`'s is. The session re-check after the await is what
        // keeps a stop that lands during the wait from pressing — liveness and safety, separately.
        wait: (ms) => new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }),
        latencyMs: cfg.qteLatencyMs,
        brakeEnabled: cfg.qteBrakeEnabled,
        decelPxPerS2: cfg.qteDecelPxPerS2,
        budgetMs: cfg.qteSubLoopMs,
        // The attempt-vs-reroll rule (operator, 2026-10-31): five rerolls per chest, the first two
        // rerolled passes recorded as the baseline, and only a later pass that beats both baselines
        // is taken. The callback also stashes the pass for the recording below; the policy is pure.
        choosePass: (pass) => {
          this.#lastQtePass = pass;
          if (this.#qteGivenUp) return 'press';
          return chooseQtePass(pass, {
            rerolls: this.#qteRerolls,
            budget: Math.max(0, cfg.maxRerolls),
          }, cfg.qteMinWindowMs);
        },
      });
    } catch (error) {
      this.#host?.log.warn(`wvd: the chest QTE could not be timed: ${message(error)}`);
      return;
    }
    // A stop can land inside the sub-loop. Nothing is acted on — or reported as this session's —
    // after it, exactly as the tick itself re-checks after every await.
    if (!this.#running || this.#session !== session) return;
    if (!outcome.ok && outcome.reason === 'reroll') {
      // Record the pass while the baseline is filling (the first two *rerolls*), then cancel the QTE:
      // a cancellation costs no attempt (chest §4), and the panel returns for the next card click.
      const pass = this.#lastQtePass;
      const cancelled = await this.#commands.cancelQte();
      if (cancelled.ok) {
        this.#qteRerolls += 1;
        // The cancel is a command whose answer is the 打开 prompt coming back — not the next frame.
        // The party stands on the chest's tile then, so the prompt needs one step off it first; the
        // in-flight record supplies both facts and the loop keeps its hands off the route policy
        // until the prompt answers (operator, 2026-10-31).
        const now = this.#now();
        this.#inFlight = {
          kind: 'open-chest',
          fromScreen: 'chest-qte',
          sinceMs: now,
          evidenceAtMs: now,
          signature: null,
          walking: false,
          readAtPress: null,
          target: null,
          answers: ['chest-prompt'],
          whileWaiting: {
            when: ['dungeon', 'unknown'],
            send: () => this.#commands.reenterChest(),
            sent: false,
          },
        };
      }
      this.#host?.log.info(
        `wvd: chest QTE reroll ${this.#qteRerolls}/${cfg.maxRerolls}: `
          + (cancelled.ok ? 'the bar was left' : `the bar could not be left (${cancelled.reason})`)
          + `, window ${Math.round(pass?.windowMs ?? 0)} ms`,
      );
      return;
    }
    if (!outcome.ok && outcome.reason === 'no-better-pass') {
      // The budget is gone and no reroll beat the first two: the operator accepted the failure.
      this.#qteGivenUp = true;
      this.#host?.log.warn(
        `wvd: chest QTE given up after ${this.#qteRerolls} rerolls: no pass cleared `
          + `the ${this.#cfg.qteMinWindowMs} ms floor`,
      );
      return;
    }
    if (!outcome.ok) {
      // The normal end of a pass is not a failure: a dimmed 解除 (including right after our own
      // press) or a bar that left is `info`; the rest are states where the loop wanted to act.
      const line = `wvd: the chest QTE was not pressed: ${outcome.reason}`;
      if (routineQteRefusal(outcome.reason)) this.#host?.log.info(line);
      else this.#host?.log.warn(line);
      return;
    }
    this.#host?.log.info(
      `wvd: chest QTE pressed: v=${outcome.v} delayMs=${outcome.atMs} target=${outcome.target} `
        + `tapX=${outcome.tapX} restX=${outcome.restX === null ? 'unread' : outcome.restX} `
        + `settled=${outcome.restSettled}`,
    );
  }

  async #execute(intent: Intent, fromScreen: ScreenId | null, context?: TickContext): Promise<void> {
    this.#lastIntent = { intent, atMs: this.#now() };
    switch (intent.kind) {
      case 'open-map':
        // Never blind-retry this one: if the second G failed, the menu is already open and a retry
        // presses G on the map, which is 移動至目的地 — an unintended automove. Re-perceive instead.
        if (fromScreen === 'dungeonmap') {
          this.#host?.log.warn('wvd: not opening the map from the map: G there is 移動至目的地');
          return;
        }
        await this.#press('open-map', fromScreen, () => this.#commands.openMap());
        return;
      case 'move': {
        if (fromScreen !== 'dungeonmap') {
          // The tile walk is the map's own gesture: pointer mode and a cell mean nothing anywhere
          // else, and the map has to be open before the game has a cell to walk to.
          this.#host?.log.warn(
            `wvd: not walking to a tile from ${fromScreen ?? 'an unknown screen'}: the map is the surface`,
          );
          return;
        }
        // The route names a grid cell; the chevron is the map's only absolute screen point, so the
        // conversion happens once, here, from the map this tick read (contracts §3 `origin`).
        const read = context?.observation ?? this.#lastObservation;
        const map = read?.screen === 'dungeonmap' ? read.map : null;
        if (map === null) {
          this.#host?.log.warn('wvd: not walking to a tile: no map read to aim it from');
          return;
        }
        const at = tileOnScreen(map, intent.target);
        await this.#press('move', fromScreen, () => this.#commands.automoveToTile(at), intent.target);
        return;
      }
      case 'exit':
        if (fromScreen !== 'dungeonmap') {
          // F on the 3D view is 調査: walking to the exit needs the map, so the recovery is to open
          // it and let the next tick press F from the only screen where it is 移動至出口.
          this.#host?.log.info(`wvd: exit needs the map (screen is ${fromScreen ?? 'unknown'}); opening it first`);
          await this.#press('open-map', fromScreen, () => this.#commands.openMap());
          return;
        }
        await this.#press('exit', fromScreen, () => this.#commands.automoveToExit());
        return;
      case 'open-chest': {
        // The chest is two screens: the 打开 prompt, then the 由谁打开? panel. The prompt is a single
        // tap at a fixed point; the panel is a choice among cards.
        if (fromScreen === 'chest-prompt') {
          await this.#press('open-chest', fromScreen, () => this.#commands.acceptChestPrompt());
          return;
        }
        const panel = this.#lastObservation?.screen === 'chest-open' ? this.#lastObservation.opener : null;
        if (panel === null || fromScreen !== 'chest-open') {
          this.#host?.log.warn(
            `wvd: not choosing an opener from ${fromScreen ?? 'an unknown screen'}: the panel is not up`,
          );
          return;
        }
        const session = this.#session;
        const choice = chooseOpener(panel, this.#cfg.willpowerFloor);
        if (choice === null) {
          // Nobody may open it: do not click. Say why, and ask — the next card choice is the model's
          // or the operator's, not a guess here.
          const unread = panel.members.filter((member) => member.willpower === null || !Number.isFinite(member.willpower)).length;
          this.#openerRefusal = unread > 0
            ? `${unread} of ${panel.members.length} cards show no willpower, and no member with a readable `
              + `willpower is at or above the ${this.#cfg.willpowerFloor} willpower floor`
            : `no member is at or above the ${this.#cfg.willpowerFloor} willpower floor`;
          this.#failed.add('open-chest');
          this.#host?.log.warn(`wvd: not opening the chest: ${this.#openerRefusal}`, {
            members: panel.members.map((member) => ({
              detect: member.detect,
              disarm: member.disarm,
              willpower: member.willpower,
              feared: member.feared,
            })),
          });
          if (context) await this.#escalate(context.session, context.frame, context.observation, context.now);
          return;
        }
        const slot = openerSlot(choice.index);
        const centre = openerCardCentre(choice.index);
        if (slot === null || centre === null || session === null) {
          this.#host?.log.warn(`wvd: the chosen opener ${choice.member.name} has no card to click`);
          return;
        }
        this.#openerRefusal = null;
        // The character selection is one direct operation (operator rule 2026-11-03): the panel's
        // first frame is a transition, and a click sent before the screen has held is the failure the
        // character page's close had. The pacer wants two frames of the panel and one operation per
        // pace; the click waits for both.
        const pressedAt = this.#now();
        if (!this.#pacer.ready(pressedAt)) return;
        this.#pacer.act(pressedAt);
        this.#host?.log.info(
          `wvd: opening the chest with ${choice.member.name} (陷阱解除 ${choice.member.disarm}, `
            + `陷阱发现 ${choice.member.detect}) at the ${slot.id} card, ${centre.x},${centre.y}`,
        );
        await this.#press('open-chest', fromScreen, () => tapOpenerCard(session.actuator, choice.index));
        return;
      }
      case 'loot': {
        // The loot card is a modal: one tap at the measured card centre collects it. The claim is a
        // direct operation like any other and the pacer owns the moment (operator rule 2026-11-03):
        // the card tap and the banner's continue arrow wait for a frame that has stopped moving and
        // for the pace. `lootTapIntervalMs` then sets the retry cadence above that floor — the
        // effective interval is max(the pacer's 700 ms, the configured value). After `lootTapMax`
        // taps the card is left to the stall clock and the escalation, rather than becoming a 10 Hz
        // tap loop.
        const tappedAt = this.#now();
        if (!this.#pacer.ready(tappedAt)) return;
        if (this.#lootTapAtMs !== null
          && tappedAt - this.#lootTapAtMs < Math.max(1, this.#cfg.lootTapIntervalMs)) return;
        if (this.#lootTaps >= Math.max(1, this.#cfg.lootTapMax)) {
          // The card is gone and the result banner is up: it has its own continue arrow, and the
          // card's centre does nothing on it (measured live 2026-11-01). One tap, once per screen.
          if (this.#lootDismissed) {
            this.#host?.log.warn('wvd: the loot screen did not leave after the configured taps');
            return;
          }
          this.#lootDismissed = true;
          this.#lootTapAtMs = tappedAt;
          this.#pacer.act(tappedAt);
          const dismissed = await this.#commands.dismissLoot();
          if (!dismissed.ok) this.#host?.log.warn(`wvd: could not dismiss the loot banner (${dismissed.reason})`);
          else this.#host?.log.info('wvd: dismissed the loot result banner');
          return;
        }
        this.#lootTapAtMs = tappedAt;
        this.#lootTaps += 1;
        this.#pacer.act(tappedAt);
        const tapped = await this.#commands.tapLoot();
        if (!tapped.ok) this.#host?.log.warn(`wvd: could not collect the loot (${tapped.reason})`);
        else this.#host?.log.info('wvd: collected the loot card');
        return;
      }
      case 'fight': {
        // Operator rule 2026-11-04: a battle is turn-based, so the loop's operations are a **sequence**
        // (policy/battle-sequence.ts) — one tap per tick, in order, on a settled frame, paced from the
        // previous tap's return. The battle's order is speed → opener slot → opener confirm → auto.
        const sequence = this.#battleSequence;
        const seen = context?.observation;
        if (sequence === null || seen === undefined || seen.screen !== 'combat') return;
        const now = context?.now ?? this.#now();
        // The turn card is read only while the opener is undecided: it says whether there is a cast at
        // all, and the skill panel dims it, so the read belongs to the command phase.
        const phase = { speedOn: seen.speedOn ?? null, autoOn: seen.autoOn ?? null, activeMember: null as string | null };
        // "Until we get a stable frame, then confirm the current state" (operator rule 2026-11-04): the
        // panel redraws as the battle opens, so one readable frame is not a decision. The read runs
        // every frame while the cast is owed, and only the same answer on `BATTLE_STABLE_READS`
        // consecutive frames is handed to the sequence — which bounds the whole wait by
        // `battleOpenerTimeoutMs`.
        let reading: string | null = null;
        if (sequence.needsMemberRead(phase, now) && this.#battle !== undefined && context !== undefined) {
          let read: string | null = null;
          try {
            read = await this.#battle.reader.readActiveMember(context.frame);
          } catch (error) {
            // A reader that throws across its boundary is the loop's to absorb: a battle with an
            // unreadable panel is a miss, never a failed session.
            this.#host?.log.warn(`wvd: the active member could not be read (${message(error)})`);
          }
          const frames = this.#battleRead !== null && this.#battleRead.value === read ? this.#battleRead.frames + 1 : 1;
          this.#battleRead = { value: read, frames };
          if (read !== null && frames >= BATTLE_STABLE_READS) reading = read;
        }
        if (reading !== null && !this.#battleNotListedWarned
          && this.#battle !== undefined && openerFor(reading, this.#battle.openers) === null) {
          this.#battleNotListedWarned = true;
          this.#host?.log.info(
            `wvd: the active member is ${reading}; it is not on the opener list, so the default action runs`,
          );
        }
        const step = sequence.next({ ...phase, activeMember: reading }, now);
        // The cast was owed, the turn card was attempted, and now the battle is past it without a
        // cast: the opener is given up. One line, because a test run watches for it (2026-11-05).
        if ((step.kind === 'auto' || step.kind === 'done') && this.#battleReadWarned
          && !this.#battleNotListedWarned && !this.#battleCastSent && !this.#battleOpenerGaveUp) {
          this.#battleOpenerGaveUp = true;
          this.#host?.log.warn('wvd: the opener was given up: the ACTIVE card was never confirmed');
        }
        // One operation, and its return is the pace's zero: the next one waits `battleStepMs` from here,
        // never from the frame this one started on.
        const send = async (label: string, pressed: Promise<ActionResult>): Promise<ActionResult> => {
          const result = await pressed;
          if (result.ok) sequence.completed(this.#now());
          else {
            sequence.refused(this.#now());
            this.#host?.log.warn(`wvd: the ${label} press was refused (${result.reason})`);
          }
          return result;
        };
        switch (step.kind) {
          case 'wait': {
            if (step.why === 'unreadable' && !this.#battleReadWarned) {
              this.#battleReadWarned = true;
              this.#host?.log.info('wvd: the active member is not readable yet; waiting for the panel before auto');
            }
            if (step.why === 'speed-capped' && !this.#battleSpeedWarned) {
              this.#battleSpeedWarned = true;
              this.#host?.log.warn(
                `wvd: 倍速 was pressed ${Math.max(1, this.#cfg.autoBattleEnableAttempts)} times and the battle does not show it on; leaving it to the stall clock`,
              );
            }
            if (step.why === 'auto-capped' && !this.#battleAutoWarned) {
              this.#battleAutoWarned = true;
              this.#host?.log.warn(
                `wvd: 自動 was pressed ${Math.max(1, this.#cfg.autoBattleEnableAttempts)} times and the battle does not show it on; leaving it to the stall clock`,
              );
            }
            if (step.why === 'auto-stuck' && !this.#battleAutoStuckWarned) {
              this.#battleAutoStuckWarned = true;
              this.#host?.log.warn('wvd: 自動 would not turn off, so the opener is given up and the battle plays itself');
            }
            return;
          }
          case 'auto-off': {
            // The battle was playing itself: 自動 off first, so the command phase (and the cast) is the
            // loop's, then the last step turns it back on (operator rule 2026-11-04).
            const pressed = await send('自動', this.#commands.battleAuto());
            if (pressed.ok) this.#host?.log.info('wvd: turned 自動 off to cast the opener');
            return;
          }
          case 'speed': {
            const pressed = await send('倍速', this.#commands.battleSpeed());
            if (pressed.ok) this.#host?.log.info('wvd: pressed 倍速 for the battle');
            return;
          }
          case 'slot': {
            const cast = await send(`${step.opener.name}'s opener slot`, this.#commands.battleSlot(step.opener));
            if (cast.ok) this.#battleCastSent = true;
            if (cast.ok) {
              this.#host?.log.info(
                `wvd: cast ${step.opener.name}'s ${step.opener.slot} opener at ${step.opener.target}`,
              );
            }
            return;
          }
          case 'confirm': {
            await send(`${step.opener.name}'s opener confirm`, this.#commands.battleConfirm(step.opener));
            return;
          }
          case 'auto': {
            const pressed = await send('自動', this.#commands.battleAuto());
            if (pressed.ok) this.#host?.log.info('wvd: pressed 自動 for the battle');
            return;
          }
          default:
            // Both toggles on and the opener decided: nothing to press; the mode holds until it ends.
            return;
        }
      }
      case 'wait':
        // The tick cadence is the wait; the next tick re-perceives.
        return;
      case 'run-script': {
        const task = this.#task;
        if (task === null) {
          this.#host?.log.warn(`wvd: no task is running; the ${intent.name} script has nothing to do`);
          return;
        }
        // A stage is one step per tick (operator rule 2026-11-05): the loop hands it the frame it just
        // observed and keeps its own tick, so a battle, the chest after it, or the death scene is
        // dispatched by the loop and the stage resumes from its cursor.
        const result = context === undefined
          ? await task.runScript(intent.name)                 // no frame: the script runs blocking
          : await task.runScript(intent.name, context.observation);
        if (!this.#running) return;
        if (!result.ok && result.reason === 'interrupted') {
          // A screen the loop owns appeared mid-stage. The cursor is kept; the next tick dispatches
          // by screen, and the stage resumes once the screen is the stage's again.
          return;
        }
        if (!result.ok) {
          await this.#endSession(
            result.reason === 'cancelled'
              ? 'the session was stopped while the task exit ran'
              : `the task ${intent.name} stopped at step ${result.step}: ${result.reason}`,
            { report: true, failed: result.reason !== 'cancelled' },
          );
          return;
        }
        if (result.complete === false) return;      // partial progress: the stage has more steps
        // The stage's own screens and presses are progress the loop could not see while it ran.
        this.#lastProgressAtMs = this.#now();
        if (intent.name !== 'exit') return;
        this.#cyclesDone += 1;
        if (this.#cyclesDone < Math.max(1, this.#cfg.cycles) && this.#task !== null) {
          this.#resetCycle();
          if (this.#task.orient !== undefined) {
            // A goal task orients back in; there is no entry script to run.
            this.#orienting = true;
            this.#host?.log.info(`wvd: cycle ${this.#cyclesDone} done; orienting back to the farm`);
            return;
          }
          const entered = await this.#task.runScript('enter');
          if (!this.#running) return;
          if (!entered.ok) {
            await this.#endSession(
              entered.reason === 'cancelled'
                ? 'the session was stopped during the task entry'
                : `the task entry stopped at step ${entered.step}: ${entered.reason}`,
              { report: true, failed: entered.reason !== 'cancelled' },
            );
            return;
          }
          this.#handOffEntry(this.#now());
          this.#host?.log.info(`wvd: cycle ${this.#cyclesDone} done; re-entered for cycle ${this.#cyclesDone + 1}`);
          return;
        }
        await this.#endSession(`task-complete: ${this.#cyclesDone} of ${Math.max(1, this.#cfg.cycles)} cycles`, { report: true });
        return;
      }
      case 'stop':
        await this.#endSession(intent.reason, { report: true });
        return;
      default:
        return assertNever(intent);
    }
  }

  /**
   * One command of the orientation (contracts §10, the goal form). It sends exactly one thing and
   * lets the next tick's frame answer it, except the two long jobs — the world-map travel and the
   * climb script — which are whole procedures with their own settle and their own retry budget.
   *
   * The two presses go through `#press` so they share the loop's in-flight rules: a map that never
   * opens is not pressed twice, and a walk is waited out by arrival like any other.
   */
  async #orientTo(command: OrientCommand, fromScreen: ScreenId): Promise<void> {
    // The orientation's commands are primitives like every other tap (operator rule 2026-11-03): one per
    // pace, on a frame that has stopped moving. Without this the loop pressed G twice a tick while the
    // map's own open was still animating (live 2026-11-03 21:49: thirty "changed nothing" warnings and
    // an escalation) — and a party heal is cancelled by the trip: the operator's rule is to heal after a
    // battle or a chest, never on the way through the dungeon.
    if (!this.#pacer.ready(this.#now())) return;
    this.#pacer.act(this.#now());
    this.#healDue = false;
    switch (command.kind) {
      case 'open-map':
      case 'exit': {
        // A command that already changed nothing on this screen is not sent again: the stall clock
        // is what escalates it, exactly as on the farm path.
        if (this.#failed.has(command.kind)) {
          this.#host?.log.warn(`wvd: orienting: ${command.kind} already changed nothing here; not sending it again`);
          return;
        }
        const send = command.kind === 'open-map'
          ? () => this.#commands.openMap()
          : () => this.#commands.automoveToExit();
        await this.#press(command.kind, fromScreen, send);
        return;
      }
      case 'stairs': {
        // The 楼梯-门 icon the map reader named. It is **the same interaction as a chest walk**: the tap
        // on the cell raises the 自動移動 prompt and tapping the prompt starts the walk (live 2026-11-03
        // 21:45: a bare tap raised the prompt and the screen never changed, so the press looked ignored).
        // The climb therefore goes through the farm's own automove, which finds and taps that prompt.
        await this.#press('move', fromScreen, () => this.#commands.automoveToTile(command.at));
        return;
      }
      case 'climb': {
        const task = this.#task;
        if (task === null) return;
        if (this.#cfg.dryRun) {
          this.#host?.log.info('wvd: dry run, would climb to the farm floor');
          return;
        }
        this.#orientClimbs += 1;
        if (this.#orientClimbs > ORIENT_CLIMB_TRIES) {
          await this.#endSession(
            `the climb was tried ${ORIENT_CLIMB_TRIES} times and the party is still not on the farm floor`,
            { report: true, failed: true },
          );
          return;
        }
        this.#host?.log.info(`wvd: climbing to the farm floor (attempt ${this.#orientClimbs})`);
        const result = await task.runScript('climb');
        if (!this.#running) return;
        if (!result.ok) {
          const detail = result.detail === undefined ? '' : ` (${result.detail})`;
          await this.#endSession(
            `the climb script stopped at step ${result.step}: ${result.reason}${detail}`,
            { report: true, failed: result.reason !== 'cancelled' },
          );
          return;
        }
        // The climb's last press starts a game-driven walk: the loop may not command a walking party,
        // so the hand-off starts the same arrival book-keeping the entry's walk uses. The load that
        // follows the walk gets the same settle a travel does.
        this.#settleUntilMs = this.#now() + ORIENT_SETTLE_MS;
        this.#settleFrom = this.#lastScreen;
        this.#handOffEntry(this.#now());
        return;
      }
      case 'travel': {
        if (this.#cfg.dryRun) {
          this.#host?.log.info(`wvd: dry run, would travel to ${command.to}`);
          return;
        }
        this.#orientAbort ??= new AbortController();
        this.#host?.log.info(`wvd: orienting: travelling to ${command.to}`);
        const result = await this.#commands.travel(command.to, this.#orientAbort.signal);
        if (!this.#running) return;
        if (result.ok) {
          this.#orientTravelFailures = 0;
          this.#lastProgressAtMs = this.#now();
          this.#settleUntilMs = this.#now() + ORIENT_SETTLE_MS;
          this.#settleFrom = this.#lastScreen;
          return;
        }
        this.#orientTravelFailures += 1;
        const detail = result.detail === undefined ? '' : ` (${result.detail})`;
        if (this.#orientTravelFailures >= ORIENT_TRAVEL_TRIES) {
          await this.#endSession(
            `the world-map travel to ${command.to} failed ${this.#orientTravelFailures} times: ${result.reason}${detail}`,
            { report: true, failed: true },
          );
          return;
        }
        this.#host?.log.warn(`wvd: the world-map travel to ${command.to} failed (${result.reason}${detail}); trying once more`);
        return;
      }
      default:
        return assertNever(command);
    }
  }

  /**
   * Send one command — a key press, or the opener card's tap — and record that it is now in flight. A
   * refused or failed one is recorded failed immediately (nothing was sent, so nothing will arrive)
   * and never retried here.
   */
  async #press(
    kind: 'open-map' | 'move' | 'exit' | 'open-chest' | 'fight',
    fromScreen: ScreenId | null,
    command: () => Promise<ActionResult>,
    target: Point | null = null,
  ): Promise<void> {
    if (this.#cfg.dryRun) {
      this.#host?.log.info(`wvd: dry run, would ${kind}`);
      return;
    }
    const result = await command();
    if (!result.ok) {
      // A walk the game refuses is a cell it has no path to — no 自動移動 element was raised
      // (measured 2026-11-02). Skip it and aim elsewhere; do not mark `move` failed, which is what
      // used to wedge the farm until the next advancement.
      if (kind === 'move' && target !== null) {
        const why = result.detail ?? result.reason;
        this.#skip(target, why);
        return;
      }
      this.#failed.add(kind);
      this.#host?.log.warn(`wvd: could not ${kind}`, { reason: result.reason, detail: result.detail ?? null });
      return;
    }
    if (fromScreen === null) return;
    const now = this.#now();
    this.#inFlight = {
      kind,
      fromScreen,
      sinceMs: now,
      // Stillness is measured from the first frame the command saw; the signature starts empty.
      evidenceAtMs: now,
      signature: null,
      walking: false,
      // A walk pressed on the map may keep the map open (navigation §3d), so the readout it started
      // from is the second way to see the party move.
      readAtPress: kind === 'open-map' ? null : this.#lastMapRead,
      target,
    };
  }

  // --- stopping ------------------------------------------------------------------------------

  /** The child's unsolicited messages. A dead safety net is a stop; a slow path is a note. */
  async onEngineEvent(event: EngineEvent): Promise<void> {
    if (!this.#running) {
      // The child can report before a session starts or after one ends: record it, stop nothing.
      if (event.kind === 'engineProblem') this.#engineProblem = event.detail;
      return;
    }
    if (event.kind === 'stopHotkey') {
      await this.#endSession('the stop hotkey was pressed', { report: true });
      return;
    }
    this.#engineProblem = event.detail;
    this.#host?.log.warn(`wvd: the engine reported a problem: ${event.detail}`);
    if (event.detail === 'stop-hotkey-unregistered') {
      // A session must not run believing the stop key works (contracts §5).
      await this.#endSession('the stop hotkey is not registered', { report: true, failed: true });
    }
  }

  /** `onEventsSettled`: the only report that the question reached — or was cleared from — a session. */
  onEventsSettled(events: readonly EventEnvelope[], settlement: 'delivered' | 'discarded'): void {
    this.#supervisor.onSettled(events, settlement);
  }

  /** A turn can end for reasons that have nothing to do with our question: observe only (§5.4). */
  onTurnEnded(): void {
    if (this.#supervisor.isOpen()) {
      this.#host?.log.warn('wvd: the model turn ended with the question unanswered; still waiting');
    }
  }

  /**
   * A stop that leaves its evidence: the frame is pushed with the reason as a note, so the reason has a
   * picture beside it instead of a description ("the map carries no 楼梯-门 icon") the operator has to
   * take on trust. The script that hosts the World writes the image (scripts/world-run.ts saves any
   * image blob as `.tmp/note-*.jpeg`); a note that cannot be pushed never blocks the stop.
   */
  async #stopWithEvidence(session: WvdSession, frame: Frame, reason: string): Promise<void> {
    try {
      const snapshot = await takeSnapshot(session.snapshot, this.#cfg.escalationImageWidth);
      const note: WvdEvent = {
        type: 'wvd.note',
        source: 'wvd',
        senderKey: 'wvd.note',
        ts: nowIso(this.#timezone, new Date()),
        tags: snapshot === null ? [] : ['snapshot'],
        text: `[wvd.note] The session stops: ${reason}`,
        meta: { reason, screen: this.#lastObservation?.screen ?? 'unknown' },
        ...(snapshot === null ? {} : { blobs: [snapshotBlob(snapshot)] }),
      };
      await this.#host?.pushEvent(note, { trigger: 'flush' });
    } catch {
      // Evidence is a courtesy; the stop is the contract.
    }
    await this.#endSession(reason, { report: true });
  }

  /** Close the session exactly once: settle the paused tick first, then release the engine. */
  async #endSession(reason: string, options: { report?: boolean; failed?: boolean } = {}): Promise<void> {
    const wasRunning = this.#running;
    // Stop a running script at its next step boundary before anything else is torn down: the task
    // must not keep pressing keys into a closed session.
    const task = this.#task;
    this.#task = null;
    task?.abort();
    // A stop that lands during the orientation's travel or climb must not keep pressing keys.
    this.#orientAbort?.abort();
    this.#orientAbort = null;
    this.#orienting = false;
    const hadQuestion = this.#supervisor.isOpen();
    this.#running = false;
    this.#lastStopReason = reason;
    this.#lastFailed = options.failed === true;
    // The session that owned the in-flight tick is gone; a later session's tick owns the flag now.
    this.#ticking = false;
    this.#tickId += 1;
    this.#inFlight = null;
    // A paused tick nobody settles holds the host's whole 20 s stop deadline (research §4.3).
    this.#supervisor.cancel();
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    try {
      unsubscribe?.();
    } catch (error) {
      this.#host?.log.warn('wvd: could not unsubscribe from the engine', message(error));
    }
    const session = this.#session;
    this.#session = null;
    try {
      session?.close?.();
    } catch (error) {
      this.#host?.log.warn('wvd: the engine did not close cleanly', message(error));
    }
    if (wasRunning) {
      // The question is closed before the session ends, and the log says so in that order.
      if (hadQuestion) this.#record('cancelled', 'the open question was cancelled with the session');
      this.#record(options.failed === true ? 'error' : 'stopped', reason);
    }
    if (wasRunning && options.report !== false) await this.#reportStopped(reason);
    this.#broadcast(this.#now(), true);
  }

  /** One event per stopped session, and a push that may not throw into the loop (research §5.3). */
  async #reportStopped(reason: string): Promise<void> {
    const host = this.#host;
    if (!host) return;
    const event: WvdEvent = stoppedEvent({
      timezone: this.#timezone,
      at: new Date(),
      atMs: this.#now(),
      reason,
      observation: this.#lastObservation,
      escalationsThisHour: this.#spentThisHour(this.#now()),
    });
    try {
      await host.pushEvent(event, { trigger: 'flush' });
    } catch (error) {
      host.log.warn('wvd: the stop report could not be pushed', { reason, error: message(error) });
    }
  }

  /** The loop's scheduler: one timer, one tick in flight, and a paused tick is simply no timer. */
  #schedule(): void {
    if (this.#timer !== null || !this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#running) return;
      void this.tick().finally(() => {
        if (this.#running) this.#schedule();
      });
    }, Math.max(1, this.#cfg.tickMs));
    this.#timer.unref?.();
  }

  // --- the tools -----------------------------------------------------------------------------

  #handlerFor(name: string): ToolDef['handler'] {
    switch (name) {
      case 'wvd_status':
        return async () => this.#statusText();
      case 'wvd_look':
        return async (_args, ctx) => this.#look(ctx);
      case 'wvd_act':
        return async (args, ctx) => this.#act(args, ctx);
      case 'wvd_resume':
        return async (args) => this.#resume(args);
      default:
        return async () => ({ text: `wvd: ${name} has no handler`, failed: true });
    }
  }

  /** Prose, not JSON: the model reads `text` either way and prose costs fewer tokens. */
  #statusText(): string {
    if (!this.#running || !this.#session) {
      return this.#lastStopReason === null
        ? 'no session running'
        : `no session running: the last one stopped because ${this.#lastStopReason}`;
    }
    const now = this.#now();
    const parts = [
      `session running for ${Math.max(0, Math.round((now - this.#sessionStartedAtMs) / 1000))} s `
        + `(${this.#ticks} ticks)`,
    ];
    if (this.#lastIntent) {
      const age = Math.max(0, Math.round((now - this.#lastIntent.atMs) / 1000));
      parts.push(`last intent ${this.#lastIntent.intent.kind} ${age} s ago`);
    }
    if (this.#inFlight) {
      parts.push(`waiting for ${this.#inFlight.kind} ${this.#inFlight.walking ? 'to arrive' : 'to take effect'}`);
    }
    parts.push(`mode ${this.#mode.mode}`);
    if (this.#lastObservation) parts.push(`last observation ${observationLine(this.#lastObservation)}`);
    const open = this.#supervisor.open;
    if (open) {
      const waited = Math.max(0, Math.round((now - open.atMs) / 1000));
      parts.push(`a question is waiting: asked ${waited} s ago, expires in ${Math.max(0, Math.round((open.atMs + open.timeoutMs - now) / 1000))} s`);
    }
    parts.push(`escalations this hour ${this.#spentThisHour(now)}/${this.#cfg.escalateMaxPerHour}`);
    if (this.#engineProblem !== null) parts.push(`engine problem: ${this.#engineProblem}`);
    return parts.join('; ');
  }

  /** Capture again, read it, and hand the model the same frame perception just saw. */
  async #look(ctx?: ToolCallContext): Promise<ToolOutcome> {
    const session = this.#session;
    if (!session) return { text: 'not captured: no session is running', failed: true };
    if (ctx?.signal?.aborted) return { text: 'not captured: the call was cancelled', failed: true };
    try {
      const frame = await session.source.capture();
      const observation = await session.perceiver.observe(frame);
      const snapshot = await takeSnapshot(session.snapshot, this.#cfg.escalationImageWidth);
      if (!snapshot) {
        return { text: `${observationLine(observation)}. No image: the frame could not be captured again.` };
      }
      // The model's next wvd_act reads pixels of this image, so the mapping follows the newest one.
      this.#supervisor.noteImage(frame.width, snapshot);
      return {
        text: `${observationLine(observation)}. Image ${snapshot.width}×${snapshot.height}.`,
        blobs: [snapshotBlob(snapshot)],
      };
    } catch (error) {
      return { text: `not captured: ${message(error)}`, failed: true };
    }
  }

  /** One input, only while a question is open: the loop's safety rule, not the model's manners. */
  async #act(args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolOutcome> {
    const open = this.#supervisor.open;
    if (!open) {
      return { text: 'not sent: no question is waiting; the loop is running on its own', failed: true };
    }
    if (this.#cfg.dryRun) {
      return { text: 'not sent: dry run is on; the game was not touched', failed: true };
    }
    if (ctx?.signal?.aborted) {
      return { text: 'not sent: the call was cancelled before any input', failed: true };
    }
    const session = this.#session;
    if (!session) return { text: 'not sent: no session is running', failed: true };

    switch (args.kind) {
      case 'tap':
      case 'doubleTap': {
        const point = this.#imagePixel(args, open);
        if (!point.ok) return { text: point.text, failed: true };
        const result = args.kind === 'tap'
          ? await session.actuator.tap(point.point)
          : await session.actuator.doubleTap(point.point);
        const what = `${args.kind === 'tap' ? 'tap' : 'double tap'} ${point.point.x}, ${point.point.y}`;
        return this.#actionReceipt(what, result);
      }
      case 'holdKey': {
        const key = typeof args.key === 'string' ? args.key.toLowerCase() : '';
        const scan = MOVEMENT_SCAN[key];
        if (scan === undefined) return { text: 'not sent: key must be one of w, a, s, d', failed: true };
        const requested = Number(args.holdMs ?? DEFAULT_ACT_HOLD_MS);
        // The ceiling is the contract's, not this tool's taste: see `MAX_PRESS_HOLD_MS`.
        const holdMs = Number.isFinite(requested)
          ? Math.min(MAX_PRESS_HOLD_MS, Math.max(MIN_ACT_HOLD_MS, Math.round(requested)))
          : Math.min(DEFAULT_ACT_HOLD_MS, MAX_PRESS_HOLD_MS);
        return this.#actionReceipt(`held ${key} ${holdMs} ms`, await session.actuator.holdKey(scan, holdMs));
      }
      default:
        return { text: 'not sent: kind must be tap, doubleTap or holdKey', failed: true };
    }
  }

  /**
   * The model answered in pixels of the image it saw; the window is device pixels. One scale
   * removes the error, and a coordinate outside the image is refused with its size, never clamped
   * (research §2.5).
   */
  #imagePixel(
    args: Record<string, unknown>,
    open: { readonly image: { width: number; height: number; frameWidth: number } | null },
  ): { ok: true; point: { x: number; y: number } } | { ok: false; text: string } {
    const image = open.image;
    if (!image) {
      return { ok: false, text: 'not sent: no image was sent with the question; call wvd_look first' };
    }
    const inside = `not sent: x and y must be integers inside ${image.width}×${image.height}`;
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, text: inside };
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return { ok: false, text: inside };
    const scale = image.frameWidth / image.width;
    return { ok: true, point: { x: Math.round(x * scale), y: Math.round(y * scale) } };
  }

  #actionReceipt(what: string, result: ActionResult): ToolOutcome {
    if (result.ok) {
      this.#supervisor.countAction();
      return { text: `sent: ${what}` };
    }
    const detail = result.detail === undefined ? '' : ` (${result.detail})`;
    return { text: `not sent: ${result.reason}${detail}`, failed: true };
  }

  /** `wvd_resume`: is anything waiting, then validate, then settle. The receipt is written last. */
  async #resume(args: Record<string, unknown>): Promise<ToolOutcome> {
    // The open check comes first: a late answer must hear "nothing is waiting", not a schema lesson.
    if (!this.#supervisor.isOpen()) {
      return { text: this.#supervisor.lateReceipt().text, failed: true };
    }
    const parsed = parseIntent(args.intent);
    if (!parsed.ok) return { text: `not resumed: ${parsed.detail}`, failed: true };
    const intent = parsed.intent === null || parsed.intent.kind !== 'move'
      ? parsed.intent
      // A model names the verb, not the cell: the target is the nearest chest the last map read
      // showed, which is the tile the pointer-mode walk is aimed at.
      : { kind: 'move' as const, target: this.#moveTarget() };
    const note = typeof args.note === 'string' ? args.note : null;
    const receipt = this.#supervisor.answer(intent, note);
    return receipt.ok ? { text: receipt.text } : { text: receipt.text, failed: true };
  }

  /** The nearest chest of the last map read, or the party's own tile: the cell a walk is aimed at. */
  #moveTarget(): Point {
    const read = this.#lastMapRead;
    if (read === null || read.chests.length === 0) return read?.player ?? { x: 0, y: 0 };
    const distance = (point: Point): number => Math.abs(point.x - read.player.x) + Math.abs(point.y - read.player.y);
    let best = read.chests[0]!;
    for (const chest of read.chests) {
      const toChest = distance(chest);
      const toBest = distance(best);
      if (toChest < toBest || (toChest === toBest && (chest.x < best.x || (chest.x === best.x && chest.y < best.y)))) {
        best = chest;
      }
    }
    return best;
  }
}

/** A new `Intent` member breaks the build here, in the same commit as the union grows. */
function assertNever(value: never): never {
  throw new Error(`unhandled intent: ${JSON.stringify(value)}`);
}
