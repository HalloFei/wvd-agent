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
  ScriptId,
  GameMode,
  ScriptResult,
  SessionTask,
  SessionVerdict,
  TravelOutcome,
  BattleMemberReader,
  BattleOpener,
  TaskLeaveRoute,
} from './contracts.ts';
import { WVD_CONFIG_GROUP, WVD_ID, type WvdConfigSection } from './config.ts';
import { DISARM_SCAN } from './actions/chest.ts';
import { advanceMode, INITIAL_MODE, type ModeMemory } from './policy/mode.ts';
import { nextPageCloseTries } from './policy/page-episode.ts';
import { createTrust } from './policy/trust.ts';
import { HealSession, type HealFacts } from './policy/heal-session.ts';
import { HealSchedule } from './policy/heal-schedule.ts';
import { CHEST_PROBE_MS, nextChestProbe } from './policy/chest-probe.ts';
import { isExpectedFloor } from './tasks/steps.ts';
import { OPERATION_PACE_MS, Pacer, STABLE_FRAMES } from './policy/pacing.ts';
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
import { judgeSnapshot, losslessBlob, snapshotBlob, takeSnapshot, takeSnapshotLossless, type SnapshotSource } from './escalation/image.ts';
import { Supervisor, type EscalationOutcome } from './escalation/supervisor.ts';
import { tapOpenerCard } from './actions/opener.ts';
import { bandSampler, REFERENCE_FRAME, type QteOutcome, type QteRefusal, type QteTimer } from './actions/qte.ts';
import { openerCardCentre, openerSlot } from './perception/opener.ts';
import { openerFor } from './actions/battle.ts';
import { chooseOpener } from './policy/chest.ts';
import { nextOrientStep, type OrientCommand } from './policy/orient.ts';
import { nextLeaveStep, type LeaveCommand } from './policy/leave.ts';
import { StageRegistry, type StageName } from './policy/stage-registry.ts';
import { recoverStep } from './policy/recover.ts';
import { chooseInnRest } from './policy/inn.ts';
import { restAtInn } from './actions/inn.ts';
import { WORLD_SCREENS } from './tasks/steps.ts';
import { RunStats, formatSpan } from './stats.ts';
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
  /**
   * Walk to one grid cell of the open map. The cell is the route's whole decree: where it is on the
   * screen is read from a frame captured when the tap is sent (`AutoMoveAim`), because the map's
   * canvas moves and a point converted from an older frame can land on another cell (2026-11-06).
   */
  /**
   * Walk to a map cell: the pointer toggle (only when the caller says it is not already on), the
   * cell's tap, then the 自動移動 element the tap raised. `pointerOn` is the World's pointer-mode
   * state — R is a toggle, so pressing it blindly turns the mode off half the time (2026-11-07).
   */
  automoveToTile(cell: Point, pointerOn: boolean | null): Promise<ActionResult>;
  automoveToExit(): Promise<ActionResult>;
  /**
   * 移动至宝箱 (**E** on the open map, measured live 2026-11-09): the game walks the party to a chest
   * it picks. Not the farm's way to claim a chest — the last check before the exit asks the game
   * whether any chest is reachable at all (`policy/chest-probe.ts`).
   */
  automoveToChest(): Promise<ActionResult>;
  /** Accept the `打开` prompt of the chest the party stands at. */
  acceptChestPrompt(): Promise<ActionResult>;
  /** Collect the chest loot card with one tap at its measured centre. */
  tapLoot(): Promise<ActionResult>;
  /** Dismiss the loot result banner (the card's own continue arrow) when the card taps do not leave it. */
  dismissLoot(): Promise<ActionResult>;
  /**
   * One step of the game's quick heal: the party card, the sparkle, 恢复, the page's close. One tap per
   * call, and the caller sends it only from a frame that names what it acts on (`policy/heal-sequence.ts`).
   */
  healStep(step: 'card' | 'sparkle' | 'restore' | 'close'): Promise<ActionResult>;
  /** Leave the character page: the X 关闭 tile the reader matched (2026-11-09), or its measured point. */
  closeCharacterPage(at?: Point): Promise<ActionResult>;
  /**
   * One tap at a point **perception named** — the harken menu's row, today. Not a blind tile: the
   * caller passes a control the frame itself reported (contracts §2 `harken-menu`).
   */
  tapPoint(at: Point): Promise<ActionResult>;
  /**
   * The rest town's inn: take the row the inn policy chose (the operator's room, else 标准房, else
   * the first room the dialog offers). One tap at a row the frame named (contracts §2 `inn`).
   */
  restAtInn(at: Point): Promise<ActionResult>;
  /** The battle's 倍速 toggle: one press, sent only when the frame says it is off (contracts §2). */
  battleSpeed(): Promise<ActionResult>;
  /** The battle's 自動 toggle: one press, sent only when the frame says it is off. */
  battleAuto(): Promise<ActionResult>;
  /**
   * The cast's first tap: the configured opener's quick slot. The World's battle sequence sends it as
   * one operation and waits out its own pace before the resolving press (operator rule 2026-11-04).
   */
  battleSlot(opener: BattleOpener): Promise<ActionResult>;
  /**
   * The cast's second tap: exactly the **located** 確定 of the skill detail panel (the frame named it;
   * a fixed point failed live twice — see `perception/battle-panel.ts`).
   */
  battleConfirm(at: Point): Promise<ActionResult>;
  /** One Esc: the measured way out of a page the loop cannot close (operator, 2026-11-07). */
  escape(): Promise<ActionResult>;
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
  battle?: {
    readonly openers: readonly BattleOpener[];
    readonly reader: BattleMemberReader;
    /**
     * Where the skill panel's **確定** is on this frame, or null when the panel is not drawn. The
     * cast's resolving press is this answer, never a constant (`perception/battle-panel.ts`).
     */
    readonly locateConfirm: (frame: Frame) => Promise<Point | null>;
  } | undefined;
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
 * Screens that can only be on screen while the party stands at something: the chest prompt, the
 * opener panel, the loot card, a battle. They answer a walk by themselves, because the stillness
 * rule cannot: the chest prompt animates its highlight (live 2026-11-01: two captures 0.5 s apart
 * differ on 394k pixels), so the frame never stands still and a walk handed over to the prompt
 * would never arrive — the loop then escalates instead of pressing 打开.
 */
const ARRIVAL_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'chest-prompt', 'chest-open', 'drop-item-claim', 'combat',
]);

/**
 * The screens the route acts on by itself, and whose next move the map is not: the chest's four, the
 * loot card, a battle and its skill panel, the inn and its rest, the message box the World taps, the
 * harken floor menu and its rows, a party member's revive QTE, the heal's 一键恢复 dialog, and the
 * two travel screens the travel owns. Their fallback is a wait — the route owns the screen and the
 * stall clock is the bound; a blind press is not a recovery.
 *
 * `recoverStep` answers `done` for every one of them, so a screen missing here falls through to the
 * map press: the list is the World's own dispatch read back, not a guess. Only `dungeon` (the 3-D
 * walk view, where `G` *is* the map key) and `loading` still reach it — and `loading` **does** take
 * the `G`: on a fade there is no screen to act on, so the press is a wake-up on a frame nobody has
 * named, not a decision about it. `dungeonmap` exits by its own rule above, and
 * `main-character-dead` waits before this set.
 */
const ROUTE_OWNED_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  'chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'drop-item-claim',
  'combat', 'skill-panel', 'inn', 'inn-rest', 'message', 'harken-menu', 'revive-qte',
  'quick-heal', 'worldmap', 'dungeon-select',
]);

/**
 * The recovery the loop takes when a screen is lost: what nobody's answer leaves it doing.
 *
 * The recovery policy (policy/recover.ts, operator 2026-11-07) is asked first. Its actionable steps
 * are the loop's answer — a page by its own exit, one Esc on an unnamed screen, the town page's
 * party panel collapsed so the world map behind it is revealed. A `done` step is a screen the route
 * can act on, so the loop's own fallback stands: on the map the exit itself (contracts §6), on a
 * screen the route is already working a **wait** (`ROUTE_OWNED_SCREENS`), and on the two screens
 * left — the walk view and a load fade — the map, because `F` is 移動至出口 only on the map and 調査
 * in the 3D view (navigation §3d), so a blind `F` is not a recovery.
 *
 * `unknown` is not one of the map's: `recoverStep` gives it one Esc. The second caller, `#execute`'s
 * `exit` case, honours only a `recover` answer — it is asking for a step to press, not for a wait —
 * so no screen in this set changes what it does.
 */
function fallbackFor(observation: Observation): Intent {
  // On the main character's death there is nothing to press: the question is Coo's (operator rule
  // 2026-11-05), and the game's own transition is the screen's business. A key here could skip a
  // revive prompt or land on a menu nobody named.
  if (observation.screen === 'main-character-dead') return { kind: 'wait', ms: 1_000 };
  const step = recoverStep(observation);
  if (step.kind !== 'done') return { kind: 'recover', step };
  if (observation.screen === 'dungeonmap') return { kind: 'exit' };
  // A screen that is the route's own is the route's to finish: the chest's flow, a battle, the harken
  // menu, the revive QTE, the heal's dialog, a travel screen. `G` is the map key only from the 3-D
  // walk view, so pressing it here is not a recovery — it is a command into a screen that has its own
  // work (live 2026-11-09 08:38:53: the fallback pressed G on a chest prompt, which changed nothing,
  // until the stall clock ended the run).
  if (ROUTE_OWNED_SCREENS.has(observation.screen)) return { kind: 'wait', ms: 1_000 };
  return { kind: 'open-map' };
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
 * The stop band's ± terms (operator rule 2026-11-05): the input leg's spread across the measured round
 * trips (64-76 ms live, so 15 ms covers it with margin), and the carry's spread — the park's own
 * settle tolerance plus the bar-to-bar disagreement the day's measurements showed (a bar measured at
 * 0.042 s and one at 0.089 s). Chosen bounds, not measured ones: the model exists to say 95 % only
 * when it can, and a narrow bound would lie.
 */
/** ± the input leg's own spread, ms: the measured legs were 61–76 against the 64 prior (+12/−3). */
const QTE_LATENCY_SPREAD_MS = 12;
/**
 * ± the carry **before this bar has a measured park**, px (2026-11-06 calibration): the ten normal
 * parks implied 0.04–0.10 s of carry (one -0.07 … -0.05), so the first press of a bar is uncertain by
 * ±0.08 s of slide — ~45 px at the farm bars' 550 px/s. A one-press bar is a gamble the 95 % gate must
 * be shown to be worth; the number is the data's spread, not a preference.
 */
const QTE_CARRY_SPREAD_PX = 45;
/** ± the carry **after** this bar's park was measured, px: the bar's own slide is stable (0.26–0.31 on the stuck bar). */
const QTE_MEASURED_CARRY_SPREAD_PX = 12;

/**
 * How many consecutive frames must answer the **same** ACTIVE member before the opener trusts it
 * (operator rule 2026-11-04: *until we get a stable frame, then confirm the current state*). One
 * readable frame can be a transition; two are the command phase. The wait it bounds is
 * `battleOpenerTimeoutMs`, not a fixed window.
 */
const BATTLE_STABLE_READS = 2;
/**
 * How many sub-loops one bar may consume before the loop stops pressing it (2026-11-06): the 2026-10-31
 * bar that would not resolve was pressed 224 times in 4.5 min, and every press was a refusal. A bar
 * that resolves takes one pass; a reroll ends the screen and resets the count, so this only bounds a
 * bar that stays.
 */
const QTE_MAX_TRIES_PER_BAR = 6;
/** Frames the revive QTE must stay up: one is a modal still drawing, two is a member down. */
const PARTY_DOWN_FRAMES = 2;

/** How many X 关闭 taps a character page may take before the loop leaves it to the stall clock. */
const PAGE_CLOSE_TRIES = 3;
/**
 * The heal's own pace, from `actions/heal.ts`'s measurements and `policy/heal-sequence.ts`'s contract:
 * each screen needs ~1 s before the next tap lands, the page needs up to 2.5 s to leave after the
 * close, the Esc gets the same, and the whole sequence is bounded (the four taps plus their settles
 * are ~4.5 s, so 12 s is the heal with two chances at every step).
 */
const HEAL_STEP_MS = 900;
/**
 * The heal episode's wall-clock bound, ms: the last resort for a screen that never comes back, not the
 * budget of the episode's steps (those are fact-gated). Measured live 2026-11-09: a whole heal — card
 * 5 s after the start, the page 10 s after the card, sparkle and 恢复 4 s, the toast's unnamed stretch
 * 5 s, the page again 5 s — is ~39 s; 90 s leaves room for a slow battle suspension without letting a
 * truly stuck page hold the farm.
 */
const HEAL_SESSION_DEADLINE_MS = 90_000;
/**
 * How long the party may be walking after the E check before the leave may act again, ms. The walk is
 * the game's own (it knows the route); 20 s covers the floor's longest measured chest walk, and the
 * bound only exists so a walk that never ends cannot hold the leave.
 */
const CHEST_PROBE_WALK_MS = 20_000;
/**
 * The exit goal's bound, ms (operator rule 2026-11-09). **Below the shipped `stallStopSeconds`
 * (120 s) with a 10 s margin, on purpose**: the stall check runs earlier in the tick than the
 * release, so a bound at or above the stop would be dead at the configuration the package actually
 * ships. The live failure is exactly that misreading — run 7 sat on the harken page until the stall
 * clock and the log's last word was a stop, which hid a missing caller behind a "stop condition".
 * 110 s is the shipped two-minute stop minus a ten-second margin — and it is a **hang's bound, not a
 * budget**: live run 10 measured a *working* exit at **~112 s** (the world-map panning to vnh
 * dominates it: four pans of ~7 s plus taps), so this bound fired on an exit that was doing its job
 * and was harmless only because the arrival landed the same second. The number and the mechanism (a
 * measured bound, or a silence-based one) are card `t-mw8k2hjp-3bh4ld`; until that is answered the
 * constant keeps its value.
 *
 * **What a release can achieve.** It hands the loop back to the route, and the route (or a World
 * branch) re-claims the work only from a screen it acts on: `dungeon` (open the map), `dungeonmap`
 * and `town` (the exit starts again) and `harken-menu` (the World's own harken branch). On
 * `worldmap`, `dungeon-select` and `loading` the route only waits, so nothing re-claims the episode
 * and the stall clock still ends the session — the release is a second chance, not a guarantee, and
 * `tests/world.test.ts` pins exactly that sequence (release, then the shipped stop).
 *
 * An operator who lowers `stallStopSeconds` below this deadline gets the stop instead of the
 * release — that is the documented trade, not a second number to keep in sync.
 *
 * Its scope is the ticks that **reach the pump point**: a tick the loop's own branches own (the
 * settle window, a stop, death, the QTE, a page, the inn, the heal, the blank hold) returns above it,
 * so a never-closing character page is still the stall clock's stop, not this release.
 *
 * Exported only so `tests/world.test.ts` can pin that relationship against `WVD_DEFAULTS` rather
 * than repeating the value as a second magic number.
 */
export const LEAVE_DEADLINE_MS = 110_000;
/**
 * The orientation's backstop, ms. A climb from another floor is minutes' work, and the orientation
 * marks progress when it commands (see `#orientTo`) — so the stall clock only fires when it stops
 * commanding, and this bound is what catches an episode that keeps commanding and never arrives. It
 * is above the shipped 120 s stall clock by design: the two clocks cover different failures, and this
 * one must never cut a real climb short. **Measured**, live run 10: a *working* re-entry from town
 * back to the farm floor took **~179 s** (world-map panning again), and this 180 s bound released it
 * one second later — harmless only because the arrival beat the release. The value, like the exit's,
 * is card `t-mw8k2hjp-3bh4ld`; a release hands the loop back, and on `worldmap`/`dungeon-select`/
 * `loading` nothing re-claims it (see `LEAVE_DEADLINE_MS`).
 */
const ORIENT_DEADLINE_MS = 180_000;
/**
 * A scripted stage's bound, ms. The stage walks the whole exit — the harken, Dungeon Select, the
 * world map — one step a tick, and its cursor is the step; this is the bound behind the cursor, for
 * a step that is never answered. Five minutes: the measured exit script took 48.7 s live (2026-11-05)
 * and a stage yields to battles and chests, so five minutes is a script that is genuinely stuck.
 */
const SCRIPT_DEADLINE_MS = 300_000;
/**
 * How long the skill panel's 確定 may stay owed before the cast is given up, ms. Measured: the panel
 * is drawn within one frame of the slot tap; four seconds is four chances at it.
 */
const BATTLE_CONFIRM_MS = 4_000;

/**
 * How many recovery steps one screen gets before the loop leaves it to the stall clock (operator,
 * 2026-11-07). Three, the same bound the character page's close has: a page exits in one step, an
 * unnamed screen clears in one Esc, the town page reveals its map in one collapse — a screen still
 * there after three is not a step the recovery can take, and a tenth tap is the loop fighting itself.
 */
const RECOVER_STEP_CAP = 3;

/** Windows set-1 scan code for Esc: the one key the recovery stepper presses (`back`). */
const ESC_SCAN = 0x01;

/**
 * How many ticks a readable map that carries no 楼梯-门 icon gets before the orientation stops. The
 * reader can miss the glyph on one frame (live 2026-11-03 22:07: the same floor and party tile as a
 * frame where it was found) — a frame is not a dead end, and twenty ticks are two seconds of looking.
 */
const ORIENT_MAP_ICON_PATIENCE = 20;

/**
 * How long a command that changed nothing stays refused before the route may ask again, ms.
 *
 * "Not re-sent until the farm advances" is right for a *blind* retry, but the farm can only advance
 * through a command, so the refusal could freeze the loop until the stall clock (a quarter of
 * `stallStopSeconds` — 45 s at the default 180) escalated it. Live 2026-11-08 13:30, after a battle:
 * `open-map` was given up at a 4 667 ms wait because the game was drawing at 21 FPS, the map then
 * opened *after* the give-up, the route's next ask was refused on that same epoch, and the loop sat
 * 53 s on a legible frame with one chest left. A re-arm is not that blind retry: the route re-derives
 * the intent from the frame it holds now, so the ask after this window is a fresh decision.
 *
 * 8 s = the 4.7 s open that was measured on a slow frame, with the second chance inside half of the
 * 45 s the stall clock allows.
 */
const COMMAND_REARM_MS = 8_000;

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
   * The task stage in progress (operator rule 2026-11-05: a stage is one step per tick). It is not
   * only the route's intent: the exit script walks through the Dungeon Select list, a harken menu and
   * the game's load fades, and the route has no intent for those screens, so the loop would wait the
   * stage to death. The script id is this field; **ownership** is the arbiter's `stage` claim, and
   * the pump point drives it every tick it owns. The leave goal never sets it (its ownership is the
   * exit claim and it has no cursor).
   */
  #staging: ScriptId | null = null;
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
  /** Said once per battle: the panel the cast owes is not on the frame (yet), so nothing is pressed. */
  #battlePanelWarned = false;
  /** The cast went out (a slot tap landed) — the opener was not given up. */
  #battleCastSent = false;
  /** The opener was given up for this battle: no confirmed turn card. Said once. */
  #battleOpenerGaveUp = false;
  /** The ACTIVE-member read and how many consecutive frames it has answered the same; per battle. */
  #battleRead: { readonly value: string | null; readonly frames: number } | null = null;
  /** The death scene has been sent to Coo for this death (one question, not one per tick). */
  #deathEscalated = false;
  /** The inn's dialog offered no row this loop could take (one warning per visit). */
  #innWarned = false;
  /** This inn visit has committed a rest: the dialogs that follow are backed out of, not restarted. */
  #innRested = false;

  /**
   * The cycle's rest (operator rule 2026-11-06). Armed when the exit script returns the party to the
   * town: the World then taps the task's measured inn control, the inn plug-in rests, and the cycle
   * counts once the party is back on the town's own screen — or when the visit has been given up on
   * (`TaskRest.timeoutMs`), so one missed tap cannot wedge an unattended run.
   */
  #restGate: { readonly sinceMs: number; readonly timeoutMs: number; seenInn: boolean } | null = null;
  /** Consecutive frames of the revive QTE: the modal has to stay up, not flicker. */
  #reviveFrames = 0;
  /** The revive QTE has been sent to Coo for this death (one question, not one per tick). */
  #reviveAsked = false;
  /**
   * The chest QTE's measured terms for the **bar on screen**: the carry time from a settled press's
   * park, and the input leg from the press's round trip. Cleared when a new chest starts; the config
   * values are the prior until the bar has been measured (operator rule 2026-11-05).
   */
  #qteCarryTauS: number | null = null;
  #qteLatencyMs: number | null = null;
  /** Character-page close taps sent for the page on screen; the page's own name re-arms them. */
  #pageCloseTries = 0;
  /**
   * The heal in flight: a sequence of steps, each sent only from a frame that names what it acts on
   * (`policy/heal-sequence.ts`). Non-null means the heal owns the tick until it is done or gives up.
   */
  #heal: HealSession | null = null;
  /**
   * The screen the heal is waiting on, so one wait costs one log line (see the heal branch). Reset
   * whenever the heal starts or is dropped: it belongs to the episode, not to the World.
   */
  /** The step the heal last waited on (step + reason): one wait costs one log line. */
  #healWaitOn: string | null = null;
  /** The screen the last frames named, and how many in a row: the stable-frame gate. */
  #stableScreen: ScreenId | null = null;
  #stableCount = 0;
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
  readonly #battle: {
    readonly openers: readonly BattleOpener[];
    readonly reader: BattleMemberReader;
    readonly locateConfirm: (frame: Frame) => Promise<Point | null>;
  } | undefined;
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
  /**
   * What each screen's reads have been worth, learned from whether the action worked (policy/trust.ts).
   * The composite scales that screen's floor by this, so a screen that keeps being right may act from a
   * weaker read and one the loop just contradicted must clear a higher bar.
   */
  #trust = createTrust();
  #lastMapRead: MapRead | null = null;
  #lastIntent: { readonly intent: Intent; readonly atMs: number } | null = null;
  #lastObservation: Observation | null = null;
  /** The recovery's bound: the screen (and page) the steps were spent on, and how many so far. */
  /**
   * When the recovery pressed its one `Esc` on an unnamed frame, and the frame's name since — the
   * probe's outcome, which is the only way a stall's log can say *what* the unnamed frame was.
   */
  #backProbeAtMs: number | null = null;
  #recoverEpoch: string | null = null;
  #recoverSteps = 0;
  /** The one warning a capped screen gets, so a lost screen does not log every tick. */
  #recoverCapped = false;
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
  /** Sub-loops spent on the bar now on screen; the spin guard (2026-11-06). */
  #qteTries = 0;
  /** The spin guard's warning has been written for this bar. */
  #qteSpinWarned = false;
  /**
   * When the party is owed a heal (operator's matrix, 2026-11-09): the events (a completed battle, a
   * completed chest, the entry, a rest) are counted here, and the debt survives a failed attempt —
   * only a completed heal pays it. The schedule is pure; the World owns the taps and the page.
   */
  #healSchedule: HealSchedule;
  /** The run stats' completed counts as of the previous tick, so each battle/chest is one event. */
  #healSeen: { readonly battles: number; readonly chests: number } = { battles: 0, chests: 0 };
  /**
   * The last reachable-chest check before the exit (policy/chest-probe.ts, operator 2026-11-09): the
   * floor the E press was sent on and when, and the floor it already answered for (never asked twice).
   * While a probe runs the leave waits — the probe owns the frame until the game answers.
   */
  #chestProbe: { readonly floor: string; readonly atMs: number } | null = null;
  #chestProbeDone: string | null = null;

  /**
   * The arbiter of the loop's intent-driven stages (policy/stage-registry.ts, operator rule
   * 2026-11-09): the orientation, the exit and a scripted stage take the tick one at a time, and the
   * owner is pumped from the tick itself — not from the intent that started it. One owner at a time
   * is what makes an owner always driven; the flag this replaces was a promise nobody kept.
   */
  readonly #stages = new StageRegistry();
  /**
   * The orientation owns the loop (contracts §10, the goal form): from the session start until the
   * map shows the farm floor. Derived from the arbiter, never assigned — a second flag would be a
   * second owner.
   */
  get #orienting(): boolean {
    return this.#stages.owner?.name === 'orient';
  }
  /** Aborts an orientation travel or climb when the session ends under it. */
  #orientAbort: AbortController | null = null;
  #orientTravelFailures = 0;
  #orientClimbs = 0;
  /** The orientation asked for the loop and was refused: one line per orientation episode. */
  #orientRefused = false;
  /**
   * The leave goal owns the loop (contracts §10, 2026-11-09): the policy said exit and the party is
   * not back in town yet. There is **no cursor** — each tick's frame and floor decide
   * (policy/leave.ts), so an interrupted leave resumes on whatever screen the game is actually on.
   * Derived from the arbiter, never assigned.
   */
  get #leaving(): boolean {
    return this.#stages.owner?.name === 'exit';
  }
  /** The leave asked for the loop and was refused: one line per leave episode. */
  #leaveRefused = false;
  /** A scripted stage asked for the loop and was refused: one line per stage episode. */
  #stageRefused = false;
  /** Travel failures spent on the leave, so a dead destination cannot be retried forever. */
  #leaveTravelFailures = 0;
  /** Until this instant the loop only watches: a travel or a climb just landed on a loading fade. */
  #settleUntilMs = 0;
  /** The screen the settle started from: the frame that still shows it is not the load finishing. */
  #settleFrom: ScreenId | null = null;
  /** The loot card's tap clock and count, so a modal that never leaves is bounded (lootTap*). */
  #lootTapAtMs: number | null = null;
  #lootTaps = 0;
  /** The run's own log: chests and battles, per cycle and in total (operator, 2026-11-07). */
  #stats = new RunStats();
  /** The map's pointer mode, as last known: null unknown, true on. Reset whenever the map closes. */
  #pointerMode: boolean | null = null;
  /** The result banner's continue arrow was sent for this visit to the item-claim screen. */
  #lootDismissed = false;
  /** Commands sent and waiting for their screen to answer (one at a time). */
  #inFlight: InFlight | null = null;
  /** Commands that changed nothing on this screen epoch: not re-sent until the farm advances. */
  #failed: Set<Intent['kind']> = new Set();
  /** When each of those failed, so the refusal can expire (see `COMMAND_REARM_MS`). */
  #failedAtMs: Map<Intent['kind'], number> = new Map();
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
    this.#healSchedule = new HealSchedule({
      afterBattles: this.#cfg.healAfterBattles,
      afterChests: this.#cfg.healAfterChests,
      onEntry: this.#cfg.healOnEntry,
      afterRest: this.#cfg.healAfterRest,
    });
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

  /**
   * A screen's confidence-floor multiplier, for the composite (policy/trust.ts). 1 until that screen has
   * a record; `main.ts` wires it into `CompositePerceiver`'s `floorFactor`, so the loop's own outcome
   * evidence decides how strictly the next read of that screen is held.
   */
  trustFactor(screen: ScreenId): number {
    return this.#trust.factor(screen);
  }

  /** What the trust book believes, for the run report (one entry per screen with a record). */
  trustSnapshot(): ReadonlyArray<{ readonly screen: ScreenId; readonly streak: number; readonly factor: number }> {
    return this.#trust.snapshot();
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
      this.#recoverEpoch = null;
      this.#recoverSteps = 0;
      this.#recoverCapped = false;
      this.#qteRerolls = 0;
      this.#lootTapAtMs = null;
      this.#lootTaps = 0;
      this.#ticks = 0;
      this.#captureFailures = 0;
      this.#willpower = [];
      this.#chestsRemaining = INITIAL_CHEST_BUDGET;
      this.#unreachable = [];
      this.#walkFailures = new Map();
      this.#inFlight = null;
      this.#failed = new Set(); this.#failedAtMs = new Map();
      this.#openerRefusal = null;
      this.#escalationCooldownUntilMs = 0;
      this.#lastStopReason = null;
      this.#lastFailed = false;
      this.#engineProblem = null;
      this.#cyclesDone = 0;
      this.#restGate = null;
      this.#battlesEntered = 0;
      // A new session starts with no owner. The arbiter is the World's, not the session's, and a
      // session can end mid-leave: nothing of the last episode may survive into this one.
      this.#stages.release('exit');
      this.#stages.release('stage');
      this.#stages.release('orient');
      this.#staging = null;
      this.#leaveRefused = false;
      this.#orientRefused = false;
      this.#stageRefused = false;
      this.#leaveTravelFailures = 0;
      this.#orientAbort = null;
      this.#orientTravelFailures = 0;
      this.#orientClimbs = 0;
      this.#settleUntilMs = 0;
      this.#blankSinceMs = null;
      // The heal's debt is a session's, and so is its baseline: the run stats' counts start at what
      // they were before this session, so the first completed battle/chest is one event, not many.
      this.#healSchedule.resetCycle();
      this.#healSeen = this.#stats.completed;
      this.#heal = null;
      this.#healWaitOn = null;
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
        // The orientation takes the loop here; the pump point drives it from the first tick.
        const claimed = this.#stages.claim('orient', now);
        if (!claimed.ok) this.#logOrientRefused(claimed.heldBy);
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
    // The run's own log (operator, 2026-11-07): one interval per chest and per battle, from the game's
    // mode — which holds a modal mode through the frames that do not name it.
    this.#stats.observe(observation.screen, this.#mode.mode, now);
    // The heal's events (operator's matrix, 2026-11-09): a **completed** battle (the battle mode's span
    // ended) and a **completed** chest (the chest screens' span ended) are the two signals the run
    // summary already counts, so the schedule watches their deltas instead of inventing a second rule.
    const completed = this.#stats.completed;
    if (completed.battles > this.#healSeen.battles) this.#healSchedule.battleCompleted();
    if (completed.chests > this.#healSeen.chests) this.#healSchedule.chestCompleted();
    this.#healSeen = completed;

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
      // The operator's unattended run wants the session to *end* here, with the frame attached
      // (`stopOnDeath`), instead of waiting for an answer nobody will give (2026-11-05).
      if (this.#cfg.stopOnDeath) {
        await this.#stopWithEvidence(session, frame, 'the main character died');
        return;
      }
      if (!this.#deathEscalated) {
        this.#deathEscalated = true;
        this.#host?.log.warn('wvd: the main character died; asking Coo what to do');
        await this.#escalate(session, frame, observation, now);
      }
      return;
    }

    // A party member's death is the game's revive QTE (operator, 2026-11-05: "a party member died
    // during battle — like revive screen"). The frame is named now, so the loop never presses into
    // it. With `stopOnDeath` the session ends with the frame attached; without it, the question is
    // raised once per death like the main character's scene. Two consecutive frames, because one is
    // a modal still drawing.
    if (observation.screen === 'revive-qte') {
      this.#reviveFrames += 1;
      if (this.#reviveFrames >= PARTY_DOWN_FRAMES) {
        if (this.#cfg.stopOnDeath) {
          await this.#stopWithEvidence(session, frame, 'a party member is down: the revive QTE');
        } else if (!this.#reviveAsked) {
          this.#reviveAsked = true;
          this.#host?.log.warn('wvd: a party member is down; asking Coo what to do');
          await this.#escalate(session, frame, observation, now);
        }
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

    // The last reachable-chest check's answer (policy/chest-probe.ts, operator 2026-11-09): a chest
    // screen is the game's yes, the map closing is its walk, and the map staying past the window is its
    // no. A "no" releases the walk it is holding and lets the leave press F.
    if (this.#chestProbe !== null) {
      const probe = this.#chestProbe;
      const decision = nextChestProbe(observation, {
        probe,
        done: this.#chestProbeDone,
        farmFloor: this.#task?.leave?.farmFloor ?? null,
        chestsShown: this.#lastMapRead?.chests.length ?? 0,
      }, now);
      if (decision.kind === 'found') {
        this.#chestProbeDone = probe.floor;
        this.#chestProbe = null;
        this.#host?.log.info('wvd: the E check found a chest; the farm continues');
      } else if (decision.kind === 'none') {
        this.#chestProbeDone = probe.floor;
        this.#chestProbe = null;
        this.#inFlight = null;
        this.#host?.log.info(
          `wvd: the E check found no reachable chest in ${CHEST_PROBE_MS / 1000} s; the exit proceeds`,
        );
      } else if (decision.kind === 'walking' && now - probe.atMs >= CHEST_PROBE_WALK_MS) {
        this.#chestProbeDone = probe.floor;
        this.#chestProbe = null;
        this.#inFlight = null;
        this.#host?.log.warn('wvd: the E check has been walking too long; the exit proceeds');
      }
    }

    // A probe's outcome is evidence, not a side effect: the Esc that was owed for an unnamed frame has
    // been answered by a named screen, so the log says what the frame was. This is the line that was
    // missing at 14:02 on 2026-11-08, when a HUD-less cutscene held the run for four minutes.
    if (this.#backProbeAtMs !== null && observation.screen !== 'unknown' && observation.screen !== 'loading') {
      this.#host?.log.info(
        `wvd: one Esc cleared the unnamed frame; it was ${observation.screen}`,
      );
      this.#backProbeAtMs = null;
    }
    // The floor is judged **after a move**, not on every frame (operator rule 2026-11-08: measure again
    // after each action, never continuously — it is the arrival that can leave the party elsewhere). A
    // map off the task floor re-arms the orientation, whose stairs/climb/fallback is the only actor that
    // knows how to get back: without that, the task gate stops a session that is merely on the stairs
    // (live 2026-11-08 00:44, run 24: 'the map is not the task floor', read 0c0280… vs 0000…).
    if (!waiting && this.#task?.orient !== undefined && observation.screen === 'dungeonmap'
      && !isExpectedFloor(this.#task.orient.floor, observation.map.titleKey)) {
      // The claim is the arbiter's (2026-11-09): while another stage owns the loop — the exit, on this
      // very frame in live run 7 — the orientation neither re-arms nor acts, and the refusal is said
      // once per episode instead of once per tick.
      const wasOurs = this.#orienting;
      const claimed = this.#stages.claim('orient', now);
      if (!claimed.ok) this.#logOrientRefused(claimed.heldBy);
      else if (!wasOurs) this.#host?.log.info('wvd: off the task floor; the orientation is re-armed');
    }

    // A page of the knowledge base (operator rule 2026-11-06: a named page can always be left). The
    // reader named it and the catalog carries the measured tap that leaves it, so the tick sends that
    // one command and lets the frame answer. It runs before the rest gate on purpose: a menu over the
    // town is exactly what would otherwise hold the cycle's rest open until the gate timed out.
    if (!waiting && observation.screen === 'ui-menu') {
      // The page's own exit is the recovery stepper's first step (policy/recover.ts), so the close
      // is one `recover` intent: `#execute` paces it, bounds it and logs it like every other press.
      await this.#execute({ kind: 'recover', step: recoverStep(observation) }, observation.screen, {
        session,
        frame,
        observation,
        now,
      });
      return;
    }

    // The cycle's rest (operator rule 2026-11-06): while the gate is armed the tick still dispatches
    // the inn and message plug-ins — the gate is what counts the cycle once the party is back in town.
    if (await this.#advanceRestGate(observation, now)) return;

    // The heal is an **owned episode** (policy/heal-session.ts, operator's design 2026-11-09): card,
    // sparkle, 恢复 and close are four steps, each gated by its own fact — the page, the 一键恢复
    // dialog, the dialog gone, the page gone — never by a timer. **When** is the schedule's
    // (policy/heal-schedule.ts): a completed battle/chest (or the entry/rest) owes a heal, and only a
    // completed episode pays the debt.
    //
    // While the episode runs it **owns the interface**: the page-close branch below waits for it, an
    // unnamed or transitional frame is a wait, and only the game's own screens suspend it — a battle,
    // a chest QTE, a death, and the chest flow the route owns — with its step kept. The previous sequence was abandoned by any named screen,
    // which is the open/close loop the operator saw live 2026-11-09 05:22-05:29.
    // Priority over the route: the episode is created as soon as the page is up or the walk view has
    // held for the loop's own stability gate, so the route cannot spend the tick opening the map first
    // (its card step waits for the stricter "settled" fact inside the episode).
    if (this.#heal === null && !waiting && this.#healSchedule.owed
      && (observation.screen === 'character-page'
        || (this.#mode.mode === 'dungeon' && observation.screen === 'dungeon' && this.#stableCount >= 2))) {
      const due = this.#healSchedule.due(now);
      if (due.due) {
        this.#heal = new HealSession({ stepMs: HEAL_STEP_MS, deadlineMs: HEAL_SESSION_DEADLINE_MS });
        this.#heal.enter(now, observation.screen === 'character-page');
        this.#healWaitOn = null;
        this.#host?.log.info(
          `wvd: the heal starts (${due.cause})${observation.screen === 'character-page' ? ' on a page already up' : ''}`,
        );
      }
    }
    if (this.#heal !== null) {
      const decision = this.#heal.next(this.#healFacts(observation), now);
      switch (decision.kind) {
        case 'wait': {
          const key = this.#heal.step + ':' + decision.why;
          if (this.#healWaitOn !== key) {
            this.#healWaitOn = key;
            this.#host?.log.info(
              `wvd: heal waiting (${this.#heal.step}): ${decision.why} on ${observation.screen}`
              + ` (stable ${this.#stableCount})`,
            );
          }
          // A suspension means the **game** owns the frame — a battle, a QTE, a death, or the chest
          // flow the route finishes: the episode keeps its step and this tick carries on into that
          // screen's own dispatch. Every other wait is the heal's to sit out.
          if (decision.why !== 'suspended') return;
          break;
        }
        case 'message': {
          const tapped = await this.#commands.tapPoint(decision.at);
          if (tapped.ok) this.#host?.log.info('wvd: the heal: advanced the result box');
          return;
        }
        case 'done': {
          const unverified = decision.unverified;
          this.#heal = null;
          this.#healWaitOn = null;
          this.#healSchedule.completed();
          this.#host?.log.info(unverified
            ? 'wvd: the heal is over (unverified: no dialog was seen); the farm continues'
            : 'wvd: healed the party');
          return;
        }
        case 'failed': {
          this.#heal = null;
          this.#healWaitOn = null;
          const rearmed = this.#healSchedule.gaveUp(now);
          this.#host?.log.warn(
            `wvd: the heal failed (${decision.why}); `
            + (rearmed ? 'the debt re-arms after the backoff' : 'the episode is spent'),
          );
          return;
        }
        case 'send': {
          this.#host?.log.info(
            `wvd: heal step ${decision.step} from ${observation.screen} (stable ${this.#stableCount}`
            + `${decision.at === undefined ? '' : `, at ${decision.at.x},${decision.at.y}`})`,
          );
          const sent = decision.step === 'card' || decision.step === 'sparkle'
            ? await this.#commands.healStep(decision.step)
            : decision.at !== undefined
              ? await this.#commands.tapPoint(decision.at)
              : await this.#commands.escape();
          if (sent.ok) this.#heal.sent(this.#now());
          else {
            this.#heal.refused(this.#now());
            this.#host?.log.warn(`wvd: the heal's ${decision.step} command was refused (${sent.reason}); the step stays owed`);
          }
          return;
        }
        default:
          return;
      }
    }

    // The character page: a menu the heal (or an operator) opens, and a screen the loop *finishes* —
    // operator rule 2026-11-03: *after open and heal there shall be a close of the character panel, so
    // go back to the dungeon*. Its X 关闭 tile is the evidence that names it, and the tap goes to the
    // tile the reader **matched**; a page that stays costs one tap per tick, capped.
    //
    // While a heal is owed the branch waits: the episode owns the page until it finishes (its own
    // close is Esc first, the matched tile second), and a second actor here is the open/close loop the
    // operator saw live 2026-11-09.
    if (this.#heal === null && !this.#healSchedule.owed && !waiting
      && observation.screen === 'character-page') {
      // Paced (operator rule 2026-11-03): the page animates while it closes, and a tap sent into that
      // animation lands on the 3-D view and opens another member's page. One tap per pace, on a frame
      // that has stopped moving.
      if (!this.#pacer.ready(now)) return;
      this.#pacer.act(now);
      if (this.#pageCloseTries >= PAGE_CLOSE_TRIES) {
        // The page takes no close: hand it to the measured way out instead of sitting on it until the
        // stall clock (live 2026-11-07 22:34: three presses at the tile returned ok and the page stayed
        // — the level-up page the battle's XP draws swallows presses while it arrives — and one Esc
        // closed the same page class at 22:31). One Esc, once per page episode.
        if (!this.#pageCloseWarned) {
          this.#pageCloseWarned = true;
          this.#host?.log.warn(
            `wvd: the character page did not close after ${PAGE_CLOSE_TRIES} taps; pressing Esc once`,
          );
          await this.#commands.escape();
        }
        return;
      }
      this.#pageCloseTries += 1;
      const closed = await this.#commands.closeCharacterPage(observation.at);
      if (closed.ok) this.#host?.log.info('wvd: closed the character page');
      else this.#host?.log.warn(`wvd: the character page close was refused (${closed.reason})`);
      return;
    }

    // The rest town's inn (operator, 2026-11-06): the dialog's room options are its own evidence, and
    // the module's one command is the row the policy chose — the configured room, else 标准房, else
    // the first room the dialog offers, else 住宿 (into the room list) or 返回 (out of a list with no
    // usable room). One tap per pace; the rest scene itself is the game's, and the town it leaves the
    // party in is the orientation's business.
    if (!waiting && observation.screen === 'inn') {
      if (!this.#pacer.ready(now)) return;
      const choice = chooseInnRest(observation.rows, this.#cfg.innRoom, this.#innRested);
      if (choice === null) {
        if (!this.#innWarned) {
          this.#innWarned = true;
          this.#host?.log.warn('wvd: the inn offers no row this loop can take');
        }
        return;
      }
      this.#pacer.act(now);
      const tapped = await this.#commands.restAtInn(choice.at);
      if (tapped.ok) {
        // The room tap, or its confirmation, is the rest's commitment: the visit's rest is spent, and
        // the dialogs that follow (the after-rest box, the menu again) are backed out of.
        if (choice.kind === 'rest' || choice.kind === 'confirm') this.#innRested = true;
        this.#host?.log.info(`wvd: the inn: ${choice.kind} at ${choice.label} (${choice.at.x},${choice.at.y})`);
      } else {
        this.#host?.log.warn(`wvd: the inn row was refused (${tapped.reason})`);
      }
      return;
    }

    // The game's one-off message box (operator, 2026-11-06): the after-rest 背包已补充完毕。 first. One
    // tap on the panel advances it, and the screen behind it is someone else's (the inn's menu, the
    // town, the dungeon).
    if (!waiting && observation.screen === 'message') {
      if (!this.#pacer.ready(now)) return;
      this.#pacer.act(now);
      const tapped = await this.#commands.tapPoint(observation.at);
      if (tapped.ok) this.#host?.log.info('wvd: advanced the message box');
      else this.#host?.log.warn(`wvd: the message box tap was refused (${tapped.reason})`);
      return;
    }

    // The inn's rest scene (2026-11-07): the visit itself — a blurred inn interior with the rest caption
    // and a yellow continue mark. One tap on the mark advances it to the after-rest box; the gate has
    // already counted the visit by the time this runs.
    if (!waiting && observation.screen === 'inn-rest') {
      if (!this.#pacer.ready(now)) return;
      this.#pacer.act(now);
      const tapped = await this.#commands.tapPoint(observation.at);
      if (tapped.ok) this.#host?.log.info('wvd: the inn rest scene: advancing it');
      else this.#host?.log.warn(`wvd: the rest scene tap was refused (${tapped.reason})`);
      return;
    }

    // The harken's floor menu (operator rule 2026-11-03): the list is not fixed — a harken offers a
    // floor only once that floor's harken is reconstructed — so the climb reads it. The task names the
    // farm floor's row; when the menu offers it the World taps it (the teleport). When it does not, the
    // 归还 row backs the party out and the stair icon is the way up.
    if (!waiting && observation.screen === 'harken-menu' && !this.#leaving) {
      // One owner per page (operator rule 2026-11-09): while the leave goal owns the loop this branch
      // is the orientation's, so it neither acts nor returns — the tick falls through to the pump
      // point, where the leave judges the page from the frame and the floor (policy/leave.ts). That
      // return is what deadlocked run 7: the branch deferred to a flag nothing pumped.
      if (!this.#pacer.ready(now)) return;
      // The farm floor may never take 归还 (operator rule 2026-11-09): the party's way off the floor
      // it farms is that floor's own exit, never the harken. Back out of the page instead of leaving.
      const farmFloor = this.#task?.orient?.floor ?? null;
      const floor = this.#lastMapRead?.floor ?? null;
      if (farmFloor !== null && floor !== null && isExpectedFloor(farmFloor, floor)) {
        this.#pacer.act(now);
        this.#host?.log.warn('wvd: the harken page is open on the farm floor; backing out instead of taking 归还');
        await this.#commands.escape();
        return;
      }
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
    // Nothing to act on: a frame nothing named, or the game's own blank one (perception/loading.ts).
    // The named load is not an *unknown* frame — it is a known wait — but for the settle window's
    // purpose it is the same fact: no screen is there to judge yet.
    const blank = observation.confidence <= 0 || observation.screen === 'loading';
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
    //
    // …except inside the cycle's rest (operator rule 2026-11-06): the rest draws its own scene, and
    // measured 2026-11-06 it is ~13 s of frames nothing names between 确定 and the after-rest box.
    // While the gate is armed that blank is the visit's, so a slow rest must not end the run.
    if (
      verdict === 'stop'
      && blank
      && this.#restGate === null
      && now - (this.#blankSinceMs ?? now) < this.#cfg.escalateSettleMs
    ) {
      return;
    }
    // The stall promotion sits **above** the pump point, deliberately (restored 2026-11-09, the
    // whole-branch review's Important 1). An owner that spends the tick without commanding — the
    // orientation waiting on an `unknown`, a `loading` fade or a map-icon frame, the leave waiting
    // out a walk — would otherwise take every stalled tick before the promotion could see it, and a
    // stuck stage would never ask its question: it would ride out its own longer bound and stop on
    // the session clock instead, which is exactly the masking the arbiter exists to remove. The base
    // build pumped the orientation *after* this line for the same reason. So a stalled tick escalates
    // first (the question, then its fallback) and the pump runs on every other tick.
    if (verdict === 'ok' && stalledMs >= this.#stallEscalateMs()) verdict = 'escalate';

    // **The one pump point** (arbiter, 2026-11-09). A stage in progress is the loop's own work, and
    // the screens it walks through are why the route has no intent for it: the Dungeon Select list,
    // the harken menu, the town it arrives in, a load fade. A town frame at 0.94 is not a stall, it
    // is the stage's next `expect` (live 2026-11-06: the exit's town arrival escalated six times and
    // the fallback's map presses opened the inn dialog, which no recogniser names) — and the stage's
    // own command marks progress (see `#orientTo`, `#leaveCommand`), so the promotion above never
    // sees a working stage as stalled.
    //
    // It is the tick that drives the owner, not the intent that started it: the route has no intent
    // for the harken page (it says `wait` there), so an owner pumped from `run-script` sits undriven
    // — live run 7, where the leave owned the harken page and the stall clock ended the session.
    // The screens the loop's own branches own pre-empt this point above; a battle, a chest, the loot
    // card and a page are the route's, not an owner's, so they are excluded exactly as they were for
    // the scripted stage. A pump that yields hands the tick back to the route below.
    this.#releaseOverdueStage(now);
    const owner = this.#stages.owner;
    if (verdict === 'ok' && !waiting && owner !== null && !WORLD_SCREENS.has(observation.screen)) {
      if (await this.#pumpOwner({ session, frame, observation, now })) return;
    }

    // Operator rule 2026-11-03: ask the game before asking the model. An unnamed frame is often the
    // 3-D view with something over it — the menu legend draws a panel whose ink reads as a map title,
    // and a bright scene fills the title band (measured on
    // testdata/screens/2026-11-03-gmenu/gmenu-3d-view.jpg: minimap arrow 35 px, title-band ink 5 119 px,
    // t-mvy23qe2). The map states the floor in text and is one command away, so that command is sent
    // once per unnamed episode; only a frame still unnamed afterwards becomes a question. This is the
    // same recovery the question's own timeout would otherwise take, moved in front of the 90 s.
    // The frame's own evidence says dungeon, so the map is the surface it is asking about — this is
    // not a lost screen and the recovery stepper's `back` is not its answer.
    if (verdict === 'escalate' && dungeonLike && !this.#askedForMap && !waiting) {
      this.#askedForMap = true;
      this.#host?.log.info('wvd: the frame is unnamed; opening the map to ask the game before the question');
      await this.#execute({ kind: 'open-map' }, observation.screen, {
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

    // A **map frame is the result of an action** (open-map, a walk landing on a floor, a travel): judge it
    // once, here. If it is not the task floor the orientation takes over again — the operator's rule
    // (2026-11-08): check after an action, stop checking on arrival. Live 00:42-00:44 (run 24): the farm
    // walked onto the stair floor after the orientation had retired on arrival, and the task's floor gate
    // stopped the session where the only sensible next order was 'go to the farm floor'.
    const orientTask = this.#task?.orient;
    if (!this.#orienting && orientTask !== undefined && observation.screen === 'dungeonmap'
      && !isExpectedFloor(orientTask.floor, observation.map.titleKey)) {
      // A second chance at the re-arm above: this site runs only when no earlier branch spent the
      // tick, so a map frame that reached here with no owner claims the orientation now. The claim is
      // still the arbiter's — a refused one logs once and acts not at all.
      const claimed = this.#stages.claim('orient', now);
      if (claimed.ok) this.#host?.log.info('wvd: not on the farm floor; the orientation takes over again');
      else this.#logOrientRefused(claimed.heldBy);
    }

    // The orientation's own command is the pump point's (`#pumpOrient`): one owner, one pump, one
    // place. It used to live here, which is why a second owner could act on the same frame.

    let intent = this.#policy.next(state);
    // The skill panel a slot tap opens is a frame the recognisers do not name, and the route's rule is
    // that an unnamed screen is a wait, never a click — so the battle branch inside `#execute` would
    // never be reached to send the second half of the cast the loop itself started (live 2026-11-07
    // 22:00:11: the panel for 拉巴迪奥斯的秘术, 48 s, the run stopped on the stall clock). This is not
    // a decision about an unknown frame: it is the operation the sequence already owes, which needs no
    // evidence from the frame at all — the panel covers the toggles and the press is on its own button.
    // Only that one obligation outranks the wait; every other unnamed screen still waits.
    if (intent.kind === 'wait' && this.#mode.mode === 'battle' && this.#battleSequence?.pendingConfirm() != null) {
      intent = { kind: 'fight' };
    }
    // The route may not press from a page frame, or from a frame that has not held: open-map on a page
    // cannot open a map, and the loop then closes the page and asks again — the 20 s alternation of
    // live 2026-11-07 23:39 / 2026-11-08 00:00 (runs 21, 22). One owner, from a stable frame.
    if (intent.kind === 'open-map' && (observation.screen === 'character-page' || this.#stableCount < 2)) {
      return;
    }
    if (COMMAND_KINDS.has(intent.kind) && this.#failed.has(intent.kind)) {
      // A blind retry is not a decision: `openMap` presses `G` once now, but a `G` on an already-open map is
      // 移动至目的地. It is not a life sentence either — see `COMMAND_REARM_MS`.
      const failedAt = this.#failedAtMs.get(intent.kind) ?? now;
      if (now - failedAt < COMMAND_REARM_MS) {
        this.#host?.log.warn(`wvd: ${intent.kind} already changed nothing on this screen; not sending it again`);
        return;
      }
      // Re-armed: the route re-derived this intent from the frame in hand, so asking again is a fresh
      // decision, not a replay of the one that failed.
      this.#failed.delete(intent.kind);
      this.#failedAtMs.delete(intent.kind);
      this.#host?.log.info(
        `wvd: ${intent.kind} re-armed after ${Math.round((now - failedAt) / 1000)} s; asking again from this frame`,
      );
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
    this.#battlePanelWarned = false;
    this.#battleCastSent = false;
    this.#battleOpenerGaveUp = false;
    this.#battleRead = null;
  }

  /** The two counts the route's `RouteState` needs, from the observation that carries them. */
  #track(observation: Observation): void {
    if (observation.screen === this.#stableScreen) this.#stableCount += 1;
    else { this.#stableScreen = observation.screen; this.#stableCount = 1; }
    if (observation.screen === 'chest-prompt') {
      // A chest's prompt starts a new bar: its measured carry and input leg do not carry over.
      this.#qteCarryTauS = null;
      this.#qteLatencyMs = null;
    }
    if (observation.screen !== 'main-character-dead') this.#deathEscalated = false;
    if (observation.screen !== 'revive-qte') {
      this.#reviveFrames = 0;
      this.#reviveAsked = false;
    }
    if (observation.screen !== 'inn') this.#innWarned = false;
    // The visit is over when the party is back on the town's own screen: the next sighting of the inn
    // is a fresh visit, and may rest again.
    if (observation.screen === 'town') this.#innRested = false;
    if (observation.screen !== 'chest-qte') {
      this.#qteTries = 0;
      this.#qteSpinWarned = false;
    }
    if (observation.screen !== 'chest-open') this.#openerRefusal = null;
    // The budget is per page episode: a frame the page was not named on does not end it (live
    // 2026-11-07 22:42 and 22:54: the counter reset on every flicker and the Esc never went out).
    this.#pageCloseTries = nextPageCloseTries(observation.screen, this.#pageCloseTries);
    if (this.#pageCloseTries === 0) this.#pageCloseWarned = false;
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
          // A panel that never comes is a cast the battle cannot resolve: give it up and press 自動
          // rather than holding the confirm forever with the battle waiting for input (2026-11-08).
          confirmTimeoutMs: BATTLE_CONFIRM_MS,
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
      case 'ui-menu':
        // A page the reader named: appearing and leaving are activity, staying on one is not the farm
        // moving on — the stall clock is what ends a page that never closes.
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
      // The heal is not armed here: the schedule counts **completed** battles and chests from the run
      // stats (2026-11-09), so an event is one event and the frequency is a config value.
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
    // The click's prediction came true on the chest's own screen: that screen's reads are worth more.
    if (this.#inFlight !== null) this.#trust.confirmed(this.#inFlight.fromScreen);
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
          this.#markFailed('open-chest');
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
        this.#markFailed('open-chest');
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
        // The key did what the read predicted on that screen (policy/trust.ts: verification by action).
        this.#trust.confirmed(inFlight.fromScreen);
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
        this.#trust.confirmed(inFlight.fromScreen);
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
        this.#trust.confirmed(inFlight.fromScreen);
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
  /** Record a command that changed nothing, with the clock `COMMAND_REARM_MS` measures from. */
  #markFailed(kind: Intent['kind']): void {
    this.#failed.add(kind);
    this.#failedAtMs.set(kind, this.#now());
  }

  #gaveUp(inFlight: InFlight, evidence: Record<string, number>): void {
    // The read said this key belonged here; the screen did not answer it. That screen's floor is
    // stricter until a confirmation returns it (policy/trust.ts — trust is easy to lose).
    this.#trust.contradicted(inFlight.fromScreen);
    const target = inFlight.target;
    if (inFlight.kind === 'move' && target !== null) {
      this.#skip(target, 'the walk never started', evidence);
      return;
    }
    this.#markFailed(inFlight.kind);
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
    // The evidence is the frame the reader judged, encoded here rather than captured again: a second
    // capture is a different instant, and on 2026-11-08 that difference was an hour of diagnosis — the
    // loop escalated a correct `dungeon 0.94`, the snapshot caught the menu an Esc had just opened, and
    // the saved frame classified `ui-menu 0.93`. Only a source with no pixels falls back to its capture.
    const judged = await judgeSnapshot(frame, maxWidth);
    const snapshot = judged?.jpeg ?? await takeSnapshot(session.snapshot, maxWidth);
    // The same frame, losslessly: the refused bytes are the evidence, and a q75 re-encode hid the very
    // detail that caused a refusal twice on 2026-11-08. A source without a PNG path simply has none.
    const lossless = judged?.png ?? await takeSnapshotLossless(session.snapshot, maxWidth);
    // A stop can land inside that capture. Nothing may be asked — or acted on — after it.
    if (!this.#running || this.#session !== session) return;
    const image = snapshot ? snapshotBlob(snapshot) : null;
    const imageLossless = lossless ? losslessBlob(lossless) : null;
    const imageVisible = this.#supervisor.imageAccepted();
    const question = this.#question(observation);
    const id = `esc-${this.#nextEscalationId++}`;
    const timeoutMs = this.#cfg.escalateTimeoutMs;
    // The recovery the model is told about, and the one the loop takes, are the same decision:
    // the recovery stepper's next step when it is one to press, else the loop's own fallback (the
    // exit on the map, a wait on a screen the route is working, the map anywhere else — never `F`
    // blind, §3d).
    const fallback = fallbackFor(observation);

    const envelope = stuckEvent({
      imageLossless,
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
    this.#failed = new Set(); this.#failedAtMs = new Map();
    this.#willpower = [];
    this.#openerRefusal = null;
    this.#escalationCooldownUntilMs = 0;
    // Per-cycle QTE/battle state: a give-up or a partly spent reroll budget in one cycle must not
    // silence the next cycle's bar.
    this.#qteRerolls = 0;
    this.#rearmBattle();
    this.#askedForMap = false;
    // A leave that was interrupted by the cycle boundary is over: the next exit is a fresh goal,
    // judged from its own first frame (there is no cursor to carry). The boundary begins with no
    // owner at all, so nothing is pumped into the next cycle.
    this.#stages.release('exit');
    this.#stages.release('stage');
    this.#staging = null;
    this.#leaveRefused = false;
    this.#stageRefused = false;
    this.#leaveTravelFailures = 0;
    this.#pacer.reset();
    this.#lootTapAtMs = null;
    this.#lootTaps = 0;
    // A new cycle orients afresh: the climb budget is per cycle, and the next cycle may leave the
    // dungeon by the same measured stair the last one came up.
    this.#stages.release('orient');
    this.#orientRefused = false;
    this.#orientTravelFailures = 0;
    this.#orientClimbs = 0;
    this.#settleUntilMs = 0;
    this.#restGate = null;
    // The heal's counts are per cycle: a battle counted last cycle must not pay this cycle's debt.
    this.#healSchedule.resetCycle();
    this.#heal = null;
    this.#healWaitOn = null;
    // A fresh cycle asks the game again: the floor's chests may have been reset by the new visit.
    this.#chestProbe = null;
    this.#chestProbeDone = null;
  }

  /**
   * The cycle is over: count it, then either start the next one or complete the task. Called by the
   * exit stage's end (a task with no rest) and by the rest gate (the party slept and is back in town).
   */
  async #finishCycle(rested = false): Promise<void> {
    this.#cyclesDone += 1;
    const cycleStats = this.#stats.endCycle(this.#now());
    this.#host?.log.info(
      `wvd: cycle ${cycleStats.cycle} stats: chests ${formatSpan(cycleStats.chests)}; battles ${formatSpan(cycleStats.battles)}`,
    );
    if (this.#cyclesDone < Math.max(1, this.#cfg.cycles) && this.#task !== null) {
      this.#resetCycle();
      // The rest's own heal (healAfterRest) is for the **next** entry, so it is armed after the cycle
      // reset that cleared the counts: the visit the party just had is what earns it.
      if (rested) this.#healSchedule.rested();
      if (this.#task.orient !== undefined) {
        // A goal task orients back in; there is no entry script to run. The orientation claims the
        // loop (the cycle reset released every owner) and the pump point drives it from the next tick.
        const claimed = this.#stages.claim('orient', this.#now());
        if (!claimed.ok) this.#logOrientRefused(claimed.heldBy);
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
  }

  /**
   * The rest gate's tick (operator rule 2026-11-06). `true` means this tick spent the cycle's end,
   * so nothing else may act: the gate is the only thing left to decide.
   */
  async #advanceRestGate(observation: Observation, now: number): Promise<boolean> {
    const gate = this.#restGate;
    if (gate === null) return false;
    // A rest under way is a known pause, not a stall: the visit itself is progress.
    this.#lastProgressAtMs = now;
    // The inn's own screens are the plug-in's, and they are the visit: the gate only watches for it.
    if (observation.screen === 'inn' || observation.screen === 'inn-rest' || observation.screen === 'message') {
      gate.seenInn = true;
      return false;
    }
    if (gate.seenInn && observation.screen === 'town') {
      this.#restGate = null;
      this.#host?.log.info('wvd: the rest is over; the cycle ends here');
      await this.#finishCycle(true);
      return true;
    }
    if (now - gate.sinceMs >= gate.timeoutMs) {
      this.#restGate = null;
      this.#host?.log.warn(
        `wvd: the inn did not take the party within ${Math.round(gate.timeoutMs / 1000)} s; the cycle ends unrested`,
      );
      await this.#finishCycle(false);
      return true;
    }
    // Between the tap and the visit the gate owns the tick: the route must not aim at the town.
    return true;
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
   * The success line is the fit input for the carry prior (chest spec §3, task #18): the recorded
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
    // The spin guard: one bar may not eat the loop. A bar that resolves takes one pass; a reroll ends
    // the screen and clears this; only a bar that stays on screen reaches the cap.
    if (this.#qteTries >= QTE_MAX_TRIES_PER_BAR) {
      if (!this.#qteSpinWarned) {
        this.#qteSpinWarned = true;
        this.#host?.log.warn(
          `wvd: the chest QTE has had ${this.#qteTries} passes on one bar; leaving it to the stall clock`,
        );
      }
      return;
    }
    this.#qteTries += 1;
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
        // The measured terms win over the config once this bar has produced them (operator rule
        // 2026-11-05): the last press's round trip is the input leg, its park's carry time the slide.
        // The config values are the prior for a bar's first press — and the plan always gets a slide
        // time now (there is no brake switch): measured, else the measured prior.
        latencyMs: this.#qteLatencyMs ?? cfg.qteLatencyMs,
        budgetMs: cfg.qteSubLoopMs,
        carryTauS: this.#qteCarryTauS ?? Math.max(0, cfg.qtePriorCarryTauS),
        // A prior is not a measurement: a bar faster than the corpus is pressed as a probe until this
        // run has measured a slide (operator, 2026-11-07).
        carryMeasured: this.#qteCarryTauS !== null,
        latencySpreadMs: QTE_LATENCY_SPREAD_MS,
        // The band is only as honest as the carry's source: the prior before this bar has a park,
        // the bar's own measured value after (operator rule 2026-11-05, calibrated 2026-11-06).
        carrySpreadPx: this.#qteCarryTauS === null ? QTE_CARRY_SPREAD_PX : QTE_MEASURED_CARRY_SPREAD_PX,
      });
    } catch (error) {
      this.#host?.log.warn(`wvd: the chest QTE could not be timed: ${message(error)}`);
      return;
    }
    // A stop can land inside the sub-loop. Nothing is acted on — or reported as this session's —
    // after it, exactly as the tick itself re-checks after every await.
    if (!this.#running || this.#session !== session) return;
    if (!outcome.ok && outcome.reason === 'no-reachable-zone' && this.#qteRerolls < Math.max(0, cfg.maxRerolls)) {
      // The pass produced no plan the stop band accepted, so this bar cannot be pressed within the
      // operator's 95 % rule (2026-11-06: the hard 150 ms window floor is gone — the band is the one
      // "can this pass succeed" test). Cancel the bar and let the panel pick an opener again: a
      // cancellation costs no attempt (chest §4), and a new bar may be slower.
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
          + (cancelled.ok ? 'the band refused the pass, the bar was left' : `the bar could not be left (${cancelled.reason})`),
      );
      return;
    }
    if (outcome.ok) {
      // Feed the bar's measured terms back: the park's carry for the next plan, the press's round
      // trip as the input leg. Only a settled park yields a carry; an unsettled one leaves the
      // previous sample (or the prior) in place.
      if (outcome.tauS !== null) this.#qteCarryTauS = outcome.tauS;
      const roundTripMs = outcome.ackAtMs - outcome.pressAtMs;
      if (Number.isFinite(roundTripMs) && roundTripMs > 0) this.#qteLatencyMs = roundTripMs;
    }
    if (!outcome.ok && outcome.reason === 'no-reachable-zone') {
      // The reroll budget is spent and the band still refuses: the bar is left to the stall clock
      // (the last-attempt landing press has already had its chance inside the sub-loop).
      this.#host?.log.warn(
        `wvd: chest QTE given up after ${this.#qteRerolls} rerolls: no pass fit a zone to 95 %`,
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
    // The measured timing rides the same line (operator rule 2026-11-05): the actual delay, the
    // press's round trip and the child's own leg, and the carry time the park yields — the three
    // terms the band model needs, none of them inferred.
    const roundTripMs = outcome.ackAtMs - outcome.pressAtMs;
    this.#host?.log.info(
      `wvd: chest QTE pressed: v=${outcome.v} delayMs=${outcome.atMs} target=${outcome.target} `
        + `tapX=${outcome.tapX} restX=${outcome.restX === null ? 'unread' : outcome.restX} `
        + `settled=${outcome.restSettled} delayActualMs=${Math.round(outcome.delayActualMs)} `
        + `roundTripMs=${Math.round(roundTripMs)} inputMs=${outcome.inputMs === null ? 'none' : Math.round(outcome.inputMs)} `
        + `tau=${outcome.tauS === null ? 'unmeasured' : outcome.tauS.toFixed(4)}s`
        // The probe is named where it is spent: a fast bar's pass bought the slide at that speed.
        + (outcome.probe === true ? ' probe' : ''),
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
        // The route names a grid cell and nothing else: the pixel is read at tap time, from a frame
        // captured then, by the binding in the composition root. Converting it here — from the frame
        // the decision came from — is what aimed two reachable chests three cells off (2026-11-06).
        // The walk is a direct operation like every other: the pacer decides when it may be sent,
        // and the pointer mode it starts from is state the World keeps (R is a toggle).
        if (!this.#pacer.ready(this.#now())) return;
        this.#pacer.act(this.#now());
        const walked = await this.#press(
          'move',
          fromScreen,
          () => this.#commands.automoveToTile(intent.target, this.#pointerMode),
          intent.target,
        );
        // A walk that was sent has the map in pointer mode: it pressed R, or was told it was on.
        // A refused walk leaves the state as it was.
        if (walked !== null && walked.ok) this.#pointerMode = true;
        return;
      }
      case 'exit':
        if (fromScreen !== 'dungeonmap') {
          // F on the 3D view is 調査: walking to the exit needs the map, so the recovery is to open
          // it and let the next tick press F from the only screen where it is 移動至出口. A screen
          // whose own recovery is a step is the exception, and it is the fallback's answer: the town
          // page's world map is behind its party panel, so a map key pressed there is the loop lost
          // on a screen the exit cannot reach (operator, 2026-11-07).
          const seen = context?.observation;
          const answer = seen === undefined ? null : fallbackFor(seen);
          if (answer !== null && answer.kind === 'recover') {
            await this.#execute(answer, fromScreen, context);
            return;
          }
          this.#host?.log.info(`wvd: exit needs the map (screen is ${fromScreen ?? 'unknown'}); opening it first`);
          await this.#press('open-map', fromScreen, () => this.#commands.openMap());
          return;
        }
        await this.#press('exit', fromScreen, () => this.#commands.automoveToExit());
        return;
      case 'recover': {
        // One step of the recovery policy (policy/recover.ts). It is the loop's fallback for a screen
        // it is lost on, and the close of a named page: one press, paced like every other direct
        // operation, on a frame that has stopped moving (operator rule 2026-11-03).
        const step = intent.step;
        if (step.kind === 'done') {
          // `fallbackFor` never hands one over — a screen the route can act on keeps the loop's own
          // fallback (a wait when the route is working it) — so this is the guard that keeps a future
          // caller honest, not a press.
          this.#host?.log.info(`wvd: recovery: no step to press (${step.why})`);
          return;
        }
        const pressedAt = this.#now();
        if (!this.#pacer.ready(pressedAt)) return;
        // Bounded per screen (and per page): a screen that does not leave after a few steps is the
        // stall clock's, never a ten-taps-a-second loop on one frame.
        const epoch = `${fromScreen ?? 'none'}:${step.kind === 'exit-page' ? step.page : ''}`;
        if (this.#recoverEpoch !== epoch) {
          this.#recoverEpoch = epoch;
          this.#recoverSteps = 0;
          this.#recoverCapped = false;
        }
        if (this.#recoverSteps >= RECOVER_STEP_CAP) {
          if (!this.#recoverCapped) {
            this.#recoverCapped = true;
            this.#host?.log.warn(`wvd: the screen did not recover after ${RECOVER_STEP_CAP} steps; leaving it to the stall clock`);
          }
          return;
        }
        if (this.#cfg.dryRun) {
          this.#host?.log.info('wvd: dry run, would take the recovery step');
          return;
        }
        this.#recoverSteps += 1;
        this.#pacer.act(pressedAt);
        if (step.kind === 'exit-page') {
          // The page's title is the frame's, when this is the page the World read: the log names the
          // page the operator sees, not the catalog id.
          const name = context?.observation?.screen === 'ui-menu' ? context.observation.title : step.page;
          const tapped = await this.#commands.tapPoint(step.at);
          if (tapped.ok) {
            this.#host?.log.info(`wvd: ${name}: leaving by ${step.label} at ${step.at.x},${step.at.y}`);
          } else {
            this.#host?.log.warn(`wvd: the ${name} exit was refused (${tapped.reason})`);
          }
          return;
        }
        if (step.kind === 'collapse-party-panel') {
          const tapped = await this.#commands.tapPoint(step.at);
          if (tapped.ok) {
            this.#host?.log.info(
              `wvd: recovery: collapsing the party panel to reveal the world map at ${step.at.x},${step.at.y}`,
            );
          } else {
            this.#host?.log.warn(`wvd: the party-panel collapse was refused (${tapped.reason})`);
          }
          return;
        }
        // `back`: one Esc through the key primitive every other press takes. The engine refuses a
        // press while the game window does not hold the foreground (§4), so it cannot land in the
        // operator's own work.
        const session = context?.session;
        if (session === undefined) {
          this.#host?.log.warn('wvd: recovery: no session to press Esc in');
          return;
        }
        this.#host?.log.info('wvd: recovery: the screen has no name; pressing Esc once');
        // The probe owes an answer: the screen that appears next is what the unnamed frame was.
        this.#backProbeAtMs = this.#now();
        const pressed = await session.actuator.holdKey(ESC_SCAN, this.#cfg.pressHoldMs);
        if (!pressed.ok) this.#host?.log.warn(`wvd: the Esc press was refused (${pressed.reason})`);
        return;
      }
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
          this.#markFailed('open-chest');
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
        const seen = context?.observation;
        // The drop's own name, when the reader recorded its caption: it is the run's record of what was
        // claimed (operator, 2026-11-06), and nothing is decided from it.
        const item = seen?.screen === 'drop-item-claim' ? seen.item : undefined;
        const named = item === undefined ? '' : ` (${item})`;
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
          // The card is gone and the result banner is up: the claim resolves on the banner's own
          // line (operator rule 2026-11-06: a tap anywhere on the reward claims it, the bottom
          // controls — AUTO and the rest — do not). One tap, once per screen.
          if (this.#lootDismissed) {
            this.#host?.log.warn('wvd: the loot screen did not leave after the configured taps');
            return;
          }
          this.#lootDismissed = true;
          this.#lootTapAtMs = tappedAt;
          this.#pacer.act(tappedAt);
          const dismissed = await this.#commands.dismissLoot();
          if (!dismissed.ok) this.#host?.log.warn(`wvd: could not dismiss the loot banner (${dismissed.reason})`);
          else this.#host?.log.info(`wvd: dismissed the loot result banner${named}`);
          return;
        }
        this.#lootTapAtMs = tappedAt;
        this.#lootTaps += 1;
        this.#pacer.act(tappedAt);
        const tapped = await this.#commands.tapLoot();
        if (!tapped.ok) this.#host?.log.warn(`wvd: could not collect the loot (${tapped.reason})`);
        else this.#host?.log.info(`wvd: collected the loot card${named}`);
        return;
      }
      case 'fight': {
        // Operator rule 2026-11-04: a battle is turn-based, so the loop's operations are a **sequence**
        // (policy/battle-sequence.ts) — one tap per tick, in order, on a settled frame, paced from the
        // previous tap's return. The battle's order is speed → opener slot → opener confirm → auto.
        const sequence = this.#battleSequence;
        const seen = context?.observation;
        // The sequence owns the **battle**, not one screen. The skill panel a slot tap opens is an
        // unnamed frame inside the battle mode, and its 确定 must still be pressed (operator,
        // 2026-11-07). The panel covers the toggles, so a frame that is not `combat` hands the
        // sequence no evidence about them — and the confirm step does not need any.
        if (sequence === null || seen === undefined) return;
        // Act on a combat frame, or on the unnamed/loading frames *inside* the battle (the skill panel,
        // a resolution). A **named** screen that is not combat means the battle is over — the mode
        // holds it a beat longer, and pressing a battle toggle into that beat lands on whatever the
        // game put there (live 2026-11-07 01:36: the 自動 press opened 每日任务).
        const inBattle = seen.screen === 'combat'
          // The skill panel is the battle's own page: the 確定 it owes is pressed from it.
          || seen.screen === 'skill-panel'
          || ((seen.screen === 'unknown' || seen.screen === 'loading') && this.#mode.mode === 'battle');
        if (!inBattle) return;
        const now = context?.now ?? this.#now();
        // The turn card is read only while the opener is undecided: it says whether there is a cast at
        // all, and the skill panel dims it, so the read belongs to the command phase.
        // A blank frame (the game's own load) is not a battle frame: the sequence's clocks do not run
        // on it (operator, 2026-11-08: *only start counting when you see an actual battle frame*).
        const blank = seen.screen === 'loading';
        const phase = seen.screen === 'combat'
          ? { speedOn: seen.speedOn ?? null, autoOn: seen.autoOn ?? null, activeMember: null as string | null, blank }
          : { speedOn: null, autoOn: null, activeMember: null as string | null, blank };
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
            // The press is **located on this frame**, never a constant (operator, 2026-11-07: *read the
            // panel and tap the confirmation once you see it*). The panel moves between draws, so a
            // fixed point lands on the panel's body — measured live twice: y 975–1035 on 2026-11-05 and
            // y 976–1037 on 2026-11-07, where (1053,1005) pressed nothing for 48 s. A panel that is not
            // on the frame is not pressed: the confirm stays owed and the next paced tick looks again.
            const at = this.#battle === undefined || context === undefined
              ? null
              : await this.#battle.locateConfirm(context.frame);
            if (at === null) {
              if (!this.#battlePanelWarned) {
                this.#battlePanelWarned = true;
                this.#host?.log.info('wvd: the skill panel is not on this frame yet; the confirm stays owed');
              }
              return;
            }
            const pressed = await send(`${step.opener.name}'s opener confirm`, this.#commands.battleConfirm(at));
            if (pressed.ok) {
              // Said out loud because its absence was unreadable in a live log: a cast whose panel never
              // resolved looked exactly like a cast with no confirmation step at all (2026-11-07 22:00).
              this.#host?.log.info(
                `wvd: pressed the skill panel's 確定 at ${at.x},${at.y} for ${step.opener.name}'s opener`,
              );
            }
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
        const now = context?.now ?? this.#now();
        // The exit as a goal (contracts §10, 2026-11-09): no cursor, no step — the frame and the floor
        // decide (policy/leave.ts). This is the **start** only: the claim is the ownership, and the
        // pump point drives it every tick from here on, because the route does not return this intent
        // on the screens the exit walks (the harken page says `wait`). `#staging` is not set for the
        // leave path: it has no cursor to keep.
        if (task.leave !== undefined && intent.name === 'exit') {
          const claimed = this.#stages.claim('exit', now);
          if (!claimed.ok) {
            this.#logLeaveRefused(claimed.heldBy);
            return;
          }
          this.#leaveRefused = false;
          if (context === undefined) return;
          await this.#pumpLeave(context);
          return;
        }
        // A stage is one step per tick (operator rule 2026-11-05): the loop hands it the frame it just
        // observed and keeps its own tick, so a battle, the chest after it, or the death scene is
        // dispatched by the loop and the stage resumes from its cursor. The script id is
        // `#staging`; its ownership is the arbiter's `stage` claim.
        const claimed = this.#stages.claim('stage', now);
        if (!claimed.ok) {
          if (!this.#stageRefused) {
            this.#stageRefused = true;
            this.#host?.log.warn(
              `wvd: the ${intent.name} stage asked for the loop while ${claimed.heldBy} owns it`,
            );
          }
          return;
        }
        this.#stageRefused = false;
        this.#staging = intent.name;
        await this.#pumpScript(context ?? null);
        return;
      }
      case 'stop':
        await this.#endSession(intent.reason, { report: true });
        return;
      default:
        return assertNever(intent);
    }
  }

  // --- the arbiter: the loop's stages ---------------------------------------------------------

  /**
   * The **one pump point** (operator rule 2026-11-09): the stage that owns the loop is given this
   * tick. `false` means the owner yielded the frame back to the farm route — a chest, a fight, the
   * loot card — and the tick goes on to the route below.
   *
   * One of the three owns the loop at a time (`exit` → `stage` → `orient`), and never an intent:
   * a stage driven by the route is a stage the route can strand (live run 7: the leave owned the
   * harken page, where the route says `wait`, and nothing pumped it for 150 s).
   */
  async #pumpOwner(context: TickContext): Promise<boolean> {
    const owner = this.#stages.owner;
    if (owner === null) return false;
    switch (owner.name) {
      case 'exit': return this.#pumpLeave(context);
      case 'stage': return this.#pumpScript(context);
      case 'orient': return this.#pumpOrient(context);
      default: return assertNever(owner.name);
    }
  }

  /** One tick of the leave goal: the arbiter's `exit` owner (see `#leaveStep`). */
  async #pumpLeave(context: TickContext): Promise<boolean> {
    this.#stages.pump('exit', context.now);
    const task = this.#task;
    if (task === null || task.leave === undefined) {
      // Nothing can be judged any more: the ownership goes with the task it belonged to.
      this.#stages.release('exit');
      return true;
    }
    return this.#leaveStep(task.leave, context);
  }

  /**
   * One tick of the scripted stage (operator rule 2026-11-05: one step per tick). The arbiter's
   * `stage` owner; a null context is the blocking form (a caller with no frame).
   */
  async #pumpScript(context: TickContext | null): Promise<boolean> {
    const now = context?.now ?? this.#now();
    this.#stages.pump('stage', now);
    const task = this.#task;
    const name = this.#staging;
    if (task === null || name === null) {
      this.#stages.release('stage');
      this.#staging = null;
      return true;
    }
    const result = context === null
      ? await task.runScript(name)                 // no frame: the script runs blocking
      : await task.runScript(name, context.observation);
    if (!this.#running) return true;
    if (!result.ok && result.reason === 'interrupted') {
      // A screen the loop owns appeared mid-stage. The cursor is kept; the next tick dispatches by
      // screen, and the stage resumes once the screen is the stage's again.
      return true;
    }
    if (!result.ok) {
      this.#stages.release('stage');
      this.#staging = null;
      await this.#endSession(
        result.reason === 'cancelled'
          ? 'the session was stopped while the task exit ran'
          : `the task ${name} stopped at step ${result.step}: ${result.reason}`,
        { report: true, failed: result.reason !== 'cancelled' },
      );
      return true;
    }
    // The stage's own screens and presses are progress the loop could not see while it ran — and the
    // mark is the clock **after** the script ran, not the tick's start: a whole exit can spend 49 s
    // inside this one call (measured 2026-11-05), and a mark at the tick's start left the loop looking
    // stalled by the script's own duration on the very next tick. The mark is also set on **partial**
    // progress, where the base marked only a finished script: harmless (the cursor is kept), and it
    // keeps a many-step stage's ticks alive.
    this.#lastProgressAtMs = this.#now();
    if (result.complete === false) return true;      // partial progress: the stage has more steps
    this.#stages.release('stage');
    this.#staging = null;
    if (name !== 'exit') return true;
    // The cycle ends where it began: asleep at the inn (operator rule 2026-11-06). The same gate
    // closes a scripted exit and a leave goal, so the two cannot drift.
    await this.#beginRestGate();
    return true;
  }

  /**
   * One tick of the orientation: the arbiter's `orient` owner (contracts §10, the goal form). It
   * sends at most one command and lets the next frame answer it; `arrived` and `yield` hand the tick
   * to the farm route below (the route answers the same frame), and `wait`/a command spend it.
   *
   * The battle gate is the frame's, not the recogniser's: the skill panel a cast opens reads
   * `unknown`, and an owner that waits on it strands the owed confirm (live 2026-11-07 22:13).
   */
  async #pumpOrient({ session, frame, observation, now }: TickContext): Promise<boolean> {
    this.#stages.pump('orient', now);
    if (this.#mode.mode === 'battle') return false;
    const orient = this.#task?.orient;
    if (orient === undefined) {
      this.#stages.release('orient');
      return false;
    }
    const decision = nextOrientStep(observation, orient);
    switch (decision.kind) {
      case 'arrived':
        this.#stages.release('orient');
        this.#orientRefused = false;
        // The cycle's entry is an event the operator's matrix may heal on (healOnEntry).
        this.#healSchedule.enteredFloor();
        this.#host?.log.info(`wvd: on the farm floor (${orient.floor}); the farm takes over`);
        // Arrival is the hand-over: the farm route answers this same frame.
        return false;
      case 'yield':
        return false;
      case 'wait': {
        if (decision.reason !== 'map-icon') return true;
        this.#mapIconWaits += 1;
        if (this.#mapIconWaits <= ORIENT_MAP_ICON_PATIENCE) return true;
        const icons = observation.screen === 'dungeonmap'
          ? observation.map.icons.map((icon) => icon.kind).join(', ') || 'none'
          : 'not the map';
        await this.#stopWithEvidence(
          session,
          frame,
          `the map carries no 楼梯-门 icon after ${ORIENT_MAP_ICON_PATIENCE} reads (icons: ${icons})`,
        );
        return true;
      }
      case 'stop':
        await this.#stopWithEvidence(session, frame, decision.reason);
        return true;
      case 'command':
        this.#mapIconWaits = 0;
        await this.#orientTo(decision.command, observation.screen);
        return true;
      default:
        return assertNever(decision);
    }
  }

  /**
   * Release an owner that has held the loop past its own bound, and say so once (the bound is each
   * stage's own: see the constants). This is what keeps a stuck stage a release instead of a session
   * stop — the exit's bound sits below the shipped 120 s stall clock on purpose.
   */
  #releaseOverdueStage(now: number): void {
    const owner = this.#stages.owner;
    if (owner === null) return;
    const deadlineMs = owner.name === 'exit'
      ? LEAVE_DEADLINE_MS
      : owner.name === 'stage' ? SCRIPT_DEADLINE_MS : ORIENT_DEADLINE_MS;
    if (!this.#stages.overdue(now, deadlineMs)) return;
    if (!this.#stages.release(owner.name)) return;
    if (owner.name === 'stage') this.#staging = null;
    // A released owner's refusal is a new episode's to say again.
    if (owner.name === 'exit') this.#leaveRefused = false;
    else if (owner.name === 'stage') this.#stageRefused = false;
    else this.#orientRefused = false;
    const what = owner.name === 'exit'
      ? 'the exit'
      : owner.name === 'stage' ? 'the scripted stage' : 'the orientation';
    this.#host?.log.warn(
      `wvd: ${what} held the loop for ${Math.round(deadlineMs / 1000)} s; releasing it`,
    );
  }

  /** Said once per orientation episode: the orientation asked for the loop and another stage held it. */
  #logOrientRefused(heldBy: StageName): void {
    if (this.#orientRefused) return;
    this.#orientRefused = true;
    this.#host?.log.info(`wvd: the orientation asked for the loop while ${heldBy} owns it`);
  }

  /** Said once per leave episode: the exit asked for the loop and another stage held it. */
  #logLeaveRefused(heldBy: StageName): void {
    if (this.#leaveRefused) return;
    this.#leaveRefused = true;
    this.#host?.log.info(`wvd: the exit asked for the loop while ${heldBy} owns it`);
  }

  /**
   * The facts one frame offers the heal episode (policy/heal-session.ts). Every fact is local to the
   * material the episode acts on: the page and its matched X point, the dialog and its matched 恢复
   * point, a result box, the settled farm view, and the game's own screens (the only suspension:
   * battle, QTE, death, and the chest flow the route then finishes).
   */
  #healFacts(observation: Observation): HealFacts {
    const page = observation.screen === 'character-page';
    const dialog = observation.screen === 'quick-heal';
    const message = observation.screen === 'message';
    return {
      settled: this.#mode.mode === 'dungeon' && observation.screen === 'dungeon' && this.#stableCount >= 3,
      page: page && this.#stableCount >= 2,
      pageAt: page ? observation.at : null,
      dialog: dialog && this.#stableCount >= 2,
      dialogAt: dialog ? observation.at : null,
      dialogCancelAt: dialog ? observation.cancel : null,
      message,
      messageAt: message ? observation.at : null,
      pageGone: (observation.screen === 'dungeon' || observation.screen === 'dungeonmap') && this.#stableCount >= 2,
      // The game's modal screens, and the chest flow — the farm's own work, exactly like a battle.
      // Not suspended on the chest's approach and opening, the episode held the tick while the party
      // stood at a chest: the 打开 prompt was never accepted and the heal spent its 90 s deadline on a
      // screen the route owns (live 2026-11-09 08:36:50-08:38:21, then the farm stalled at chest-prompt).
      suspended: observation.screen === 'combat' || observation.screen === 'chest-qte'
        || observation.screen === 'revive-qte' || observation.screen === 'main-character-dead'
        || observation.screen === 'chest-prompt' || observation.screen === 'chest-open'
        || observation.screen === 'chest-opening' || observation.screen === 'drop-item-claim',
    };
  }

  /**
   * One command of the orientation (contracts §10, the goal form). It sends exactly one thing and
   * lets the next tick's frame answer it, except the two long jobs — the world-map travel and the
   * climb script — which are whole procedures with their own settle and their own retry budget.
   *
   * The two presses go through `#press` so they share the loop's in-flight rules: a map that never
   * opens is not pressed twice, and a walk is waited out by arrival like any other.
   */
  /**
   * One tick of the leave goal (contracts §10, 2026-11-09): ask the frame what this floor allows and
   * send that one command. There is **no cursor** — so an interrupted leave resumes on whatever
   * screen and floor the game is actually on, which is the defect this replaces.
   *
   * `true` spends the tick; `false` is a **yield** — the frame is a screen the route owns (a chest, a
   * fight, the loot card), so the tick goes on to it and the leave asks again from the next frame.
   */
  async #leaveStep(route: TaskLeaveRoute, context: TickContext): Promise<boolean> {
    const { observation } = context;
    // The last reachable-chest check (operator, 2026-11-09): before the leave presses F on the farm
    // floor, ask the game itself with E (移动至宝箱) when the map draws no chest. A chest answer is the
    // farm continuing; the probe's own tick check (above) owns the wait.
    if (this.#chestProbe !== null) return true;
    const probe = nextChestProbe(observation, {
      probe: null,
      done: this.#chestProbeDone,
      farmFloor: route.farmFloor,
      chestsShown: this.#lastMapRead?.chests.length ?? 0,
    }, this.#now());
    if (probe.kind === 'start' && observation.screen === 'dungeonmap') {
      const at = this.#now();
      if (!this.#pacer.ready(at)) return true;
      this.#pacer.act(at);
      const sent = await this.#press('exit', observation.screen, () => this.#commands.automoveToChest());
      if (sent !== null && sent.ok) {
        this.#chestProbe = { floor: observation.map.titleKey, atMs: at };
        this.#host?.log.info('wvd: the map shows no chest; asking the game with E (移动至宝箱) before the exit');
      } else if (sent !== null) {
        this.#chestProbeDone = observation.map.titleKey;
        this.#host?.log.warn(`wvd: the E check could not be pressed (${sent.reason}); the exit proceeds`);
      }
      return true;
    }
    const decision = nextLeaveStep(observation, {
      to: route.to,
      farmFloor: route.farmFloor,
      knownFloors: route.knownFloors,
      floor: this.#lastMapRead?.floor ?? null,
    });
    switch (decision.kind) {
      case 'arrived':
        // The exit is over: the claim goes with the episode, and the rest gate owns the cycle's end.
        this.#stages.release('exit');
        this.#leaveRefused = false;
        this.#lastProgressAtMs = this.#now();
        this.#host?.log.info('wvd: the leave arrived in the town');
        await this.#beginRestGate();
        return true;
      case 'yield':
        // A screen the loop's own branches or the route own (a chest, a fight, a loot card, a page,
        // the heal): press nothing and let the tick go on to the route, which finishes it.
        return false;
      case 'wait':
        return true;
      case 'stop':
        this.#stages.release('exit');
        this.#leaveRefused = false;
        await this.#stopWithEvidence(context.session, context.frame, decision.reason);
        return true;
      case 'command':
        await this.#leaveCommand(decision.command, observation.screen);
        return true;
      default:
        return assertNever(decision);
    }
  }

  /** Send the one command the leave's frame allowed. */
  async #leaveCommand(command: LeaveCommand, fromScreen: ScreenId): Promise<void> {
    const now = this.#now();
    switch (command.kind) {
      case 'open-map':
      case 'exit': {
        // A command that already changed nothing on this screen is not re-sent: the stall clock is
        // what escalates it, exactly as on the farm path.
        if (this.#failed.has(command.kind)) {
          this.#host?.log.warn(`wvd: leaving: ${command.kind} already changed nothing here; not sending it again`);
          return;
        }
        this.#lastProgressAtMs = now;
        this.#host?.log.info(command.kind === 'open-map'
          ? 'wvd: leaving: opening the map to read this floor'
          : 'wvd: leaving: walking to this floor exit with F');
        const send = command.kind === 'open-map'
          ? () => this.#commands.openMap()
          : () => this.#commands.automoveToExit();
        await this.#press(command.kind, fromScreen, send);
        return;
      }
      case 'tap-row': {
        if (!this.#pacer.ready(now)) return;
        this.#pacer.act(now);
        this.#lastProgressAtMs = now;
        const tapped = await this.#commands.tapPoint(command.at);
        if (tapped.ok) {
          this.#host?.log.info(`wvd: leaving: tapped the matched ${command.label} row at ${command.at.x},${command.at.y}`);
        } else {
          this.#host?.log.warn(`wvd: the ${command.label} row tap was refused (${tapped.reason})`);
        }
        return;
      }
      case 'back': {
        if (!this.#pacer.ready(now)) return;
        this.#pacer.act(now);
        this.#lastProgressAtMs = now;
        this.#host?.log.warn('wvd: leaving: backing out of the harken page (this floor may not take 归还)');
        await this.#commands.escape();
        return;
      }
      case 'travel': {
        if (this.#cfg.dryRun) {
          this.#host?.log.info(`wvd: dry run, would travel to ${command.to}`);
          return;
        }
        // The exit already owns the loop; travelling is one of its commands, not a second claim.
        this.#orientAbort ??= new AbortController();
        this.#host?.log.info(`wvd: leaving: travelling to ${command.to}`);
        const result = await this.#commands.travel(command.to, this.#orientAbort.signal);
        if (!this.#running) return;
        if (result.ok) {
          this.#leaveTravelFailures = 0;
          this.#lastProgressAtMs = this.#now();
          this.#settleUntilMs = this.#now() + ORIENT_SETTLE_MS;
          this.#settleFrom = this.#lastScreen;
          return;
        }
        this.#leaveTravelFailures += 1;
        const detail = result.detail === undefined ? '' : ` (${result.detail})`;
        if (this.#leaveTravelFailures >= ORIENT_TRAVEL_TRIES) {
          await this.#endSession(
            `the leave travel to ${command.to} failed ${this.#leaveTravelFailures} times: ${result.reason}${detail}`,
            { report: true, failed: true },
          );
          return;
        }
        this.#host?.log.warn(`wvd: the leave travel to ${command.to} failed (${result.reason}${detail}); trying once more`);
        return;
      }
      default:
        return assertNever(command);
    }
  }

  /**
   * The cycle ends where it began: asleep at the inn (operator rule 2026-11-06). The leave only
   * brings the party back to the town; the inn is one measured control from there and the visit is
   * the plug-in's. The cycle counts once the party is back on the town's own screen.
   */
  async #beginRestGate(): Promise<void> {
    const rest = this.#task?.rest;
    if (rest === undefined) {
      await this.#finishCycle();
      return;
    }
    this.#restGate = { sinceMs: this.#now(), timeoutMs: rest.timeoutMs, seenInn: false };
    this.#host?.log.info(`wvd: the cycle ends with a rest at the inn: tapping the town inn control at ${rest.at.x},${rest.at.y}`);
    const opened = await this.#commands.tapPoint(rest.at);
    if (!opened.ok) {
      this.#host?.log.warn(`wvd: the inn control tap was refused (${opened.reason})`);
    }
  }

  async #orientTo(command: OrientCommand, fromScreen: ScreenId): Promise<void> {
    // The orientation's commands are primitives like every other tap (operator rule 2026-11-03): one per
    // pace, on a frame that has stopped moving. Without this the loop pressed G twice a tick while the
    // map's own open was still animating (live 2026-11-03 21:49: thirty "changed nothing" warnings and
    // an escalation) — and a party heal is cancelled by the trip: the operator's rule is to heal after a
    // battle or a chest, never on the way through the dungeon.
    if (!this.#pacer.ready(this.#now())) return;
    this.#pacer.act(this.#now());
    // A command is the orientation's progress (arbiter rule 2026-11-09): the orientation's own
    // deadline is the backstop for turns that never arrive, so its commands must keep the stall
    // clock's account alive — otherwise a slow climb reads as a stall and the session stops.
    // The mark sits **below each guard, where the command actually leaves** (one per branch): a
    // branch that declines to send — the `open-map`/`exit` already marked failed — marks nothing,
    // so the stall clock is free to escalate it exactly as on the farm path, and the run stops at
    // the shipped stall stop instead of drifting on to this stage's own bound.
    // **Except in dry-run**: the `open-map`/`exit` and `stairs` marks sit above `#press`, whose
    // dry-run guard returns without sending, so a dry-run orientation refreshes the stall clock on
    // those two branches anyway. Parked deliberately: `dryRun` never sets `#failed`, and no test
    // covers a dry-run orientation (SDD ledger, Task 1 re-review).
    this.#healSchedule.cancel();
    switch (command.kind) {
      case 'open-map':
      case 'exit': {
        // A command that already changed nothing on this screen is not sent again: the stall clock
        // is what escalates it, exactly as on the farm path.
        if (this.#failed.has(command.kind)) {
          this.#host?.log.warn(`wvd: orienting: ${command.kind} already changed nothing here; not sending it again`);
          return;
        }
        this.#lastProgressAtMs = this.#now();
        const send = command.kind === 'open-map'
          ? () => this.#commands.openMap()
          : () => this.#commands.automoveToExit();
        await this.#press(command.kind, fromScreen, send);
        return;
      }
      case 'stairs': {
        // The 楼梯-门 icon the map reader named, as the **cell** it stands on. It is the same interaction
        // as a chest walk: the tap on the cell raises the 自動移動 prompt and tapping the prompt starts
        // the walk (live 2026-11-03 21:45: a bare tap raised the prompt and the screen never changed, so
        // the press looked ignored). The climb therefore goes through the farm's own automove, which
        // locates the cell on a fresh frame and taps that prompt.
        this.#lastProgressAtMs = this.#now();
        const climbed = await this.#press(
          'move',
          fromScreen,
          () => this.#commands.automoveToTile(command.at, this.#pointerMode),
        );
        if (climbed !== null && climbed.ok) this.#pointerMode = true;
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
        this.#lastProgressAtMs = this.#now();
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
        this.#lastProgressAtMs = this.#now();
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
  ): Promise<ActionResult | null> {
    if (this.#cfg.dryRun) {
      this.#host?.log.info(`wvd: dry run, would ${kind}`);
      return null;
    }
    const result = await command();
    if (!result.ok) {
      // A walk the game refuses is a cell it has no path to — no 自動移動 element was raised
      // (measured 2026-11-02). Skip it and aim elsewhere; do not mark `move` failed, which is what
      // used to wedge the farm until the next advancement.
      if (kind === 'move' && target !== null) {
        if (result.reason === 'unavailable') {
          // A walk nobody could **aim** is no evidence about the cell at all (live 2026-11-06: a stale
          // map read aimed every tap three cells off, and two reachable chests were called unreachable
          // and skipped). Re-perceive and aim again instead of skipping the chest this cycle.
          this.#host?.log.warn(`wvd: the walk was not aimed: ${result.detail ?? 'the map could not be read'}`);
          return result;
        }
        if (result.reason === 'timeout' && this.#pointerMode === true) {
          // The tap raised no element while the World believed pointer mode was on: the game may drop
          // the mode between walks. That is evidence the belief is wrong, not that the cell has no path
          // — flip it and let the route ask once more, which presses R (live 2026-11-07: the chest at
          // 11,4 was skipped after one such miss).
          this.#pointerMode = false;
          this.#host?.log.info('wvd: the walk raised no 自動移動 element with pointer mode believed on; the next attempt presses R');
          return result;
        }
        const why = result.detail ?? result.reason;
        this.#skip(target, why);
        return result;
      }
      this.#markFailed(kind);
      this.#host?.log.warn(`wvd: could not ${kind}`, { reason: result.reason, detail: result.detail ?? null });
      return result;
    }
    if (fromScreen === null) return result;
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
    return result;
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
    // The run's own log, one line at the end (operator, 2026-11-07): the numbers the morning report
    // quotes, written by the loop rather than reconstructed from the frames afterwards.
    // A mount-and-stop host may carry no logger at all; the numbers are a courtesy to the morning
    // reader, never a precondition for stopping.
    this.#stats.finish(this.#now());
    const summary = this.#stats.summary();
    this.#host?.log?.info(
      `wvd: run stats: ${summary.cycles.length} cycles; chests ${formatSpan(summary.chests)}; battles ${formatSpan(summary.battles)}`,
    );
    const wasRunning = this.#running;
    // Stop a running script at its next step boundary before anything else is torn down: the task
    // must not keep pressing keys into a closed session.
    const task = this.#task;
    this.#task = null;
    this.#staging = null;
    task?.abort();
    // A stop that lands during the orientation's travel or climb must not keep pressing keys.
    this.#orientAbort?.abort();
    this.#orientAbort = null;
    // No owner outlives the session: the arbiter is the World's, and the next session starts clean.
    this.#stages.release('stage');
    this.#stages.release('exit');
    this.#stages.release('orient');
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
