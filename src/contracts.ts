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
  | 'chest-open' | 'chest-qte' | 'loot' | 'loading' | 'chest-prompt' | 'unknown';

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
  readonly kind: 'chest' | 'stairs' | 'hazard' | 'teleport' | 'hole' | 'harken';
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
  readonly willpower: number;
  readonly feared: boolean;
}
export interface OpenerPanel { readonly members: readonly OpenerMember[] }

/** One answer, carrying the payload its screen type owns. */
export type Observation =
  | { readonly screen: 'dungeonmap'; readonly atMs: number; readonly confidence: number; readonly map: MapState }
  | { readonly screen: 'chest-qte'; readonly atMs: number; readonly confidence: number; readonly qte: QteState }
  | { readonly screen: 'chest-open'; readonly atMs: number; readonly confidence: number; readonly opener: OpenerPanel }
  | { readonly screen: Exclude<ScreenId, 'dungeonmap' | 'chest-qte' | 'chest-open'>;
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
  | { kind: 'fight' }
  | { kind: 'exit' }
  | { kind: 'run-script'; name: ScriptId }
  | { kind: 'wait'; ms: number }
  | { kind: 'stop'; reason: string };

export interface RouteState {
  readonly observation: Observation;
  readonly willpower: readonly number[];
  readonly chestsRemaining: number;
}

export interface FarmPolicy { next(state: RouteState): Intent; }

export type SessionVerdict = 'ok' | 'escalate' | 'stop';

// §10 Farm tasks

/** A script a task file can name. `enter` runs at session start; `exit` when the policy says leave. */
export type ScriptId = 'enter' | 'exit';

export type TaskKeyName = 'g' | 'l' | 'q' | 'f' | 'r' | 'tab' | 'esc' | 'space';

export interface TaskStep {
  readonly op: 'tap' | 'key' | 'wait' | 'expect' | 'expectFloor' | 'travel';
  readonly at?: readonly [number, number];
  readonly count?: 1 | 2;
  readonly key?: TaskKeyName;
  readonly holdMs?: number;
  readonly ms?: number;
  /** The destination id a `travel` step names; validated against the catalog at load. */
  readonly to?: string;
  readonly screen?: ScreenId;
  readonly timeoutMs?: number;
}

export interface TaskScript { readonly timeoutMs: number; readonly steps: readonly TaskStep[] }

export interface TaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly floor: { readonly titleKey: string };
  readonly entry: TaskScript;
  readonly exit?: TaskScript;
}

export type TaskFileProblem =
  | 'not-json' | 'not-an-object' | 'missing-field' | 'unknown-field' | 'unknown-op'
  | 'bad-coordinate' | 'bad-timeout' | 'bad-title-key' | 'unknown-location';

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
  | 'capture-unavailable' | 'unknown-location' | 'world-map-control-not-found' | 'location-not-found';

export type ScriptResult =
  | { readonly ok: true; readonly steps: number; readonly ms: number }
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
  runScript(name: ScriptId): Promise<ScriptResult>;
  /** Stop at the next step boundary; a press already in flight completes. */
  abort(): void;
}

// §7 QTE timing

export interface TapPlan { readonly atMs: number; readonly target: number }

/**
 * stop_x = markerX + v*dt + v*L + sign(v)*v²/(2a)
 * solve for the zone centre; null when no pass is feasible.
 */
export declare function planTap(input: {
  markerX: number; v: number; zones: readonly QteZone[];
  latencyMs: number; decelPxPerS2: number; horizonMs: number;
}): TapPlan | null;
