/**
 * Opening the world map and travelling to a catalogued node — the entry's two gestures.
 *
 * Everything here is measured from the frame: the parchment control is found (or the party panel is
 * collapsed first so it appears), and the destination is the template the catalog names. A node
 * scores below 0.80 is not a node; the map is zoomed out three times and then panned in a bounded
 * spiral of eight 400-px drags before the action gives up. It never falls back to a coordinate.
 *
 * Failure is a value (contracts §0.6). A refused press ends the action at once; a stop hotkey is
 * honoured between gestures; a capture error is the caller's, not retried here.
 */
import type { ActionFailure, Actuator, Frame, Observation, Point, RgbaImage, ScreenId } from '../contracts.ts';
import { LOCATIONS, type LocationEntry } from '../perception/locations.ts';
import { findTemplate, type Match } from '../perception/match.ts';

export interface WorldMapEnv {
  readonly actuator: Actuator;
  readonly capture: () => Promise<Frame>;
  readonly observe: (frame: Frame) => Promise<Observation>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly abort?: AbortSignal;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export type TravelReason =
  | ActionFailure
  | 'cancelled'
  | 'capture-unavailable'
  | 'unknown-location'
  | 'world-map-control-not-found'
  | 'location-not-found';

export type TravelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TravelReason; readonly detail?: string };

/** Q — 缩小 on the world map (the legend's 移动至标记 code; there it also zooms out). */
const ZOOM_OUT_SCAN = 0x10;
/** E — 放大: after a drag to the right area, zooming in separates 北穿 from 诺村. */
const ZOOM_IN_SCAN = 0x12;
const PRESS_MS = 60;
/** The parchment between the letterboxed pillars; all nodes live inside it. */
const MAP_AREA = { x: 450, y: 0, width: 1_200, height: 1_080 } as const;
/** The Dungeon Select list: its rows sit 56 px apart inside this band, the label art at 0.66–0.70. */
const DUNGEON_SELECT_AREA = { x: 850, y: 300, width: 500, height: 400 } as const;
const DUNGEON_SELECT_SCALES = [0.64, 0.66, 0.68, 0.70] as const;
/** 第三区-城内2F- measures 0.781 here; the matcher's 0.80 floor is the world map's node floor. */
const DUNGEON_SELECT_FLOOR = 0.72;
const TOWN_ICON_BAND = { x: 1_100, y: 900, width: 220, height: 180 } as const;
const PANEL_BAND = { x: 480, y: 720, width: 400, height: 360 } as const;
const CONTROL_SCALES = [0.66, 0.68] as const;
const POLL_MS = 100;
const OPEN_TIMEOUT_MS = 5_000;
const SETTLE_MS = 10_000;
const LEAVE_TIMEOUT_MS = 6_000;
const PANEL_SETTLE_MS = 300;
const ZOOM_SETTLE_MS = 250;
const DRAG_SETTLE_MS = 250;
const DRAG_STEP = 400;
const DRAG_MS = 300;
const MAX_ZOOMS = 3;
const MAX_DRAGS = 8;
const MAX_ZOOM_INS = 2;
/** Least-edge patch for a drag: the map's empty parchment, away from labels and controls. */
const SAFE_INSET = { x: 550, y: 150, width: 950, height: 800 } as const;

const PAN_OFFSETS: readonly Point[] = [
  { x: DRAG_STEP, y: 0 }, { x: 0, y: DRAG_STEP },
  { x: -DRAG_STEP, y: 0 }, { x: 0, y: -DRAG_STEP },
  { x: DRAG_STEP, y: DRAG_STEP }, { x: -DRAG_STEP, y: DRAG_STEP },
  { x: -DRAG_STEP, y: -DRAG_STEP }, { x: DRAG_STEP, y: -DRAG_STEP },
];

/** The destination the catalog names, for a travel action. Controls are not destinations. */
export function destinationOf(id: string): LocationEntry | null {
  const entry = LOCATIONS.get(id);
  return entry === undefined || entry.kind === 'control' ? null : entry;
}

/** Open the world map from whatever screen the party is on, or say why not. */
export async function openWorldMap(env: WorldMapEnv): Promise<TravelResult> {
  const current = await captureAndObserve(env);
  if (!current.ok) return current;
  return openFrom(env, current);
}

/** The same, with the frame the caller already observed (one capture, not two). */
async function openFrom(
  env: WorldMapEnv,
  initial: { frame: Frame; observation: Observation },
): Promise<TravelResult> {
  const now = env.now ?? (() => Date.now());
  if (isPastTheEntry(initial.observation.screen)) return { ok: true };

  let frame = initial.frame;
  let screen = initial.observation.screen;
  if (screen !== 'town') {
    // A loading screen settles into town or world map; anything else is not a place with a map.
    const settled = await poll(env, (candidate) => candidate === 'town' || candidate === 'worldmap', SETTLE_MS, now);
    if (!settled.ok) return settled;
    if (settled.screen === 'worldmap') return { ok: true };
    frame = settled.frame;
    screen = settled.screen;
  }
  if (screen !== 'town') {
    return { ok: false, reason: 'world-map-control-not-found', detail: `screen settled at ${screen}` };
  }

  const image = await decode(frame);
  if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
  let icon = findTemplate(image, TOWN_ICON_BAND, LOCATIONS.get('world-map-icon')!.template, { scales: CONTROL_SCALES });
  if (icon === null) {
    const chevron = findTemplate(image, PANEL_BAND, LOCATIONS.get('panel-chevron')!.template, { scales: CONTROL_SCALES });
    if (chevron === null) {
      return { ok: false, reason: 'world-map-control-not-found', detail: 'neither the icon nor the chevron was found' };
    }
    const collapsed = await env.actuator.tap(centre(chevron));
    if (!collapsed.ok) return failure(collapsed.reason, collapsed.detail);
    await pause(env, PANEL_SETTLE_MS);
    const after = await captureAndObserve(env);
    if (!after.ok) return after;
    if (after.observation.screen !== 'town') {
      return { ok: false, reason: 'world-map-control-not-found', detail: `panel tap left ${after.observation.screen}` };
    }
    const afterImage = await decode(after.frame);
    if (afterImage === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
    icon = findTemplate(afterImage, TOWN_ICON_BAND, LOCATIONS.get('world-map-icon')!.template, { scales: CONTROL_SCALES });
    if (icon === null) {
      return { ok: false, reason: 'world-map-control-not-found', detail: 'the icon did not appear after collapsing the panel' };
    }
  }

  const pressed = await env.actuator.tap(centre(icon, LOCATIONS.get('world-map-icon')!.anchor));
  if (!pressed.ok) return failure(pressed.reason, pressed.detail);
  const opened = await poll(env, (screen) => screen === 'worldmap', OPEN_TIMEOUT_MS, now);
  if (!opened.ok) return opened;
  return opened.screen === 'worldmap' ? { ok: true } : { ok: false, reason: 'world-map-control-not-found', detail: `map did not open (${opened.screen})` };
}

/**
 * Travel to one catalogued node: open the map, match the node, tap it, and wait until the map is
 * gone. Zoom out up to three times and pan in eight directions before giving up.
 */
export async function travelTo(id: string, env: WorldMapEnv): Promise<TravelResult> {
  const now = env.now ?? (() => Date.now());
  const entry = destinationOf(id);
  if (entry === null) return { ok: false, reason: 'unknown-location', detail: id };
  if (entry.kind === 'dungeon-select') return selectDungeon(entry, env);

  const current = await captureAndObserve(env);
  if (!current.ok) return current;
  const start = current.observation.screen;
  if (start === 'dungeon' || start === 'dungeonmap') return { ok: true };
  if (start !== 'worldmap') {
    const opened = await openFrom(env, current);
    if (!opened.ok) return opened;
  }

  let zooms = 0;
  let drags = 0;
  let zoomsIn = 0;
  for (;;) {
    if (env.abort?.aborted) return { ok: false, reason: 'cancelled' };
    const view = await captureAndObserve(env);
    if (!view.ok) return view;
    if (view.observation.screen !== 'worldmap') {
      return { ok: false, reason: 'location-not-found', detail: `the map closed (${view.observation.screen})` };
    }
    const image = await decode(view.frame);
    if (image === null) return { ok: false, reason: 'capture-unavailable' as ActionFailure, detail: 'frame did not decode' };
    const match = findTemplate(image, MAP_AREA, entry.template);

    if (match !== null) {
      const pressed = await env.actuator.tap(centre(match, entry.anchor));
      if (!pressed.ok) return failure(pressed.reason, pressed.detail);
      const left = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, now, 'location-not-found');
      if (!left.ok) return left;
      return { ok: true };
    }

    if (zooms < MAX_ZOOMS) {
      zooms += 1;
      const zoomed = await env.actuator.holdKey(ZOOM_OUT_SCAN, PRESS_MS);
      if (!zoomed.ok) return failure(zoomed.reason, zoomed.detail);
      env.log?.(`wvd: ${entry.label} is not in view; zoomed out (${zooms}/${MAX_ZOOMS})`);
      await pause(env, ZOOM_SETTLE_MS);
      continue;
    }
    if (drags < MAX_DRAGS) {
      const from = safePoint(image);
      const offset = PAN_OFFSETS[drags]!;
      drags += 1;
      const to = clampToMap({ x: from.x + offset.x, y: from.y + offset.y });
      const dragged = await env.actuator.drag(from, to, DRAG_MS);
      if (!dragged.ok) return failure(dragged.reason, dragged.detail);
      env.log?.(`wvd: panned the map towards ${offset.x},${offset.y} (${drags}/${MAX_DRAGS})`);
      await pause(env, DRAG_SETTLE_MS);
      continue;
    }
    if (zoomsIn < MAX_ZOOM_INS) {
      // The last drags brought 诺村's area into view; 北穿 sits next to it and can be separated by
      // zooming in. Zooming re-centres on the cursor, which the last drag left in the area.
      zoomsIn += 1;
      const zoomed = await env.actuator.holdKey(ZOOM_IN_SCAN, PRESS_MS);
      if (!zoomed.ok) return failure(zoomed.reason, zoomed.detail);
      env.log?.(`wvd: zoomed in to separate ${entry.label} (${zoomsIn}/${MAX_ZOOM_INS})`);
      await pause(env, ZOOM_SETTLE_MS);
      continue;
    }
    return { ok: false, reason: 'location-not-found', detail: `${entry.label} was not found on the map` };
  }
}

/**
 * Tap a floor row on the Dungeon Select screen by its label.
 *
 * The screen is not a `ScreenId` and nothing drives it: the party arrives by tapping the dungeon's
 * node on the world map, and the only decision left is where the row is. So this action positions
 * one click and returns — the task's own `expect` steps judge what happened.
 *
 * Measured 2026-10-25 on the live 1920×1080 frame: 第三区-城内2F- scores 0.781 at scale 0.70 and
 * 第一区-城外- 0.762 at 0.66; the rows sit 56 px apart, and the fixed tap this replaces (1082,535)
 * is inside the row the 第三区 match centres on (1098,534).
 */
async function selectDungeon(entry: LocationEntry, env: WorldMapEnv): Promise<TravelResult> {
  const current = await captureAndObserve(env);
  if (!current.ok) return current;
  const image = await decode(current.frame);
  if (image === null) {
    return { ok: false, reason: 'capture-unavailable', detail: 'frame did not decode' };
  }
  const match = findTemplate(image, DUNGEON_SELECT_AREA, entry.template, {
    scales: DUNGEON_SELECT_SCALES,
    minScore: DUNGEON_SELECT_FLOOR,
  });
  if (match === null) {
    return { ok: false, reason: 'location-not-found', detail: `${entry.label} is not on the Dungeon Select list` };
  }
  const pressed = await env.actuator.tap(centre(match, entry.anchor));
  if (!pressed.ok) return failure(pressed.reason, pressed.detail);
  env.log?.(`wvd: selected ${entry.label} on the Dungeon Select list`);
  return { ok: true };
}

function isPastTheEntry(screen: string): boolean {
  return screen === 'worldmap' || screen === 'dungeon' || screen === 'dungeonmap';
}

function failure(reason: ActionFailure, detail?: string): TravelResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function centre(match: Match, anchor?: Point): Point {
  return {
    x: match.at.x + match.width / 2 + (anchor?.x ?? 0),
    y: match.at.y + match.height / 2 + (anchor?.y ?? 0),
  };
}

async function pause(env: WorldMapEnv, ms: number): Promise<void> {
  await env.sleep(ms);
}

/** The loop's own capture policy (§5): three attempts, 200 ms apart, then a typed refusal. */
const CAPTURE_ATTEMPTS = 3;
const CAPTURE_RETRY_MS = 200;

async function captureAndObserve(env: WorldMapEnv): Promise<{ ok: true; frame: Frame; observation: Observation } | { ok: false; reason: TravelReason; detail?: string }> {
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt += 1) {
    if (env.abort?.aborted) return { ok: false, reason: 'cancelled' };
    try {
      const frame = await env.capture();
      const observation = await env.observe(frame);
      return { ok: true, frame, observation };
    } catch {
      // A warming child misses a frame; a real stall is the third failure (contracts §5).
      await env.sleep(CAPTURE_RETRY_MS);
    }
  }
  return { ok: false, reason: 'capture-unavailable', detail: 'capture failed three times' };
}

async function decode(frame: Frame): Promise<RgbaImage | null> {
  try {
    return await frame.toRgba();
  } catch {
    return null;
  }
}

/** Poll the screen until the predicate holds or the budget is spent, in the env's own clock. */
async function poll(
  env: WorldMapEnv,
  predicate: (screen: ScreenId) => boolean,
  timeoutMs: number,
  now: () => number,
  timeoutReason: TravelReason = 'world-map-control-not-found',
): Promise<{ ok: true; frame: Frame; screen: ScreenId } | { ok: false; reason: TravelReason; detail?: string }> {
  const deadline = now() + timeoutMs;
  let last: ScreenId = 'unknown';
  for (;;) {
    if (env.abort?.aborted) return { ok: false, reason: 'cancelled' };
    const current = await captureAndObserve(env);
    if (!current.ok) return current;
    last = current.observation.screen;
    if (predicate(last)) return { ok: true, frame: current.frame, screen: last };
    if (now() >= deadline) return { ok: false, reason: timeoutReason, detail: `screen stayed ${last}` };
    await pause(env, POLL_MS);
  }
}

/** The least-edge 64×64 patch of the map field: an empty piece of parchment to drag from. */
export function safePoint(image: RgbaImage): Point {
  const width = image.width;
  const luma = (x: number, y: number): number => {
    const offset = (y * width + x) * 4;
    return ((image.data[offset]! * 299 + image.data[offset + 1]! * 587 + image.data[offset + 2]! * 114) / 1000) | 0;
  };
  let best = { x: 960, y: 540, energy: Number.POSITIVE_INFINITY };
  for (let y = SAFE_INSET.y; y <= SAFE_INSET.y + SAFE_INSET.height - 64; y += 40) {
    for (let x = SAFE_INSET.x; x <= SAFE_INSET.x + SAFE_INSET.width - 64; x += 40) {
      let energy = 0;
      for (let row = 0; row < 64; row += 8) {
        for (let column = 0; column < 64; column += 8) {
          const value = luma(x + column, y + row);
          energy += Math.abs(value - luma(x + column + 1, y + row)) + Math.abs(value - luma(x + column, y + row + 1));
        }
      }
      if (energy < best.energy) best = { x: x + 32, y: y + 32, energy };
    }
  }
  return { x: best.x, y: best.y };
}

function clampToMap(point: Point): Point {
  return {
    x: Math.min(MAP_AREA.x + MAP_AREA.width - 20, Math.max(MAP_AREA.x + 20, point.x)),
    y: Math.min(MAP_AREA.y + MAP_AREA.height - 20, Math.max(MAP_AREA.y + 20, point.y)),
  };
}
