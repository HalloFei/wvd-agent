/**
 * Mirror of `docs/specs/2026-10-24-contracts.md`, declaration for declaration. The spec is binding:
 * when one changes the other changes in the same commit, and nothing is added here that the spec
 * does not have. The independence rules in §0 govern every module that imports this file.
 *
 * This file declares; it implements nothing. `planTap` is implemented by
 * `src/policy/qte.ts` (contracts §7, §9).
 */

// §1 Frame and capture

export interface RgbaImage {
  readonly data: Uint8Array;   // RGBA, row-major, 4 bytes per pixel
  readonly width: number;
  readonly height: number;
}

/** A captured frame. The encoding is private to the FrameSource that produced it. */
export interface Frame {
  readonly atMs: number;                 // performance.now() at capture start, World domain
  readonly width: number;
  readonly height: number;               // device pixels of the game window
  toRgba(): Promise<RgbaImage>;          // decoding happens inside the source
}

export interface FrameSource {
  capture(): Promise<Frame>;
  /** A band of the next frame: `rect`'s own rectangle, in the frame's device pixels. Optional, so
   *  every existing realizer still conforms and the QTE sub-loop falls back to `capture()`. The
   *  returned Frame is the crop — its `width`/`height` are the rect's — and its `atMs` is stamped
   *  as `capture()` stamps one. */
  captureBand?(rect: PixelRect): Promise<Frame>;
}

// §2 Screens

/** `dungeon` is the 3D exploration view: party walking, HUD up, no map open. The route opens the map
 *  from it; it is distinct from `unknown` (a black or uniform frame has no HUD at all).
 *
 *  `unknown` has two strengths (§2): confidence 0 means nothing was drawn (a uniform or black
 *  frame), the only confidence that may end a session; a positive confidence below every act floor
 *  means something is drawn and no recogniser can name it, which escalates. */
export type ScreenId =
  | 'town' | 'worldmap' | 'dungeon' | 'dungeonmap' | 'combat'
  | 'chest-open' | 'chest-qte' | 'chest-opening' | 'drop-item-claim' | 'loading' | 'chest-prompt'
  | 'dungeon-select' | 'character-page' | 'main-character-dead' | 'revive-qte' | 'harken-menu'
  | 'inn' | 'message' | 'ui-menu' | 'unknown';

// §3 Perception

export interface Point { readonly x: number; readonly y: number }

/**
 * One icon drawn on the dungeon map, at its **grid cell**.
 *
 * Which markers cross a floor and which do not is the operator's account (2026-10-24), and it is the
 * distinction the route needs:
 * - **`harken`** — the white 4-point sparkle. The harken, and the point a party changes floor by.
 * - **`stairs`, `hole`** — the entries and exits: the staircase, and the down-arrow over an oval.
 *   No fixture carries the mirrored (`stair_down`) staircase, so no up/down direction is published.
 * - **`teleport`** — the orchid ring (the mobile art's `stair_teleport`). **Within one floor only**:
 *   it never crosses, so no route may use it to change floor.
 * - **`chest`, `hazard`** — the resource and the obstacle.
 *
 * The kind names the glyph; where a mechanic is asserted above it is the operator's, not the
 * picture's. Navigation design §6 records what is measured and what is not.
 */
export interface MapIcon {
  readonly kind: 'chest' | 'stairs' | 'stair-door' | 'hazard' | 'teleport' | 'hole' | 'harken';
  readonly at: Point;
}

export interface MapState {
  readonly floorTitle: string;          // the Latin token (`B1F`), or '' when the title is not Latin
  readonly titleKey: string;            // §3 R27a: the floor's 32-hex title fingerprint
  readonly player: Point;               // grid coordinates, e.g. {x:19,y:21}
  /** The party chevron's screen point, in the frame's own pixels: the origin of the map's grid.
   *  The canvas scrolls, so this is measured per frame; a consumer converts a grid target with
   *  `origin + ((x−player.x)·36, −(y−player.y)·36)` and nothing re-derives the canvas. */
  readonly origin: Point;
  readonly icons: readonly MapIcon[];
}

export interface QteZone { readonly from: number; readonly to: number }

export interface QteState {
  readonly zones: readonly QteZone[];
  readonly markerX: number;
  readonly button: Point;               // the 解除 control
  readonly attempts: number | null;
}

export interface OpenerMember {
  readonly name: string;
  readonly detect: number;              // 陷阱发现
  readonly disarm: number;              // 陷阱解除
  /**
   * 心, as the panel draws it. `null` is a card that draws **no heart at all** — the main character,
   * whose willpower the game does not display (operator rule 2026-10-31): there is no number to hold
   * against a floor, so an absent heart passes the opener's pick gate. A heart that *is* drawn but
   * cannot be read is `NaN`, and that member stays ineligible — the numeral might have been below
   * the floor. Nothing is ever substituted for either case.
   */
  readonly willpower: number | null;
  readonly feared: boolean;
}
export interface OpenerPanel { readonly members: readonly OpenerMember[] }

/** One answer, carrying the payload its screen type owns. */
export type Observation =
  | { readonly screen: 'dungeonmap'; readonly atMs: number; readonly confidence: number; readonly map: MapState }
  | { readonly screen: 'chest-qte'; readonly atMs: number; readonly confidence: number; readonly qte: QteState }
  | { readonly screen: 'chest-open'; readonly atMs: number; readonly confidence: number; readonly opener: OpenerPanel }
  | {
      readonly screen: 'harken-menu';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The menu's rows, top to bottom: where each label sits, and the label the measured library
       * knows (`null` for one it has never seen). The list is not fixed — a harken offers a floor only
       * once that floor's harken is reconstructed — so the climb decides from the rows, not a layout.
       */
      readonly rows: readonly { readonly at: Point; readonly label: string | null }[];
    }
  | {
      readonly screen: 'inn';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The inn dialog's rows, top to bottom: where each row sits, and the label the measured library
       * knows. Only named rows are reported — a row the loop cannot name is one it will not tap. The
       * room options are the screen's own evidence (operator rule 2026-11-06), so a dialog offering
       * room types the library has never seen is still the inn: the policy takes the first room it
       * does not know to be a non-room.
       */
      readonly rows: readonly { readonly at: Point; readonly label: string }[];
    }
  | {
      readonly screen: 'combat';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The battle's two toggles, read off their highlight on this frame: 倍速 (multi-speed) and 自動
       * (auto battle). Absent when the frame does not show the buttons (a caller's own observation, a
       * non-1920 frame). The loop's battle order is speed → opener → auto → finish, and each press is
       * sent only when the frame says its toggle is off (operator rule 2026-11-03): both are toggles,
       * so a blind re-press would turn one back off.
       */
      readonly speedOn?: boolean;
      readonly autoOn?: boolean;
    }
  | {
      readonly screen: 'drop-item-claim';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The drop's own name, when the caption under the reward matches a recorded drop
       * (`src/perception/drops.ts`). The game draws 获得了 <item>！！, and the operator's rule (2026-11-06)
       * is that a drop the World has not seen is named after that line and recorded, so the run's
       * record says what it claimed. Absent when the line has not been recorded yet: the screen is the
       * claim screen either way, which is what keeps an unfamiliar drop from stalling the farm.
       */
      readonly item?: string;
    }
  | {
      readonly screen: 'ui-menu';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * A page of the knowledge base (`src/ui/pages.ts`), matched by the title it draws. The World's
       * one job with it is the close: the payload carries the measured point, so the tick that reads
       * this observation sends exactly one command (operator rule 2026-11-06: a named page can always
       * be left). A page the catalog does not know stays `unknown` and escalates as before.
       */
      readonly page: string;
      /** The page's own title, for the log line and the escalation question. */
      readonly title: string;
      /** The catalog's exit row: the tap that returns to the page this one opened over. */
      readonly exit: Point;
    }
  | {
      readonly screen: 'message';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The game's one-off message box (operator, 2026-11-06): a centred dark panel with a caption line
       * and the yellow continue mark below it. The tap advances it.
       */
      readonly at: Point;
    }
  | {
      readonly screen: 'unknown';
      readonly atMs: number;
      readonly confidence: number;
      /**
       * The frame carries the dungeon's own corner evidence (the minimap arrow) although no recogniser
       * named it: the 3-D view with something drawn over it — a menu legend, a bright scene filling the
       * title band. The loop asks the game's own map about such a frame before it asks the model
       * (operator rule 2026-11-03).
       */
      readonly dungeonLike?: boolean;
    }
  | { readonly screen: Exclude<ScreenId, 'dungeonmap' | 'chest-qte' | 'chest-open' | 'combat' | 'harken-menu' | 'inn' | 'message' | 'ui-menu' | 'drop-item-claim' | 'unknown'>;
      readonly atMs: number; readonly confidence: number };

export interface Perceiver { observe(frame: Frame): Promise<Observation>; }

/**
 * One screen's standing on one frame (§2). `support` is the frame's cheap evidence for the screen,
 * 0 (none) to 1 (strongest measured) — ordinal, not a calibrated probability; `ruledOut` means the
 * frame's own evidence makes the screen impossible, whatever a recogniser says.
 */
export interface ScreenStanding {
  readonly screen: ScreenId;
  readonly support: number;
  readonly ruledOut: boolean;
}

/** Every screen's standing on one frame, and the answer those standings produced (§3). */
export interface Classification {
  readonly atMs: number;
  readonly standings: readonly ScreenStanding[];
  readonly answer: Observation;
}

export interface Classifier extends Perceiver {
  classify(frame: Frame): Promise<Classification>;
}

// §4 Actuation

export type ActionFailure = 'unavailable' | 'rejected' | 'timeout';

export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ActionFailure; readonly detail?: string };

export interface Actuator {
  tap(at: Point): Promise<ActionResult>;
  doubleTap(at: Point): Promise<ActionResult>;
  holdKey(scan: number, holdMs: number): Promise<ActionResult>;   // WASD escape
  /** Press at `from`, move on a straight line, release at `to`: the world map's pan. */
  drag(from: Point, to: Point, durationMs: number): Promise<ActionResult>;
}

/**
 * The hold ceiling the World enforces on every `holdKey`, and the grace the engine's teardown gives
 * a request in flight (§5) before it kills the child.
 *
 * They are one fact, not two: on Windows the kill is `TerminateProcess`, which skips the child's
 * `releaseHeld()`, so **a hold that outlived the teardown would leave a key down** — and a stuck key
 * is worse than a refused press (§4). The invariant is `MAX_PRESS_HOLD_MS < TEARDOWN_GRACE_MS`;
 * `tests/engine.test.ts` asserts it and that no kill lands inside a maximum-length hold. The grace
 * covers the worst queue the child can still be draining: the maximum hold plus the 500 ms a first
 * capture may wait for warm-up (§5), with margin.
 */
export const MAX_PRESS_HOLD_MS = 500;
/** The longest drag the World sends: the button is down for its whole duration (§4, §5). */
export const MAX_DRAG_MS = 500;
export const TEARDOWN_GRACE_MS = 1_200;

// §5 Engine protocol (World ↔ child)

/** A rectangle in the frame's own device pixels: the origin is the window's client top-left. A crop
 *  must lie inside the frame (`x + width <= frameWidth`, `y + height <= frameHeight`), and that fit
 *  is the child's check because the codec does not know the frame; the codec only requires a
 *  non-negative integer origin and a positive integer size. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The value of a successful `capture` reply. The child captures on its own cadence and serves its
 *  newest frame; `ageMs` is the duration from capture start to reply on the child's clock. */
export interface EngineCapture {
  readonly jpeg: string;   // base64, encoded in the child
  /** The size of the JPEG returned, not of the window: the frame's client size for a plain capture,
   *  and `crop.width`×`crop.height` for a cropped reply. */
  readonly width: number;
  readonly height: number;
  readonly ageMs: number;  // capture start → reply, on the child's clock
  /** The rectangle the child actually cropped, absent when it sent the whole frame. It is what lets
   *  the World detect a child that ignored the request and answered with the native frame: a caller
   *  that asked for a band must never parse a full frame as one. */
  readonly crop?: PixelRect;
}

export type EngineRequest =
  /** `maxWidth` asks for a downscaled JPEG (the escalation snapshot); absent means native size, which
   *  is what perception needs. `crop` asks for one rectangle of the frame, copied before the encode:
   *  a QTE sample is the bar's own rectangle, and cropping before the encode is what makes the sample
   *  cheap enough to take three times a pass. `crop` and `maxWidth` together is malformed, because
   *  they ask for different output sizes. */
  | { op: 'capture'; maxWidth?: number; crop?: PixelRect }
  | { op: 'foreground' }
  /** Restore and raise the game window, then report whether it holds the foreground. The child taps
   *  Alt first: Windows only lets the foreground process hand focus away (§4). */
  | { op: 'focus' }
  | { op: 'tap'; x: number; y: number; count: 1 | 2 }
  | { op: 'key'; scan: number; holdMs: number }
  /** A press at (x1,y1), a straight-line move, a release at (x2,y2); duration in ms. */
  | { op: 'drag'; x1: number; y1: number; x2: number; y2: number; durationMs: number };

export type EngineReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: ActionFailure; detail?: string };

// A successful `tap` or `key` reply's `value` is `{ inputMs: number }`: the duration from request
// receipt to the `SendInput` completing, on the child's clock. `doubleTap` is one request.
// Unsolicited child → World messages: an unregistered stop hotkey is
// `{ kind:'engineProblem', detail:'stop-hotkey-unregistered' }`; a JPEG encoder that fell back to
// `jpeg-js` is `detail:'native-encoder-unavailable'`, and a World-side decoder fallback reports the
// same way locally with `detail:'native-decoder-unavailable'`.
export type EngineEvent =
  | { kind: 'stopHotkey' }
  | { kind: 'engineProblem'; detail: string };

// §6 Policy

export type Intent =
  | { kind: 'open-map' }
  | { kind: 'move'; target: Point }
  | { kind: 'open-chest' }
  | { kind: 'loot' }
  | { kind: 'fight' }
  | { kind: 'exit' }
  | { kind: 'run-script'; name: ScriptId }
  | { kind: 'wait'; ms: number }
  | { kind: 'stop'; reason: string };

/**
 * The game's mode: which pipeline owns the screen, held between frames (operator rule 2026-11-03).
 *
 * `battle` and `chest` are modal — they own the screen until their named end, and hold through the
 * unnamed frames inside them (a skill's resolution, the revive QTE, a QTE bar's fade). `dungeon` is the
 * 3-D view and its map, `travel` the world map and Dungeon Select, `town` the rest town. `unknown`
 * is the mode nothing has named yet: the only one where an unnamed frame is the loop's own problem.
 */
export type GameMode = 'unknown' | 'battle' | 'chest' | 'dungeon' | 'travel' | 'town';

export interface RouteState {
  readonly observation: Observation;
  /** Which pipeline owns this screen; the World dispatches by it (contracts §6, `policy/mode.ts`). */
  readonly mode: GameMode;
  readonly willpower: readonly number[];
  readonly chestsRemaining: number;
  /**
   * The cells whose walk the farm gave up on this cycle: the tap raised no 自动移動 element and the
   * party did not move, so the game has no path there. The route never aims at one again, and a map
   * whose chests are all here is done — the next stage is the exit (rest, then a fresh cycle).
   */
  readonly unreachable: readonly Point[];
}

export interface FarmPolicy { next(state: RouteState): Intent; }

export type SessionVerdict = 'ok' | 'escalate' | 'stop';

// §10 Farm tasks

/**
 * A script a task file can name. `enter` runs at session start (a scripted task only); `exit` when
 * the policy says leave; `climb` when the orientation finds the party on the stair floor.
 */
export type ScriptId = 'enter' | 'exit' | 'climb';

export type TaskKeyName = 'g' | 'l' | 'q' | 'f' | 'r' | 'tab' | 'esc' | 'space';

export interface TaskStep {
  /**
   * `harken` reads the harken's floor menu (contracts §2 `harken-menu`) and taps one row: the
   * `destination` row when the menu offers it (the teleport), else `归还` (the party backs out and the
   * stair icon is the way up). A perceptual step, not a measured tile — the operator's rule 2026-11-03:
   * the list is not fixed, so the script reads it.
   */
  readonly op: 'tap' | 'key' | 'wait' | 'expect' | 'expectFloor' | 'travel' | 'harken';
  /** `harken` only: the row's label, as the menu draws it (第一区-城外- etc.). */
  readonly destination?: string;
  readonly at?: readonly [number, number];
  readonly count?: 1 | 2;
  readonly key?: TaskKeyName;
  readonly holdMs?: number;
  readonly ms?: number;
  /** The destination id a `travel` step names; validated against the catalog at load. */
  readonly to?: string;
  readonly screen?: ScreenId;
  /** `expectFloor` only: the 32-hex floor key to gate; the task's own key when absent. */
  readonly titleKey?: string;
  readonly timeoutMs?: number;
}

export interface TaskScript { readonly timeoutMs: number; readonly steps: readonly TaskStep[] }

/**
 * Where a farm lives, and the one measured detour on the way (contracts §10).
 *
 * A goal task does not say how to drive the game from a known starting screen: it says where the
 * farm is, and the World orients toward it from whatever screen the party is on. `site` is the
 * world-map node, `zone` the Dungeon Select row that opens one of its zones.
 */
export interface TaskGoal {
  readonly site: string;
  readonly zone?: string;
  /**
   * The floor whose map carries the measured stair-up. A party already on that floor runs the climb
   * script; the World never presses a blind tile from another floor.
   */
  readonly climb?: TaskClimb;
}

export interface TaskClimb {
  /** The 32-hex floor key the climb script's own `expectFloor` falls back to. */
  readonly from: string;
  readonly script: TaskScript;
  /**
   * The harken menu's row for the farm's floor, as the menu draws it (`harken-menu` rows, contracts
   * §2). A harken offers a floor only once that floor's harken is reconstructed (operator rule
   * 2026-11-03), so the World reads the menu: the named row is tapped when it is offered; when it is
   * not, the `归还` row backs the party out and the stair icon is the way up.
   */
  readonly destination?: string;
}

/**
 * The cycle's rest (operator rule 2026-11-06): a cycle ends where it began — asleep at the inn.
 *
 * `at` is the rest town's **inn control** on the town view, measured 2026-11-06 at 1920×1080: one
 * tap opens the innkeeper's dialog, and from there the inn plug-in rests the party (its rows are
 * the dialogue's own evidence). `timeoutMs` bounds the visit: the whole thing — the three dialogs,
 * the rest scene, the after-rest box and the way out — measured 23 s, and a visit that has not
 * taken the party by then is given up on so an unattended run cannot wedge on one missed tap.
 */
export interface TaskRest {
  readonly at: Point;
  readonly timeoutMs: number;
}

export interface TaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly floor: { readonly titleKey: string };
  /** A scripted entry, for a task that drives itself from a known screen. Absent for a goal task. */
  readonly entry?: TaskScript;
  readonly exit?: TaskScript;
  /** The goal the World orients to, from any screen. Absent for a scripted task. */
  readonly goal?: TaskGoal;
  /** The rest the cycle ends with. Absent for a task whose floor cycle has no inn. */
  readonly rest?: TaskRest;
}

/** What the World needs to orient: where the farm is, and the floor it farms on. */
export interface TaskOrient {
  readonly goal: TaskGoal;
  /** The task's own `floor.titleKey`: the floor the farm happens on. */
  readonly floor: string;
}

export type TaskFileProblem =
  | 'not-json' | 'not-an-object' | 'missing-field' | 'unknown-field' | 'unknown-op'
  | 'bad-coordinate' | 'bad-timeout' | 'bad-title-key' | 'unknown-location' | 'exclusive-field';

export type TaskLoad =
  | { readonly ok: true; readonly task: TaskDefinition }
  | { readonly ok: false; readonly reason: TaskFileProblem; readonly detail?: string };

export type TravelFailure =
  | ActionFailure | 'cancelled' | 'capture-unavailable' | 'unknown-location'
  | 'world-map-control-not-found' | 'location-not-found';

export type TravelOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TravelFailure; readonly detail?: string };

export type ScriptFailure =
  | ActionFailure | 'expect-timeout' | 'floor-mismatch' | 'script-timeout' | 'cancelled'
  | 'capture-unavailable' | 'unknown-location' | 'world-map-control-not-found' | 'location-not-found'
  /**
   * Not a failure: the game showed a screen the **loop** owns (a battle, a chest, the death scene),
   * so a per-tick stage yielded. The stage keeps its cursor and resumes when the loop hands the tick
   * back to it (operator rule 2026-11-05).
   */
  | 'interrupted';

export type ScriptResult =
  | {
    readonly ok: true;
    readonly steps: number;
    readonly ms: number;
    /**
     * False when a per-tick stage has more steps to run: the result is partial progress, not the end
     * of the script. Absent means complete (a blocking script, and every caller written before the
     * pump).
     */
    readonly complete?: boolean;
  }
  | { readonly ok: false; readonly step: number; readonly reason: ScriptFailure; readonly detail?: string };

/** Everything a script may touch. No step sees a session, a config or a task file. */
export interface ScriptEnv {
  readonly actuator: Actuator;
  readonly capture: () => Promise<Frame>;
  readonly observe: (frame: Frame) => Promise<Observation>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly abort: AbortSignal;
  readonly log: (line: string) => void;
  /** Travel to a catalogued node: the world map's find-and-tap, one typed result. */
  readonly travel: (to: string) => Promise<TravelOutcome>;
}

// §11 Battle openers

/** The four quick slots of the battle command phase, by their position in its 2x2 grid. */
export type BattleSlot = '左上' | '右上' | '左下' | '右下';

/**
 * Which side a cast resolves over. A multi-target skill resolves over its own targets, so the tap only
 * names the side: `party-front` is any party card (one tap, the heal covers the party), `enemy` is an
 * enemy in the group (one tap, the skill hits many).
 */
export type BattleTarget = 'party-front' | 'enemy';

/**
 * One configured opener: a member's pre-assigned skill, cast once when that member is the one whose
 * command phase is up. `name` is the member's name exactly as the ACTIVE card draws it; the list of
 * openers is the operator's config, and a name that is not on it takes the default action.
 */
export interface BattleOpener {
  readonly name: string;
  readonly slot: BattleSlot;
  readonly target: BattleTarget;
  /**
   * The **确定** button of the skill detail panel, when the skill draws one. The operator's correction
   * (2026-11-03, with the frame): a 全体范围 skill's cast presses *确定* at the panel's bottom — the
   * panel reads 拉巴迪奥斯的秘术, the description, MP 132 ▸ 107 (消费MP: 25) and two buttons, **取消**
   * and **确定** — not an enemy's tile. The panel also carries the 队列 (queue) control at its right.
   * Set, the cast presses this point instead of `target`. Measured live 2026-11-05 for Alice's
   * opener: the 确定 centre is (1053,1005) on the 1920 client (取消 781–946, 确定 971–1135, y 975–1035),
   * and pressing it resolved the panel and spent the skill's 25 MP. An unmeasured point is never
   * configured: a guess on the cast path costs the battle's turn.
   */
  readonly confirm?: Point;
}

/**
 * Reads the ACTIVE member's name off a battle frame, or null when it cannot tell (no battle HUD, no
 * gold card, a frame the reader's geometry was not measured at). The filter treats null exactly like
 * a name that is not on the list — the default action, no slot tap.
 */
export interface BattleMemberReader {
  readActiveMember(frame: Frame): Promise<string | null>;
}

/** What the loop needs from a task, and nothing else. */
export interface SessionTask {
  enter(): Promise<ScriptResult>;
  /**
   * One tick of a script. With the loop's current `observation` the stage runs **one step per tick**
   * and yields — a battle or a chest the game throws in between is the loop's to dispatch, and the
   * stage resumes from its cursor. Without it the script blocks as before (the entry, which runs
   * before the loop).
   */
  runScript(name: ScriptId, observation?: Observation | null): Promise<ScriptResult>;
  /** Stop at the next step boundary; a press already in flight completes. */
  abort(): void;
  /** The orientation a goal task declares. Absent for a scripted task: its entry drives itself. */
  readonly orient?: TaskOrient | undefined;
  /**
   * The rest the cycle ends with (operator rule 2026-11-06): the World taps this control after the
   * exit script and counts the cycle once the party is back on the town's own screen.
   */
  readonly rest?: TaskRest | undefined;
}

// §7 QTE timing

export interface TapPlan {
  readonly atMs: number;
  readonly target: number;
  /**
   * The ± half-width of the predicted stop's band, when the caller supplied the model's
   * uncertainties. The plan is only returned when the band lies inside the zone to the required
   * share (`overlap`); a plan aimed without uncertainty carries 0.
   */
  readonly bandPx?: number;
  /** The share of the band inside the zone, in [0, 1]; 1 when there is no band. */
  readonly overlap?: number;
}

/**
 * stop_x = markerX + v*dt + v*L + sign(v)*v²/(2a)
 * solve for the zone centre; null when no pass is feasible.
 */
export declare function planTap(input: {
  markerX: number; v: number; zones: readonly QteZone[];
  latencyMs: number; decelPxPerS2: number; horizonMs: number;
}): TapPlan | null;