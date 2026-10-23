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
}

// §2 Screens

/** `dungeon` is the 3D exploration view: party walking, HUD up, no map open. The route opens the map
 *  from it; it is distinct from `unknown` (a black or uniform frame has no HUD at all). */
export type ScreenId =
  | 'town' | 'worldmap' | 'dungeon' | 'dungeonmap' | 'combat'
  | 'chest-open' | 'chest-qte' | 'loot' | 'loading' | 'unknown';

// §3 Perception

export interface Point { readonly x: number; readonly y: number }

export interface MapIcon { readonly kind: 'chest' | 'stairs' | 'hazard' | 'haken'; readonly at: Point }

export interface MapState {
  readonly floorTitle: string;
  readonly player: Point;               // grid coordinates, e.g. {x:19,y:21}
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

// §4 Actuation

export type ActionFailure = 'unavailable' | 'rejected' | 'timeout';

export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ActionFailure; readonly detail?: string };

export interface Actuator {
  tap(at: Point): Promise<ActionResult>;
  doubleTap(at: Point): Promise<ActionResult>;
  holdKey(scan: number, holdMs: number): Promise<ActionResult>;   // WASD escape
}

// §5 Engine protocol (World ↔ child)

/** The value of a successful `capture` reply. The child captures on its own cadence and serves its
 *  newest frame; `ageMs` is the duration from capture start to reply on the child's clock. */
export interface EngineCapture {
  readonly jpeg: string;   // base64, encoded in the child
  readonly width: number;  // device pixels of the window's client area
  readonly height: number;
  readonly ageMs: number;  // capture start → reply, on the child's clock
}

export type EngineRequest =
  | { op: 'capture'; maxWidth?: number }
  | { op: 'foreground' }
  | { op: 'tap'; x: number; y: number; count: 1 | 2 }
  | { op: 'key'; scan: number; holdMs: number };

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
  | { kind: 'wait'; ms: number }
  | { kind: 'stop'; reason: string };

export interface RouteState {
  readonly observation: Observation;
  readonly willpower: readonly number[];
  readonly chestsRemaining: number;
}

export interface FarmPolicy { next(state: RouteState): Intent; }

export type SessionVerdict = 'ok' | 'escalate' | 'stop';

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
