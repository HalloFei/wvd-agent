# WVD World — contracts

Status: binding
Owner: `src/contracts.ts`
Implements: `2026-10-23-wvd-world-design.md` §7, `2026-10-24-chest-policy-design.md`,
`2026-10-24-navigation-design.md`

This file is the single source of truth for every boundary between modules. The code file mirrors it
declaration for declaration; when one changes the other changes in the same commit. A module may
only rely on what is written here.

## 0. Independence rules

These hold for every module and are what makes a realization replaceable:

1. **Import only contracts.** A module imports `src/contracts.ts` and its own files. It never
   imports another module's implementation.
2. **Dependencies arrive, they are not fetched.** Each module is constructed with its collaborators
   as arguments. No module reaches for a global, a singleton, or the config object.
3. **Config is mapped at the composition root.** The World reads `worlds.wvd` and passes each module
   its own typed options. A module never sees a config key it does not own.
4. **One clock.** Every `atMs` is `performance.now()` in the World process. The child reports
   durations, never timestamps.
5. **Dimensions come from the frame.** No module hardcodes 1920 or 1080; a parser reads
   `frame.width` / `frame.height`, and treats other sizes as unsupported rather than mis-scaling.
6. **Failure is a value.** No module throws across a boundary. A thrown error inside a module is
   caught by the loop and becomes a `stop` or an `escalate`.
7. **A realizer meets the tick budget.** `capture()` and `observe()` must each finish inside half a
   tick (50 ms at the default 100 ms). A realizer that cannot must run in the child or on its own
   cadence; a slow perceiver is a design error, not a reason to lengthen the tick.

## 1. Frame and capture

```ts
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
```

A source may produce JPEG, PNG or raw bytes; consumers only ever call `toRgba()`. Swapping the
encoder changes one module and no parser.

## 2. Screens

```ts
export type ScreenId =
  | 'town' | 'worldmap' | 'dungeon' | 'dungeonmap' | 'combat'
  | 'chest-open' | 'chest-qte' | 'chest-opening' | 'drop-item-claim' | 'loading' | 'chest-prompt'
  | 'dungeon-select' | 'character-page' | 'main-character-dead' | 'harken-menu' | 'unknown';
```

`drop-item-claim` is the chest's item-claim overlay: the contents card with the `获得了…` caption, and
 the result banner after that card is collected. It was named `loot` until 2026-11-03 (operator
 naming). §6's Intent `{kind:'loot'}` keeps its name too: that is the action (collect the card), not
 the screen; the perceiver and the tap actions keep their `loot` names (`perception/loot.ts`,
 `actions/chest.ts`).

`harken-menu` is the floor list a harken offers (2026-11-03): a centred list of destination rows
(`第一区-城外-`, `第二区-城内1F-`, `第四区-城内2F深处-`, `归还` on the measured frame), followed by the
加护 block. **The list is not fixed** — a harken offers a floor only once that floor's harken is
reconstructed — so the reader reports the rows it can name and `null` for a label the library has never
seen (`perception/harken.ts` + `harken-library.ts`). The climb taps the row the task names; when it is
not offered, the `归还` row backs the party out and the stair icon is the way up.

`main-character-dead` is the main character's death (operator, 2026-11-05): the game renders the
frame in **greyscale** — the camera on the character's own gauntlets, no HUD. Measured on the live
death frame (`testdata/screens/2026-11-05-main-character-death/death.jpeg`, a 1280×720 escalation
snapshot): mean saturation **0.000**, saturated pixels **0.00 %**, against 0.058–0.148 and 5.8–33.4 %
on every other recorded screen. The name exists so a death is a named screen, not the unnamed frame
that used to stall the loop; there is **no recovery module** — the route waits, and the game's own
revive changes the screen.

`character-page` is the menu a party HUD card opens (2026-11-03): a member's page with its stat block
and the bottom tab row (关闭 / 强度 / 技能 / 咒文 / 装备 / 背包). Its evidence is the X 关闭 tile at
(683,983), 61×67, template-matched (`perception/character-page.ts`): 1.000 on the page, at most 0.357 on
every other recorded screen. The World *finishes* it — one tap on the close per tick, capped — because
the one-key heal opens it and an unclosed page used to hold the loop on an unnamed screen.

`dungeon-select` is the FFXI Dungeon Select list between the world map node and the 3D dungeon. Its
recogniser matches the legacy zone rows in the list band (第三区 0.781 @0.70, 第一区 0.762 @0.66);
the task names it with `expect` instead of a fixed wait, and `travel` uses the `openworldmap` control
or the row's label from it. It is a hand-off screen: the route waits, the task/action owns it.

`dungeon` is the 3D exploration view — the party walking, the HUD up, no map open. It is the screen
the route acts on by opening the map, and it is distinguishable from `unknown` because the 3D view has
a HUD (minimap box, party bar) while a black or uniform frame has nothing. Without that distinction a
policy either clicks on a black frame or waits forever on a normal view.

`unknown` is a real answer, not a fallback to be smoothed over, and it has **two strengths**:

- **confidence 0** — nothing was drawn: a uniform or black frame, or a frame that could not be
  decoded. This is the only observation that may end a session, because there is nothing to look at.
- **a positive confidence, below every act floor** — something is drawn and no recogniser can name
  it (a battle, a loading screen, the opener panel, a menu). A human can look at that frame, so the
  session escalates and asks — but only once the screen has stayed unnamed for `escalateSettleMs`:
  a transition is unnamed for a few ticks and resolves by itself, and asking about it spends the
  operator's whole wait on frames the next ones answer (measured 2026-10-31, both chest runs paid
  90 s for the panel's fade). Stopping would end the run on the first fight or floor transition.
  `CompositePerceiver` keeps the strongest positive refusal when no recogniser clears its floor.

## 3. Perception

```ts
export interface Point { readonly x: number; readonly y: number }

/** One icon drawn on the map, at its grid cell. The kind names the **glyph**; where a mechanic is
 *  asserted it is the operator's account (2026-10-24), not the picture's.
 *  - 'harken' — the white 4-point sparkle. The harken: the point a party changes floor by.
 *  - 'stair-door' — the **door with the right arrow**, 楼梯-门 (operator's name, 2026-11-03): the stair
 *    entrance to the next floor. The FFXI farm's area is beside it, so the climb taps this icon; the
 *    harken teleports far from the farm and is never the way there.
 *  - 'stairs' | 'hole' — the entries and exits (the staircase; the down-arrow over an oval).
 *  - 'teleport' — the orchid ring. **Within one floor only**: it never crosses, so no route may
 *    use it to change floor.
 *  - 'chest' | 'hazard' — the resource and the obstacle.
 *  Direction is not published: no committed frame carries the mirrored `stair_down` orientation. */
export interface MapIcon {
  readonly kind: 'chest' | 'stairs' | 'stair-door' | 'hazard' | 'teleport' | 'hole' | 'harken';
  readonly at: Point;
}

export interface MapState {
  /** The Latin floor token, e.g. 'B1F'. The localized name beside it is not read: one sample is not
   *  a reader, and a wrong title is worse than a token that only proves the floor. */
  readonly floorTitle: string;
  /** The floor's 32-hex title fingerprint (R27a): the identifier for a floor whose title is not
   *  Latin, and the field a task's floor gate compares. */
  readonly titleKey: string;
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
  readonly willpower: number | null;    // null: no heart drawn (the main character); NaN: unread
  readonly feared: boolean;
}
export interface OpenerPanel { readonly members: readonly OpenerMember[] }

/** One answer, carrying the payload its screen type owns. */
export type Observation =
  | { readonly screen: 'dungeonmap'; readonly atMs: number; readonly confidence: number; readonly map: MapState }
  | { readonly screen: 'chest-qte'; readonly atMs: number; readonly confidence: number; readonly qte: QteState }
  | { readonly screen: 'chest-open'; readonly atMs: number; readonly confidence: number; readonly opener: OpenerPanel }
  | { readonly screen: 'combat'; readonly atMs: number; readonly confidence: number;
      /** The 倍速 and 自動 toggles' highlight on this frame; absent when the buttons are not shown. */
      readonly speedOn?: boolean; readonly autoOn?: boolean }
  | { readonly screen: 'unknown'; readonly atMs: number; readonly confidence: number;
      /** The minimap arrow is drawn, yet nothing named the frame: the 3-D view with something over it. */
      readonly dungeonLike?: boolean }
  | { readonly screen: 'harken-menu'; readonly atMs: number; readonly confidence: number;
      /** The menu's rows, top to bottom: where each label sits, and the label the library knows. */
      readonly rows: readonly { readonly at: Point; readonly label: string | null }[] }
  | { readonly screen: Exclude<ScreenId, 'dungeonmap' | 'chest-qte' | 'chest-open' | 'combat' | 'harken-menu' | 'unknown'>;
      readonly atMs: number; readonly confidence: number };

export interface Perceiver { observe(frame: Frame): Promise<Observation>; }

`dungeonLike` is the one payload an `unknown` answer may carry: the frame's own evidence drew the
minimap arrow (the 3-D view's corner) but no recogniser named the frame — the 3-D view with something
over it, its menu legend or a bright scene in the title band. The loop asks the game's own map about
such a frame before it asks the model (operator rule 2026-11-03): one map command, once per unnamed
episode, and only a frame still unnamed afterwards becomes a question.

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
```

Each screen type is its own recogniser behind this interface. The classifier computes every
screen's standing from the frame's cheap facts first (`screens.ts`), deletes the screens the frame
rules out, and then materialises the survivors in order — a recogniser cannot win a screen the
frame's evidence forbids. Adding a screen means adding a recogniser and its evidence row, not
editing the policy.

A standing's `support` is ordinal: the strongest evidence measured for a screen scores 1, and 0 is
"this frame says nothing either way". It is not a calibrated posterior — the labelled corpus is
about twenty screens — so `ruledOut`, not the number, is what the classifier acts on.

**`origin` is what makes a tile clickable.** The map's canvas scrolls, so no absolute origin is a
constant; the chevron sits at the centre of the party's cell and is measured per frame. The
conversion is done once, by the consumer, with `tileOnScreen(map, tile)` (`src/perception/map.ts`),
which is the exact inverse of the transform that placed `icons`. A walk intent carries a grid cell
(`§6`), never a screen point: the policy must not know where the canvas happens to sit.

**The markers, as measured 2026-10-24.** Which markers cross a floor is the operator's account: the
**harken** and the **entries/exits** do, and the orchid ring does **not** — it moves the party within
one floor. The parser reads five of them: `stairs` (B1F cell 25,25, NCC 1.00, next best 0.63 on the
same floor, ≤ 0.65 anywhere), `hole` (two on 第三区, NCC 1.00/0.98, 0.65 elsewhere), `teleport`
(five on 第四区, a colour rule with zero false pixels on every other committed frame), `harken` (one
per floor — B1F (20,21), 第三区 (6,24), 第四区 (10,23) — matched at the two sizes the game draws it
at, 0.72/1.00/0.72 against a 0.63 best impostor), and the long-standing `chest`/`hazard`. The
mirrored staircase appears in no fixture, so no up/down direction is published. Navigation design §6
records each marker and what is still unobserved.

## 4. Actuation

```ts
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
```

Transport-specific facts stay inside the implementation. A refused precondition is `rejected`; a
capability that cannot be exercised at all is `unavailable`. The Win32 actuator therefore answers
`{ ok:false, reason:'rejected', detail:'not-foreground' }` when the game is not foreground, and
`unavailable` when there is no window or no engine. A different transport reports its own detail
without changing callers.

Every press asserts its precondition first and sends nothing when it fails. The release that
completes a gesture is always sent, even if the window changed while the key was down: a stuck key or
a stuck mouse button is worse than a refused one, and the gesture reports `rejected` after the fact.
A press is held at least 60 ms: a 0 ms press is dropped at 30 fps.

A press is held **at most `MAX_PRESS_HOLD_MS` (500 ms)**, and the World clamps any longer request to
it. The ceiling is not taste: it is the teardown bound of §5, and the two numbers are one fact —
`MAX_PRESS_HOLD_MS < TEARDOWN_GRACE_MS`. A hold that outlived the teardown clock would be killed
with the key still down.

A drag is the same risk with the left button down: it is **at most `MAX_DRAG_MS` (500 ms)**, the
codec refuses anything longer, and the same teardown invariant covers it
(`MAX_DRAG_MS < TEARDOWN_GRACE_MS`). The gesture sends intermediate moves between the press and the
release — a single jump is a click that ends somewhere else, not a drag.

## 5. Engine protocol (World ↔ child)

```ts
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

export type EngineEvent =
  | { kind: 'stopHotkey' }
  | { kind: 'engineProblem'; detail: string };
```

The child captures on its own cadence **while something is asking for frames** — it stops rendering
after a few idle ticks and resumes on demand — and answers `capture` from its newest frame rather than
taking a new one. The first request after an idle gap may therefore find no frame and reply `timeout`;
that is warm-up, not failure, and the World retries. The reply's `ageMs` is the authority for what the frame shows; the round
trip is latency, not freshness, and a loop that treats a short round trip as a fresh frame is wrong by
the age. A successful `capture` reply's `value` is an `EngineCapture`; a
frame older than three ticks (300 ms at the default tick) is `{ ok:false, error:'timeout' }` instead,
because a stale frame that looks fresh is how a QTE tap lands in the hazard gap. `ageMs` is the
duration from capture start to reply on the child's clock; the World stamps
`atMs = performance.now() - ageMs`, so §0.4 holds: the child reports durations, never timestamps.

Input is not free: the child answers `tap`, `key` and `drag` with `{ inputMs }`, the duration from
request receipt to the `SendInput` call completing, so a planner adds a measured leg instead of
assuming one. `doubleTap` is one request, so its two clicks are timed inside the child.

The child also sends events unsolicited: `stopHotkey` when the global stop key is pressed, and
`engineProblem` with a `detail` when a capability is not available. An unregistered stop hotkey is
`detail: 'stop-hotkey-unregistered'`; a slow encoder fallback is `detail: 'native-encoder-unavailable'`.
A session must not run believing the stop key works, and must not time a QTE on a 5 fps frame path.

**Teardown.** Closing the pipe ends the child gracefully — it finishes the request in flight, calls
`releaseHeld()` and exits — and the parent kills it only after `TEARDOWN_GRACE_MS` (1200 ms). On
Windows that kill is `TerminateProcess`, which skips `releaseHeld()`, so the grace must outlive §4's
maximum hold: 500 ms of hold + the 500 ms a first capture may wait for warm-up, plus margin. The
invariants are `MAX_PRESS_HOLD_MS < TEARDOWN_GRACE_MS` and `MAX_DRAG_MS < TEARDOWN_GRACE_MS`;
the numbers live beside each other in `contracts.ts` and one test asserts that no kill lands inside a
maximum-length hold or drag.

## 6. Policy

```ts
export type Intent =
  | { kind: 'open-map' }
  | { kind: 'move'; target: Point }
  | { kind: 'open-chest' }
  | { kind: 'loot' }
  | { kind: 'fight' }
  | { kind: 'exit' }
  | { kind: 'wait'; ms: number }
  | { kind: 'stop'; reason: string };

/** Which pipeline owns the screen; held through unnamed frames (2026-11-03, `policy/mode.ts`). */
export type GameMode = 'unknown' | 'battle' | 'chest' | 'dungeon' | 'travel' | 'town';

export interface RouteState {
  readonly observation: Observation;
  readonly mode: GameMode;                // battle | chest | dungeon | travel | town | unknown
  readonly willpower: readonly number[];
  readonly chestsRemaining: number;
  /**
   * The cells whose walk the farm gave up on this cycle: the tap raised no 自动移動 element and the
   * party did not move, so the game has no path there. The route never aims at one again, and a map
   * whose chests are all here is done — the next stage is the exit (rest, then a fresh cycle).
   * Operator rule, 2026-11-02.
   */
  readonly unreachable: readonly Point[];
}

export interface FarmPolicy { next(state: RouteState): Intent; }

export type SessionVerdict = 'ok' | 'escalate' | 'stop';
```

The policy reads `Observation`, never a specific parser's output type. A new perception realizer
that produces a valid `Observation` requires no policy change.

## 7. QTE timing

```ts
/**
 * `atMs` is a **delay from the frame that produced `markerX`**, not a timestamp — the signature carries
 * no clock, and §0.4's one-clock rule is satisfied by the caller adding `frame.atMs`. A planner that
 * compares it to `frame.atMs` instead of adding it is wrong by a whole session.
 *
 * It carries no `qteMinWindowMs` check either: a window shorter than the floor is refused by the
 * **caller**, who is the only one that knows the configured floor.
 */
export interface TapPlan {
  readonly atMs: number;
  readonly target: number;
  /** The ± half-width of the predicted stop's band, when the caller supplied the uncertainties. */
  readonly bandPx?: number;
  /** The share of the band inside the zone, in [0, 1]; 1 when there is no band. */
  readonly overlap?: number;
}

/**
 * stop_x = markerX + v*dt + v*L + sign(v)*v²/(2a)
 * solve for the zone centre; null when no pass is feasible.
 */
export function planTap(input: {
  markerX: number; v: number; zones: readonly QteZone[];
  latencyMs: number; decelPxPerS2: number; horizonMs: number;
  brakeEnabled?: boolean;   // default false; add the drag carry only when the switch asks
}): TapPlan | null;
```

Rules fixed by the spec: the lead carries `sign(v)`; a target beyond the next bounce is
unreachable; a window shorter than `qteMinWindowMs` is refused rather than gambled.

## 8. Configuration (`worlds.wvd`)

Every tunable lives here. The World declares this as a `ConfigGroup` with a JSON Schema, so the
console renders it, and maps each group into the owning module's options. No module reads the config
object (§0 rule 3).

### 8.1 Session and loop

| Key | Type | Default | Owner | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `false` | World | master switch |
| `dryRun` | boolean | `false` | World | log intents, send no input |
| `tickMs` | integer 50–1000 | `100` | World | loop period |
| `sessionMaxMinutes` | integer | `120` | World | hard stop for one session |
| `stallStopSeconds` | integer | `120` | World | no progress this long ends the session |

### 8.2 Capture and engine

| Key | Type | Default | Owner | Meaning |
|---|---|---|---|---|
| `gameWindowTitle` | string | `WizardryVariantsDaphne` | engine | window to capture and drive |
| `jpegQuality` | integer 30–95 | `75` | engine | frame encoding quality |
| `engineTimeoutMs` | integer | `5000` | engine | one child request |
| `pressHoldMs` | integer 40–500 | `60` | actuator | press duration; 0 ms is dropped at 30 fps |
| `escalationImageWidth` | integer | `1280` | World | downscale before sending a frame to the model |

### 8.3 Navigation

| Key | Type | Default | Owner | Meaning |
|---|---|---|---|---|
| `mapOpenTimeoutMs` | integer | `3000` | navigation | wait for the map after clicking the minimap |
| `automoveArrivalTimeoutMs` | integer | `120000` | navigation | give up if never arrives |
| `automoveStillSeconds` | integer | `5` | navigation | scene static this long means stopped |
| `hazardEscapeSteps` | integer | `3` | navigation | WASD attempts out of a hazard block |
| `hazardEscapeHoldMs` | integer | `250` | navigation | hold per step |
| `resumeMaxAttempts` | integer | `2` | navigation | resume clicks on an interrupted automove |

### 8.4 Chest

| Key | Type | Default | Owner | Meaning |
|---|---|---|---|---|
| `openerPanelTimeoutMs` | integer | `10000` | chest | wait for the 由谁打开? panel after the 打开 click; measured 4.6–8 s |
| `willpowerFloor` | integer | `60` | chest | never choose an opener below this |
| `maxRerolls` | integer | `3` | chest | QTE rerolls per chest, floor chests only |
| `rerollLeadRatio` | number 0–1 | `0.5` | chest | reroll when lead exceeds this fraction of the zone |
| `qteLatencyMs` | integer | `75` | chest | measured input latency |
| `qteBrakeEnabled` | boolean | `false` | chest | add the measured brake carry to plans; default off (press resolves at registration) |
| `qteDecelPxPerS2` | integer | `3000` | chest | fitted slide constant, provisional |
| `qteMinWindowMs` | integer | `150` | chest | refuse a pass tighter than this |
| `qteAttemptsFallback` | integer | `2` | chest | used when the counter is unreadable |
| `qteSubLoopMs` | integer | `4000` | chest | how long the QTE sub-loop may hold the tick before it gives up |
| `lootTapIntervalMs` | integer | `400` | chest | between loot taps; the pacing primitive's 700 ms is the floor (effective interval = max(700 ms, this)) |
| `lootTapMax` | integer | `10` | chest | taps before giving up on loot |

### 8.5 Battle and escalation

| Key | Type | Default | Owner | Meaning |
|---|---|---|---|---|
| `autoBattleEnableAttempts` | integer | `3` | battle | tries to switch auto-battle on; the loop's fallback cap (§11) |
| `battleStepMs` | integer 700–5000 | `1000` | battle | between two battle operations, measured from the previous tap's **return** (§11); the pacing primitive's 700 ms is the floor |
| `battleSettleMs` | integer 0–10000 | `1000` | battle | after the battle's first frame before the first press |
| `battleOpenerTimeoutMs` | integer 1000–60000 | `10000` | battle | how long the opener may wait for a **confirmed** turn card (the same ACTIVE member on two consecutive frames) before the cast is given up |
| `fightTimeoutMs` | integer | `180000` | battle | a fight longer than this is a stall |
| `escalateMaxPerHour` | integer | `20` | escalation | model calls before the session stops |
| `escalateTimeoutMs` | integer | `90000` | escalation | wait for Coo's answer |
| `escalateSettleMs` | integer | `5000` | escalation | an unnamed screen must persist this long before the loop asks; `0` asks on the first frame |
| `stopHotkey` | string | `Ctrl+Alt+W` | engine | global stop, registered natively by the child |

`qteLatencyMs` is a **measured** value with provenance in the chest spec §3. `qteDecelPxPerS2` is
**provisional** — a placeholder matched to two samples' slide distance, not a fitted stop profile;
chest §3 states its error and how agent-timed taps refine it. Both are editable, and a fitted value
replaces the default with a note in the commit that changes it.

## 9. Ownership

| Contract | Defined here | Implemented by |
|---|---|---|
| `FrameSource` | §1 | Task 2 (`src/engine/child.ts`), `Win32FrameSource` |
| `Actuator` | §4 | Task 2, `Win32Actuator` |
| `Perceiver`, `Observation` | §3 | Tasks 4 and 6: `MapPerceiver`, `ChestPerceiver`, plus `CompositePerceiver` |
| `QteState`, `planTap` | §3, §7 | Task 6 (`src/policy/qte.ts`) |
| `FarmPolicy`, `Intent` | §6 | Task 7 (`src/policy/route.ts`) |
| `SessionVerdict` | §6 | Task 8 (`src/policy/session.ts`) |

## 11. Battle openers

The operator's rule (2026-11-02): a battle may open with configured skills before auto takes over.
The config is a **list of members**; every command phase the loop reads the ACTIVE card's name and
looks it up — on the list, that member's skill is cast (slot, then target); not on it, the loop's
default runs and the next phase is checked. The name read is the one seam that is a stub today.

```ts
export type BattleSlot = '左上' | '右上' | '左下' | '右下';
export type BattleTarget = 'party-front' | 'enemy';

export interface BattleOpener {
  readonly name: string;          // as the ACTIVE card draws it
  readonly slot: BattleSlot;
  readonly target: BattleTarget;  // multi-target: the tap names the side
  readonly confirm?: Point;       // the skill's own 确认 button; pressed instead of `target` when set.
                                  // Measured 2026-11-05: (1053,1005) resolves 拉巴迪奥斯的秘术's panel.
}

export interface BattleMemberReader {
  readActiveMember(frame: Frame): Promise<string | null>;
}
```

`readActiveMember` is realised by the party panel (`src/perception/party.ts`): the card of the member
whose command phase is up is tinted gold across its face, and the panel's six names are the roster in
card order. The measurement, the guards and the rejected glyph alternative are
`2026-11-02-battle-member-read-design.md`. A null answer — no battle HUD, no gold card, another
screen size — is a miss, never an error, and never a tap on a slot.

The World sends the battle's operations as a **sequence** (`src/policy/battle-sequence.ts`, operator
rule 2026-11-04): settle → 倍速 → **自動 off (when the cast is owed and 自動 is on)** → the opener's
slot → the opener's confirm → 自動 → hold. One tap per tick, in that order, each waiting
`battleStepMs` (§8.5) from the previous tap's **return**, and no press at all before
`battleSettleMs` has passed since the battle's first frame. Both toggles are read before they are
pressed (§2 `speedOn`/`autoOn`), so a blind re-press cannot turn one back off; a press that did not
take is retried while the frame still says it is off, capped by `autoBattleEnableAttempts` (§8.5) —
the operator's fallback rule (2026-11-02): *if auto is not on, press; otherwise carry on.* The ACTIVE
card is read before the cast and never at the skill panel (the panel dims it): a miss waits
`battleOpenerTimeoutMs` and then gives the cast up. A read is **confirmed** before it is trusted:
   the same ACTIVE member on two consecutive frames (operator rule 2026-11-04: *until we get a stable
   frame, then confirm the current state*), not a single frame.

The opener belongs to the **first battle of the first cycle** of a farm task (operator rule, later on
2026-11-04): that battle, entered with 自動 **on**, is **disengaged** — 自動 off, the opener cast once
by hand, 自動 back on — because an auto battle draws no command phase to cast into. Every later battle
is handed an empty opener list, so the loop only keeps 自動 **on** (it presses it when the frame says
it is off) and never casts. A battle with **no configured opener** is left alone the same way: nothing
to cast, so 自動 is never touched. If 自動 will not come off within `autoBattleEnableAttempts` tries,
the cast is given up and the battle plays itself. The sequence lives as long as the battle **mode** does,
so an unnamed frame inside a battle cannot re-arm it and cast the opener twice.

## 10. Farm tasks

The task file design (`2026-10-24-task-file-design.md`) owns the rationale; this section is the
binding shape. A task file declares where to farm and either a script that gets the party there or a
goal the World orients to; the World knows `enter`, `runScript`, `abort` and — for a goal task — the
`orient` descriptor it drives one command per tick.

```ts
/**
 * `enter` runs at session start (a scripted task only); `exit` when the policy says leave;
 * `climb` when the orientation finds the party on the stair floor (the goal form below).
 */
export type ScriptId = 'enter' | 'exit' | 'climb';
export type TaskKeyName = 'g' | 'l' | 'q' | 'f' | 'r' | 'tab' | 'esc' | 'space';

export interface TaskStep {
  readonly op: 'tap' | 'key' | 'wait' | 'expect' | 'expectFloor' | 'travel';
  readonly at?: readonly [number, number];
  readonly count?: 1 | 2;
  readonly key?: TaskKeyName;
  readonly holdMs?: number;
  /** `expectFloor` only: the 32-hex floor key to gate; the task's own key when absent. */
  readonly titleKey?: string;
  readonly ms?: number;
  /** The destination id a `travel` step names; validated against the catalog at load. */
  readonly to?: string;
  readonly screen?: ScreenId;
  readonly timeoutMs?: number;
}

export interface TaskScript { readonly timeoutMs: number; readonly steps: readonly TaskStep[] }

/**
 * Where a farm lives, and the one measured detour on the way.
 *
 * A goal task does not say how to drive the game from a known starting screen: it says where the
 * farm is, and the World orients toward it from whatever screen the party is on. `site` is the
 * world-map node, `zone` the Dungeon Select row that opens one of its zones.
 */
export interface TaskGoal {
  readonly site: string;
  readonly zone?: string;
  /**
   * The floor whose map carries the measured stair-up. A party already on that floor runs the
   * climb script; the World never presses a blind tile from another floor.
   */
  readonly climb?: TaskClimb;
}

export interface TaskClimb {
  /** The 32-hex floor key the climb script's own `expectFloor` falls back to. */
  readonly from: string;
  readonly script: TaskScript;
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
  /** Not a failure: a loop-owned screen (battle, chest, death) interrupted a per-tick stage. */
  | 'interrupted';

export type ScriptResult =
  | {
    readonly ok: true;
    readonly steps: number;
    readonly ms: number;
    /** False when a per-tick stage has more steps; absent means the script is complete. */
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

/** What the loop needs from a task, and nothing else. */
export interface SessionTask {
  enter(): Promise<ScriptResult>;
  /**
   * One tick of a script (operator rule 2026-11-05): with the loop's `observation` the stage runs at
   * most one operation, and a screen the loop owns (battle, chest, death) yields `interrupted` with
   * the stage's cursor kept. Without an observation the script blocks (the entry, the climb).
   */
  runScript(name: ScriptId, observation?: Observation | null): Promise<ScriptResult>;
  abort(): void;
  /** The orientation a goal task declares. Absent for a scripted task: its entry drives itself. */
  readonly orient?: TaskOrient | undefined;
}
```

`travel` is the one step that finds its target in the frame: the catalog's template is matched on
the world map, the map is zoomed out and panned within its budget, and a score below 0.80 is not a
node. The id is checked against the catalog when the file is loaded (`unknown-location`), so a typo
refuses the session instead of failing mid-entry.

**A task carries either an `entry` or a `goal`, never both** (`exclusive-field`): a scripted entry
assumes the screen it starts on, and a goal lets the World orient from any screen. The World drives
a goal one command per tick — open the map, read the floor, travel, climb — and hands the loop to
the farm route once the map shows the task's floor. `climb` is the one measured detour: a party on
the climb floor runs the task's own script, gated on `climb.from`; any other floor is a stop, never
a blind tile. The design and the live measurements are in
`2026-11-02-orient-goal-design.md`.

