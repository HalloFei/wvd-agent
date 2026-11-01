/**
 * Opening the world map and travelling to a catalogued node — the entry's two gestures. The map's
 * zoom steps are primitives of their own (`zoomWorldMap`), so the travel action and the operator's
 * CLI drive the view the same way.
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
import { waitStable } from '../frames/stable.ts';
import { DUNGEON_SELECT_AREA, DUNGEON_SELECT_FLOOR, DUNGEON_SELECT_SCALES } from '../perception/dungeon-select.ts';
import { LOCATIONS, type LocationEntry } from '../perception/locations.ts';
import { findTemplate, type Match, type MatchTemplate } from '../perception/match.ts';
import {
  LABEL_ANCHORS,
  MAP_STRIP,
  MAP_ZOOM_KEYS,
  SAFE_TAP,
  insideSafeTap,
  offsetFromMatch,
  panDragFor,
  screenPointOf,
  siteById,
  type WorldMapSite,
} from '../perception/worldmap-atlas.ts';

export interface WorldMapEnv {
  readonly actuator: Actuator;
  readonly capture: () => Promise<Frame>;
  readonly observe: (frame: Frame) => Promise<Observation>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly abort?: AbortSignal;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /**
   * Whether the stored atlas may place a destination (src/perception/worldmap-atlas.ts). The World
   * and the live CLI turn it on; a caller that only exercises the template search leaves it off, so
   * the fallback's own behaviour stays testable unchanged.
   */
  readonly atlas?: boolean;
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
/** The Dungeon Select row that opens the world map; measured live at 0.946 @ 0.68, hit (1100,666). */
const OPEN_WORLD_MAP_AREA = { x: 850, y: 600, width: 500, height: 160 } as const;
const OPEN_WORLD_MAP_SCALES = [0.66, 0.68] as const;
const OPEN_WORLD_MAP_FLOOR = 0.80;
/** The Dungeon Select row that opens the world map; measured live 2026-10-31 (the guide point). */
const DUNGEON_SELECT_WORLD_MAP_AT = { x: 1100, y: 666 } as const;
const TOWN_ICON_BAND = { x: 1_100, y: 900, width: 220, height: 180 } as const;
const PANEL_BAND = { x: 480, y: 720, width: 400, height: 360 } as const;
const CONTROL_SCALES = [0.66, 0.68] as const;
const POLL_MS = 100;
/** The stable-frame guard: a screen must hold this long before a control/node is tapped. */
const STABLE_HOLD_MS = 500;
const STABLE_TIMEOUT_MS = 2_500;
const OPEN_TIMEOUT_MS = 5_000;
const SETTLE_MS = 10_000;
const LEAVE_TIMEOUT_MS = 6_000;
const PANEL_SETTLE_MS = 300;
const ZOOM_SETTLE_MS = 250;
const DRAG_SETTLE_MS = 250;
const DRAG_STEP = 400;
const DRAG_MS = 300;
const MAX_ZOOMS = 3;
const MAX_ZOOM_INS = 2;
/**
 * The node label band's top sits this many screen pixels above the node icon's clickable centre.
 * Measured live 2026-10-31: 41 px on the town map at zoom 1.0 and 38 px on the Dungeon Select map
 * at max zoom-out, so the rise is essentially screen-space constant (the icon shrinks towards the
 * label). The label banner itself is not clickable: a tap on it did nothing live, a tap here moved.
 */
const NODE_ICON_RISE = 40;
/** The label band is the same screen-space art at every zoom, so the node floor holds for it. */
const LABEL_FLOOR = 0.8;
/** Least-edge patch for a drag: the map's empty parchment, away from labels and controls. */
const SAFE_INSET = { x: 550, y: 150, width: 950, height: 800 } as const;

/**
 * A serpentine pan, not a closed loop: eight directions around one point covers only ±400 px, and
 * the Dungeon Select world map opens far from 诺森霍洛村 (measured live 2026-10-31). Five rows of
 * eight 400-px drags sweep ~3 200 x 1 600 px before the zoom-ins. The target is matched after every
 * step, so a nearby target costs one drag.
 */
const PAN_OFFSETS: readonly Point[] = (() => {
  const offsets: Point[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      offsets.push({ x: row % 2 === 0 ? DRAG_STEP : -DRAG_STEP, y: 0 });
    }
    if (row < 4) offsets.push({ x: 0, y: DRAG_STEP });
  }
  return offsets;
})();
const MAX_DRAGS = PAN_OFFSETS.length;

/** The destination the catalog names, for a travel action. Controls are not destinations. */
export function destinationOf(id: string): LocationEntry | null {
  const entry = LOCATIONS.get(id);
  return entry === undefined || entry.kind === 'control' ? null : entry;
}

/** The map's two zoom keys: Q 缩小 and E 放大, named the way a caller thinks of them. */
export type ZoomDirection = 'in' | 'out';

/**
 * One zoom step on the open world map — the primitive `travelTo` and the operator's CLI share.
 *
 * It presses the key and waits for the view to settle; it reads no frame, so a caller that already
 * captures between steps (the travel action) does not pay for a second decode.
 */
export async function zoomWorldMap(direction: ZoomDirection, env: WorldMapEnv): Promise<TravelResult> {
  const pressed = await env.actuator.holdKey(direction === 'in' ? ZOOM_IN_SCAN : ZOOM_OUT_SCAN, PRESS_MS);
  if (!pressed.ok) return failure(pressed.reason, pressed.detail);
  await pause(env, ZOOM_SETTLE_MS);
  return { ok: true };
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
  // The caller's frame is a snapshot; wait until whatever screen it is has actually held still.
  // A transition frame (town fading in, map fading in, a loading screen) must not be the frame a
  // control is matched and tapped on.
  const settledStart = await settleOn(env, now);
  if (settledStart === null && env.abort?.aborted) return { ok: false, reason: 'cancelled' };
  const start = settledStart ?? initial;
  if (isPastTheEntry(start.observation.screen)) return { ok: true };

  let frame = start.frame;
  let screen = start.observation.screen;
  // The named Dungeon Select stage has a measured control: its row's hit point opened the map
  // live. The legacy template scores only 0.265 in the native frame (the row is drawn with the
  // party panel up and the native JPEG differs from the saved q90), so this stage must not depend
  // on the template. One bounded retry covers a click swallowed by the fade.
  if (screen === 'dungeon-select') {
    env.log?.('wvd: opening the world map from the Dungeon Select row');
    const pressed = await env.actuator.tap(DUNGEON_SELECT_WORLD_MAP_AT);
    if (!pressed.ok) return failure(pressed.reason, pressed.detail);
    let opened = await poll(env, (candidate) => candidate === 'worldmap' || candidate === 'town', OPEN_TIMEOUT_MS, now);
    if (!opened.ok) {
      env.log?.('wvd: the Dungeon Select row did not open the map on the first tap; retrying once');
      const retried = await env.actuator.tap(DUNGEON_SELECT_WORLD_MAP_AT);
      if (!retried.ok) return failure(retried.reason, retried.detail);
      opened = await poll(env, (candidate) => candidate === 'worldmap' || candidate === 'town', OPEN_TIMEOUT_MS, now);
      if (!opened.ok) return opened;
    }
    if (opened.screen === 'worldmap') return { ok: true };
    frame = opened.frame;
    screen = opened.screen;
  } else if (screen !== 'town' && screen !== 'worldmap') {
    // An unnamed screen (a loading frame, or an older select frame) is reached through a loading
    // screen, which is also unnamed. The template control is the legacy fallback; the named stage
    // above is the normal path.
    const deadline = now() + SETTLE_MS;
    for (;;) {
      const image = await decode(frame);
      const control = image === null
        ? null
        : findTemplate(image, OPEN_WORLD_MAP_AREA, LOCATIONS.get('open-world-map')!.template, {
          scales: OPEN_WORLD_MAP_SCALES,
          minScore: OPEN_WORLD_MAP_FLOOR,
        });
      if (control !== null) {
        env.log?.('wvd: opening the world map from the Dungeon Select control');
        const pressed = await env.actuator.tap(centre(control));
        if (!pressed.ok) return failure(pressed.reason, pressed.detail);
        let opened = await poll(env, (candidate) => candidate === 'worldmap' || candidate === 'town', OPEN_TIMEOUT_MS, now);
        if (!opened.ok) {
          const again = await captureAndObserve(env);
          if (!again.ok) return again;
          if (again.observation.screen === 'worldmap') return { ok: true };
          const againImage = await decode(again.frame);
          const againControl = againImage === null
            ? null
            : findTemplate(againImage, OPEN_WORLD_MAP_AREA, LOCATIONS.get('open-world-map')!.template, {
              scales: OPEN_WORLD_MAP_SCALES,
              minScore: OPEN_WORLD_MAP_FLOOR,
            });
          if (againControl === null) return opened;
          const retryAt = centre(againControl);
          env.log?.(`wvd: the Dungeon Select control did not open the map on the first tap; retrying once at ${retryAt.x},${retryAt.y}`);
          const retried = await env.actuator.tap(retryAt);
          if (!retried.ok) return failure(retried.reason, retried.detail);
          opened = await poll(env, (candidate) => candidate === 'worldmap' || candidate === 'town', OPEN_TIMEOUT_MS, now);
          if (!opened.ok) return opened;
        }
        if (opened.screen === 'worldmap') return { ok: true };
        frame = opened.frame;
        screen = opened.screen;
        break;
      }
      const currentScreen: string = screen;
      if (currentScreen === 'town' || currentScreen === 'worldmap' || now() >= deadline) break;
      await pause(env, POLL_MS);
      const next = await settleOn(env, now);
      if (next === null) {
        if (env.abort?.aborted) return { ok: false, reason: 'cancelled' };
        break;
      }
      frame = next.frame;
      screen = next.observation.screen;
      const settledScreen: string = screen;
      if (settledScreen === 'town' || settledScreen === 'worldmap') break;
    }
  }
  if (screen !== 'town') {
    // A loading screen settles into town or world map; anything else is not a place with a map.
    const settled = await poll(env, (candidate) => candidate === 'town' || candidate === 'worldmap', SETTLE_MS, now);
    if (!settled.ok) {
      // The Dungeon Select screen and a loading screen are both 'unknown': the control loop above
      // can time out on the loading frame and the settle poll cannot see the select screen either.
      // Try the control once on the frame the poll ended on before refusing; this is the live
      // 2026-11-01 failure (the select appeared after the control loop's deadline).
      const after = await captureAndObserve(env);
      if (!after.ok) return settled;
      if (after.observation.screen === 'worldmap') return { ok: true };
      if (after.observation.screen === 'town') {
        frame = after.frame;
        screen = 'town';
      } else {
        const afterImage = await decode(after.frame);
        const control = afterImage === null
          ? null
          : findTemplate(afterImage, OPEN_WORLD_MAP_AREA, LOCATIONS.get('open-world-map')!.template, {
            scales: OPEN_WORLD_MAP_SCALES,
            minScore: OPEN_WORLD_MAP_FLOOR,
          });
        if (control === null) return settled;
        env.log?.('wvd: opening the world map from the Dungeon Select control after the settle poll');
        const pressed = await env.actuator.tap(centre(control));
        if (!pressed.ok) return failure(pressed.reason, pressed.detail);
        const opened = await poll(env, (candidate) => candidate === 'worldmap' || candidate === 'town', OPEN_TIMEOUT_MS, now);
        if (!opened.ok) return settled;
        if (opened.screen === 'worldmap') return { ok: true };
        frame = opened.frame;
        screen = opened.screen;
      }
    } else {
      if (settled.screen === 'worldmap') return { ok: true };
      frame = settled.frame;
      screen = settled.screen;
    }
  }
  if (screen !== 'town') {
    return { ok: false, reason: 'world-map-control-not-found', detail: `screen settled at ${screen}` };
  }
  // The settle poll can return the first frame that names town, while the town is still fading in.
  // Hold the town for the stable window before reading the icon; a transition frame must not be
  // matched or tapped.
  const stableTown = await settleOn(env, now);
  if (stableTown !== null) {
    if (stableTown.observation.screen === 'worldmap') return { ok: true };
    if (stableTown.observation.screen !== 'town') {
      return { ok: false, reason: 'world-map-control-not-found', detail: `screen settled at ${stableTown.observation.screen}` };
    }
    frame = stableTown.frame;
    screen = stableTown.observation.screen;
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

  const target = centre(icon, LOCATIONS.get('world-map-icon')!.anchor);
  env.log?.(`wvd: world-map icon ${icon.score.toFixed(3)} ${icon.width}x${icon.height} @ ${icon.scale.toFixed(2)} at ${icon.at.x},${icon.at.y} -> tap ${target.x},${target.y}`);
  const pressed = await env.actuator.tap(target);
  if (!pressed.ok) return failure(pressed.reason, pressed.detail);
  const opened = await poll(env, (screen) => screen === 'worldmap', OPEN_TIMEOUT_MS, now);
  if (opened.ok) return { ok: true };
  if (opened.reason !== 'world-map-control-not-found') return opened;
  // A click issued on the first `town` frame after a transition can be swallowed by the game. The
  // first poll has now waited out the transition; re-capture and re-match once instead of trusting
  // the stale icon position. The retry is bounded and still runs through the same verification.
  const again = await captureAndObserve(env);
  if (!again.ok) return again;
  if (again.observation.screen === 'worldmap') return { ok: true };
  if (again.observation.screen !== 'town') return opened;
  const againImage = await decode(again.frame);
  if (againImage === null) return opened;
  const againIcon = findTemplate(againImage, TOWN_ICON_BAND, LOCATIONS.get('world-map-icon')!.template, { scales: CONTROL_SCALES });
  if (againIcon === null) return opened;
  const retryAt = centre(againIcon, LOCATIONS.get('world-map-icon')!.anchor);
  env.log?.(`wvd: the world map did not open on the first tap; retrying once at ${retryAt.x},${retryAt.y}`);
  const retried = await env.actuator.tap(retryAt);
  if (!retried.ok) return failure(retried.reason, retried.detail);
  const retriedOpen = await poll(env, (screen) => screen === 'worldmap', OPEN_TIMEOUT_MS, now);
  return retriedOpen.ok ? { ok: true } : retriedOpen;
}

// ------------------------------------------------------------------------------------------------
// Travel by the stored world map
//
// The atlas (src/perception/worldmap-atlas.ts) knows every catalogued site's coordinate on the map
// and one label banner per site whose banner the game draws at max zoom-out. That is enough to stop
// hunting: zoom the map to its clamp, match *one* banner to learn the view's atlas offset, project
// the target site, confirm the node's own icon template at the projected point, and tap it. The
// template is the confirmation, exactly as the template search is the fallback when the atlas has
// no entry for the destination.
// ------------------------------------------------------------------------------------------------

/** A label banner scores far above this at max zoom-out; measured 0.93-0.99 on the live frames. */
const ATLAS_LABEL_FLOOR = 0.8;
/** The node icon, drawn at ~0.45 of the legacy art; the sweep covers the measured range. */
const ATLAS_ICON_SCALES = [0.40, 0.42, 0.44, 0.46, 0.48, 0.50] as const;
const ATLAS_ICON_FLOOR = 0.75;
/** Where the legacy art's label band starts, as a fraction of its height (locations.ts's rule). */
const LEGACY_LABEL_BAND_TOP = 0.687;
const ATLAS_ZOOM_PRESSES = 8;
const ATLAS_ZOOM_SETTLE_MS = 420;
const ATLAS_VERIFY_RADIUS = 80;
const ATLAS_PAN_ATTEMPTS = 3;
/** Drag origins tried in turn: empty parchment, away from the nodes near the map's centre. */
const ATLAS_PAN_STARTS: readonly Point[] = [
  { x: 600, y: 150 },
  { x: 1_000, y: 840 },
  { x: 600, y: 840 },
  { x: 1_000, y: 150 },
];
/**
 * Where the pointer is parked before a measurement. The pointer is drawn into the frame, and a drag
 * leaves it exactly where the pan ended — on the node being verified. A tap on the black pillar is
 * inert on this screen (measured 2026-11-01: the strip is unchanged and the screen stays worldmap),
 * and it parks the pointer outside the map.
 */
const ATLAS_PARK_POINT: Point = { x: 200, y: 540 };
const ATLAS_PARK_SETTLE_MS = 140;

/** A coarse luma signature of the strip, for the zoom clamp's "did this press change anything" test. */
function stripSignature(image: RgbaImage): Float64Array {
  const width = 120;
  const height = 135;
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let by = 0; by < 8; by += 1) {
        for (let bx = 0; bx < 8; bx += 1) {
          const at = ((y * 8 + by) * image.width + MAP_STRIP.x + x * 8 + bx) * 4;
          sum += (image.data[at]! * 299 + image.data[at + 1]! * 587 + image.data[at + 2]! * 114) / 1000;
        }
      }
      out[y * width + x] = sum / 64;
    }
  }
  return out;
}

function signatureDiff(left: Float64Array, right: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index]! - right[index]!);
  return sum / left.length;
}

/**
 * Zoom out to the map's own clamp. The game has no zoom readout, so the clamp *is* the zoom state:
 * press Q until two presses in a row leave the strip unchanged.
 */
async function zoomToMaxOut(env: WorldMapEnv): Promise<TravelResult> {
  let previous: Float64Array | null = null;
  for (let press = 0; press < ATLAS_ZOOM_PRESSES; press += 1) {
    const sent = await env.actuator.holdKey(MAP_ZOOM_KEYS.out, PRESS_MS);
    if (!sent.ok) return failure(sent.reason, sent.detail);
    await pause(env, ATLAS_ZOOM_SETTLE_MS);
    const current = await captureAndObserve(env);
    if (!current.ok) return current;
    if (current.observation.screen !== 'worldmap') {
      return { ok: false, reason: 'location-not-found', detail: 'the map closed while zooming out' };
    }
    const image = await decode(current.frame);
    if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
    const signature = stripSignature(image);
    if (previous !== null && signatureDiff(previous, signature) < 0.6) return { ok: true };
    previous = signature;
  }
  return { ok: true };
}

/**
 * The view's atlas offset, from the first label banner that matches. The banner is screen-space art,
 * so its crop from the atlas matches a live frame unchanged; the match's top-left and the banner's
 * atlas top-left give the offset directly.
 */
function locateAtlas(image: RgbaImage): { offset: Point; anchor: string } | null {
  for (const anchor of LABEL_ANCHORS) {
    const match = findTemplate(image, MAP_STRIP, anchor.template, { scales: [1], minScore: ATLAS_LABEL_FLOOR });
    if (match === null) continue;
    return {
      offset: offsetFromMatch(anchor, { x: match.at.x - MAP_STRIP.x, y: match.at.y }),
      anchor: anchor.id,
    };
  }
  return null;
}

/** The icon part of a catalogued node: the top 68.7% of the legacy art (locations.ts's band). */
function iconTemplateFor(locationId: string): MatchTemplate | null {
  const entry = LOCATIONS.get(locationId);
  if (entry === undefined) return null;
  const source = entry.template;
  const height = Math.round(source.height * LEGACY_LABEL_BAND_TOP);
  return { width: source.width, height, gray: source.gray.subarray(0, height * source.width) };
}

/**
 * Confirm a site at the projected point by matching its own icon template there, and return the
 * matched icon's centre in strip coordinates. Null when the icon is not where the atlas says it is —
 * a stale atlas must not become a blind click.
 */
function confirmSite(image: RgbaImage, site: WorldMapSite, projected: Point): Point | null {
  if (site.templateId === undefined) return null;
  const template = iconTemplateFor(site.templateId);
  if (template === null) return null;
  const area = {
    x: MAP_STRIP.x + projected.x - ATLAS_VERIFY_RADIUS,
    y: projected.y - ATLAS_VERIFY_RADIUS,
    width: ATLAS_VERIFY_RADIUS * 2,
    height: ATLAS_VERIFY_RADIUS * 2,
  };
  const match = findTemplate(image, area, template, { scales: ATLAS_ICON_SCALES, minScore: ATLAS_ICON_FLOOR });
  if (match === null) return null;
  return {
    x: match.at.x + Math.round(match.width / 2) - MAP_STRIP.x,
    y: match.at.y + Math.round(match.height / 2),
  };
}

/**
 * Travel to a site by its stored coordinate: open the map, zoom to the clamp, locate the view by a
 * label banner, pan the target into the safe area, confirm its icon, and tap. Every step that can
 * be wrong is re-measured from the frame instead of assumed.
 */
export async function travelViaAtlas(site: WorldMapSite, env: WorldMapEnv): Promise<TravelResult> {
  const now = env.now ?? (() => Date.now());
  const opened = await openWorldMap(env);
  if (!opened.ok) return opened;
  const zoomed = await zoomToMaxOut(env);
  if (!zoomed.ok) return zoomed;

  let lastReason: TravelResult = { ok: false, reason: 'location-not-found', detail: 'no attempt ran' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (env.abort?.aborted) return { ok: false, reason: 'cancelled' };
    // Park the pointer first: it is drawn into the frame, and a drag leaves it on the node itself.
    const parked = await env.actuator.tap(ATLAS_PARK_POINT);
    if (!parked.ok) return failure(parked.reason, parked.detail);
    await pause(env, ATLAS_PARK_SETTLE_MS);
    const view = await captureAndObserve(env);
    if (!view.ok) return view;
    if (view.observation.screen !== 'worldmap') {
      return { ok: false, reason: 'location-not-found', detail: 'the map closed while placing the site' };
    }
    const image = await decode(view.frame);
    if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
    const located = locateAtlas(image);
    if (located === null) {
      return { ok: false, reason: 'world-map-control-not-found', detail: 'no atlas label was in view' };
    }
    const target = screenPointOf(site, located.offset);
    env.log?.('wvd: atlas ' + site.id + ' at ' + target.x + ',' + target.y
      + ' (anchor ' + located.anchor + ', offset ' + located.offset.x + ',' + located.offset.y + ')');

    if (insideSafeTap(target)) {
      const confirmed = confirmSite(image, site, target);
      if (confirmed === null) {
        lastReason = {
          ok: false,
          reason: 'location-not-found',
          detail: site.label + ' is not at its atlas point ' + target.x + ',' + target.y,
        };
        env.log?.('wvd: the atlas placed ' + site.id + ' at ' + target.x + ',' + target.y + ' but its icon template did not match there');
        return lastReason;
      }
      const pressed = await env.actuator.tap({ x: MAP_STRIP.x + confirmed.x, y: confirmed.y });
      if (!pressed.ok) return failure(pressed.reason, pressed.detail);
      const left = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, now, 'location-not-found');
      if (left.ok) return { ok: true };
      // A tap can be swallowed by a map that is still settling; re-place once before giving up.
      lastReason = left;
      continue;
    }

    // The target is outside the safe area: pan it in, then measure the new view next pass.
    const pan = attempt;
    const desired = Math.max(SAFE_TAP.x + 140, Math.min(SAFE_TAP.x + SAFE_TAP.width - 140, target.x));
    const drag = panDragFor(desired - target.x);
    if (Math.abs(drag) < 20) {
      return { ok: false, reason: 'location-not-found', detail: site.label + ' is outside the reachable map' };
    }
    const start = ATLAS_PAN_STARTS[pan % ATLAS_PAN_STARTS.length]!;
    const from = {
      x: Math.max(MAP_STRIP.x + 40, Math.min(MAP_STRIP.x + MAP_STRIP.width - 40 - drag, start.x)),
      y: start.y,
    };
    env.log?.('wvd: panning the map by ' + drag + ' px to bring ' + site.label + ' into reach');
    const dragged = await env.actuator.drag(from, { x: from.x + drag, y: from.y }, DRAG_MS);
    if (!dragged.ok) return failure(dragged.reason, dragged.detail);
    await pause(env, DRAG_SETTLE_MS);
    lastReason = { ok: false, reason: 'location-not-found', detail: site.label + ' was not reachable after panning' };
  }
  return lastReason;
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

  // The stored atlas is the normal path for any node it catalogues: the site's coordinate is
  // measured and one label banner tells the view where it is, so the spiral below is the fallback
  // for destinations the atlas does not know.
  const atlasSite = env.atlas === true ? siteById(id) : null;
  if (atlasSite !== null) {
    const viaAtlas = await travelViaAtlas(atlasSite, env);
    if (viaAtlas.ok) return viaAtlas;
    env.log?.('wvd: the atlas could not place ' + entry.label + ' (' + viaAtlas.reason + '); falling back to the template search');
  }

  const current = await captureAndObserve(env);
  if (!current.ok) return current;
  const start = current.observation.screen;
  if (start === 'dungeon' || start === 'dungeonmap') return { ok: true };
  if (start !== 'worldmap') {
    const opened = await openFrom(env, current);
    if (!opened.ok) return opened;
  }
  // Do not read the node template on the first frame that names worldmap: the map is still fading
  // and its pan/zoom is not interactive yet. Hold the map for the stable window first; the node
  // tap retry is the backstop if a frame still slips through.
  const stableMap = await settleOn(env, now);
  if (stableMap === null && env.abort?.aborted) return { ok: false, reason: 'cancelled' };

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
      return tapNodeAndWait(env, entry, centre(match, entry.anchor), now);
    }

    // Away from zoom 1.0 the node icon is drawn smaller while the label keeps its UI scale, so the
    // composite cannot match. The label band can, and the icon sits a screen-space rise above it.
    if (entry.labelBand !== undefined) {
      const band = findTemplate(image, MAP_AREA, entry.labelBand, { minScore: LABEL_FLOOR });
      if (band !== null) {
        const at = { x: band.at.x + Math.round(band.width / 2), y: band.at.y - NODE_ICON_RISE };
        if (insideMap(at)) {
          env.log?.(`wvd: ${entry.label} was matched by its label band`);
          return tapNodeAndWait(env, entry, at, now);
        }
      }
    }

    if (zooms < MAX_ZOOMS) {
      zooms += 1;
      const zoomed = await zoomWorldMap('out', env);
      if (!zoomed.ok) return zoomed;
      env.log?.(`wvd: ${entry.label} is not in view; zoomed out (${zooms}/${MAX_ZOOMS})`);
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
      const zoomed = await zoomWorldMap('in', env);
      if (!zoomed.ok) return zoomed;
      env.log?.(`wvd: zoomed in to separate ${entry.label} (${zoomsIn}/${MAX_ZOOM_INS})`);
      continue;
    }
    return { ok: false, reason: 'location-not-found', detail: `${entry.label} was not found on the map` };
  }
}

/**
 * Tap a matched node and wait for the map to leave. If the screen is still the map, the first click
 * may have been issued on a map that was still fading in (the recogniser names `worldmap` before the
 * pan/zoom is interactive); re-capture, re-match on the fresh frame, and tap once more. The retry is
 * bounded and still verifies the same thing: the screen must stop being `worldmap`.
 */
async function tapNodeAndWait(env: WorldMapEnv, entry: LocationEntry, at: Point, now: () => number): Promise<TravelResult> {
  const pressed = await env.actuator.tap(at);
  if (!pressed.ok) return failure(pressed.reason, pressed.detail);
  const left = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, now, 'location-not-found');
  if (left.ok) return { ok: true };
  if (left.reason !== 'location-not-found') return left;
  const view = await captureAndObserve(env);
  if (!view.ok) return view;
  if (view.observation.screen !== 'worldmap') return { ok: true };
  const image = await decode(view.frame);
  if (image === null) return left;
  const match = findTemplate(image, MAP_AREA, entry.template);
  let retryAt: Point | null = match === null ? null : centre(match, entry.anchor);
  if (retryAt === null && entry.labelBand !== undefined) {
    const band = findTemplate(image, MAP_AREA, entry.labelBand, { minScore: LABEL_FLOOR });
    if (band !== null) {
      const candidate = { x: band.at.x + Math.round(band.width / 2), y: band.at.y - NODE_ICON_RISE };
      if (insideMap(candidate)) retryAt = candidate;
    }
  }
  if (retryAt === null) return left;
  env.log?.(`wvd: ${entry.label} did not leave on the first tap; retrying once at ${retryAt.x},${retryAt.y}`);
  const retried = await env.actuator.tap(retryAt);
  if (!retried.ok) return failure(retried.reason, retried.detail);
  const again = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, now, 'location-not-found');
  return again.ok ? { ok: true } : again;
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
  const now = env.now ?? (() => Date.now());
  // The Dungeon Select screen is not a ScreenId, but it does settle; do not match a row on a
  // loading frame. The guard's key is the screen (unknown for this screen), so it only checks that
  // the frame has stopped changing.
  const settled = await settleOn(env, now);
  if (settled === null && env.abort?.aborted) return { ok: false, reason: 'cancelled' };
  let frame: Frame;
  if (settled !== null) {
    frame = settled.frame;
  } else {
    const current = await captureAndObserve(env);
    if (!current.ok) return current;
    frame = current.frame;
  }
  const image = await decode(frame);
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

/**
 * Wait until the current screen has held still for STABLE_HOLD_MS. A timeout is not fatal: the last
 * frame is returned so the existing tap retry can still try; a cancelled or sampler failure returns
 * null. This is the generic guard's only game-side adapter.
 */
async function settleOn(env: WorldMapEnv, now: () => number): Promise<{ frame: Frame; observation: Observation } | null> {
  const outcome = await waitStable({
    sample: async () => {
      const current = await captureAndObserve(env);
      if (!current.ok) throw new Error(current.reason);
      return { value: current, atMs: current.observation.atMs };
    },
    key: (sample) => sample.observation.screen,
    holdMs: STABLE_HOLD_MS,
    timeoutMs: STABLE_TIMEOUT_MS,
    pollMs: POLL_MS,
    wait: (ms) => env.sleep(ms),
    now,
    ...(env.abort === undefined ? {} : { abort: env.abort }),
  });
  if (outcome.stable) return outcome.value;
  if (outcome.reason === 'cancelled') return null;
  if (outcome.value !== null) {
    env.log?.(`wvd: the screen did not settle (${outcome.reason}); continuing with the last frame`);
    return outcome.value;
  }
  return null;
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

/** The map field a tap must land in; a clipped node's icon can sit outside the frame. */
function insideMap(point: Point): boolean {
  return (
    point.x >= MAP_AREA.x &&
    point.x < MAP_AREA.x + MAP_AREA.width &&
    point.y >= MAP_AREA.y &&
    point.y < MAP_AREA.y + MAP_AREA.height
  );
}

function clampToMap(point: Point): Point {
  return {
    x: Math.min(MAP_AREA.x + MAP_AREA.width - 20, Math.max(MAP_AREA.x + 20, point.x)),
    y: Math.min(MAP_AREA.y + MAP_AREA.height - 20, Math.max(MAP_AREA.y + 20, point.y)),
  };
}
