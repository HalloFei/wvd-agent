/** The pan loop is done once the place is within this of the target: half the 80 px confirmation window. */
const PAN_CONVERGED_PX = 40;
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
import { TOWN_PANEL_CHEVRON_BAND } from '../perception/location.ts';
import { LOCATIONS, type LocationEntry } from '../perception/locations.ts';
import { findTemplate, type Match, type MatchTemplate } from '../perception/match.ts';
import { capturedArt } from '../perception/site-art.ts';
import { findSite, findSites } from '../perception/site-finder.ts';
import { isClickable } from '../perception/map-ring.ts';
import { pointerAt } from '../perception/pointer.ts';
import { travelToSite, withForegroundRetry, type MapInput, type MapSenses, type MapTravelResult } from './map-travel.ts';
import { TOWN_PANEL_CHEVRON_BASE64 } from '../perception/town-template.ts';
import {
  LABEL_ANCHORS,
  MAP_PAN_GAIN,
  MAP_STRIP,
  MAP_ZOOM,
  MAP_ZOOM_KEYS,
  WORLD_MAP_SIZE,
  WORLD_MAP_SITES,
  offsetFromMatch,
  panDragFor,
  siteById,
  type WorldMapSite,
} from '../perception/worldmap-atlas.ts';
import { localiseView, worldMapAtlas, type LocaliserAtlas } from '../perception/map-localiser.ts';

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
  /**
   * Which navigator travels (operator, 2026-11-09: *make it configurable — switch between our module and
   * legacy navigation*).
   *
   * - `legacy` — the measured route: open the map, place the site with the stored atlas, pan with the
   *   drag loop, confirm the node, tap. The path that has been completing travels all night.
   * - `senses` — the new machine: find the site by its own icon (wide per-site scale bank), put the
   *   cursor on it, read the game's clickable ring, tap (actions/map-travel.ts). Finder proved live; the
   *   cursor move is not.
   *
   * Default `legacy`: a navigator earns the default by completing travels, not by being newer.
   */
  readonly navigation?: 'legacy' | 'senses';
  /**
   * Which pose source the atlas travel uses (operator, 2026-11-09: the LKMapTools shape as another
   * module, switchable, the old one kept).
   *
   * - `anchor` (default) — the banners, then the north-west pan clamp: the path that has completed
   *   every travel so far.
   * - `registration` — map-localiser.ts: the live strip placed in the stored atlas image by
   *   cross-correlation, with the zoom level **measured** instead of assumed. No zoom clamp, no
   *   banner dependence and no scale bank; the atlas pan/confirm/tap that follow are the same code.
   */
  readonly localiser?: 'anchor' | 'registration';
  /** The older spelling of `navigation: 'senses'`, for a caller that predates the switch. */
  readonly pointer?: boolean;
  /** Bring the game window back to the foreground (the travel re-takes it on a refused press). */
  readonly focus?: () => Promise<boolean>;
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
/**
 * The town page's party-panel chevron in the live client's own art, 34x26 at (679, 789) of
 * `testdata/screens/2026-11-07-town-live/town-1920.jpg` and drawn 1:1 by this client
 * (`src/perception/town-template.ts`; the band is the perceiver's, `TOWN_PANEL_CHEVRON_BAND` —
 * the tile is only found at 1:1 inside it, measured 1.000 here and 0.943-0.956 on the six town
 * frames recorded 2026-10-25). The legacy mobile art in PANEL_BAND is the second chance: on this
 * camera it scores 0.600, below the 0.8 floor.
 */
const TOWN_PANEL_CHEVRON: MatchTemplate = {
  width: 34,
  height: 26,
  gray: Uint8Array.from(Buffer.from(TOWN_PANEL_CHEVRON_BASE64, 'base64')),
};
/** The live tile's own scale; it is not resized by this client. */
const LIVE_CHEVRON_SCALES = [1] as const;
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
    const chevron = findTemplate(image, TOWN_PANEL_CHEVRON_BAND, TOWN_PANEL_CHEVRON, { scales: LIVE_CHEVRON_SCALES })
      ?? findTemplate(image, PANEL_BAND, LOCATIONS.get('panel-chevron')!.template, { scales: CONTROL_SCALES });
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
// The atlas (src/perception/worldmap-atlas.ts) knows every catalogued site's coordinate and the
// label banners the game draws at max zoom-out. A travel is: open the map, clamp the zoom out,
// locate the view from the banners — or, when none is drawn, from the pan clamp at the map's
// north-west corner — pan the site near the aim point at max zoom-out, zoom in, confirm the node's
// own icon at the projected point, and tap. The atlas says where to look; the frame decides
// everything that can be wrong.
//
// Measured 2026-11-01, and each one shapes a parameter below:
//
// - the old park point (200,540) is a map control that slides the view ~270 px over 750 ms;
//   (200,120) and (200,960) are inert, and a measurement must be taken on a still frame;
// - zoom is anchored on the view centre: a point at the centre stays, every other point moves away
//   from it by 1.34x per step, which is the prediction this file uses;
// - a drag moves the map ~2.2 px per pointer px at max zoom-out and is ignored at max zoom-in, so
//   all panning happens at max zoom-out;
// - 5-6 of the 8 banners match in one frame and agree within 6 px: one frame is enough to locate;
// - the game culls colliding labels (北穿幽冥城 has none at max zoom-out) and a node whose label is
//   culled does not take the tap — hence the zoom-in before the tap.
// ------------------------------------------------------------------------------------------------

/** A label banner scores far above this at max zoom-out; measured 0.93-0.99 on the live frames. */
const ATLAS_LABEL_FLOOR = 0.8;
/** The node icon, drawn at ~0.45 of the legacy art at max zoom-out; the sweep covers the measured range. */
const ATLAS_ICON_SCALES = [0.40, 0.42, 0.44, 0.46, 0.48, 0.50] as const;
const ATLAS_ICON_FLOOR = 0.75;
/** An icon used as an *anchor* must score higher than one merely confirmed near a prediction. */
const ATLAS_ICON_ANCHOR_FLOOR = 0.82;
/** The registration floor: the recorded frames score 0.45-0.81 against the stitched atlas. */
const REGISTRATION_FLOOR = 0.45;
const ATLAS_ICON_ANCHOR_SCALES = [0.42, 0.45, 0.48] as const;
/** Where the legacy art's label band starts, as a fraction of its height (locations.ts's rule). */
const LEGACY_LABEL_BAND_TOP = 0.687;
const ATLAS_ZOOM_PRESSES = 8;
const ATLAS_ZOOM_SETTLE_MS = 420;
/** Where a tap is safe, in strip pixels: the parchment, clear of the pillars and the bottom band. */
const ATLAS_TAP_AREA = { x: 12, y: 30, width: MAP_STRIP.width - 24, height: 870 } as const;
/** The point the placement aims at: the middle of the tap area, not the strip's centre. */
const ATLAS_AIM: Point = { x: ATLAS_TAP_AREA.x + ATLAS_TAP_AREA.width / 2, y: ATLAS_TAP_AREA.y + ATLAS_TAP_AREA.height / 2 };

/** A point on the stored map, or a catalogued site that names one. */
export type AtlasTarget =
  | { readonly kind: 'site'; readonly id: string }
  | {
      readonly kind: 'point';
      readonly x: number;
      readonly y: number;
      readonly label?: string;
      readonly templateId?: string;
    };

/** How a view of unknown position is placed before the pan. */
export type AtlasLocator = 'anchor' | 'clamp' | 'anchor-then-clamp' | 'registration';

/** What has to match at the projected point before a tap is sent. */
export type AtlasConfirm = 'icon' | 'label' | 'either' | 'none';

/** How far to zoom in: auto climbs one step at a time, max goes straight to the clamp. */
export type AtlasZoom = 'none' | 'in' | number | 'max' | 'auto';

export interface AtlasTiming {
  readonly zoomSettleMs: number;
  readonly dragSettleMs: number;
  readonly parkSettleMs: number;
}

export interface AtlasPolicy {
  /**
   * Optional pointer refuge. Default null: every pillar point tried (200,540), (200,120), (200,20),
   * (1720,20) moved the map by 14-270 px on a tap (measured 2026-11-01), so the pointer is left where
   * the pan drag ended instead, and the drag is aimed away from the target.
   */
  readonly parkPoint: Point | null;
  /** One drag's pointer displacement; also the clamp's step. */
  readonly dragStepPx: number;
  /** Only the first guess: the pan loop measures the gain after every drag and adapts (it ranged 0.3-2.5 live). */
  readonly panGain: number;
  /** Drags allowed before the north-west clamp is declared reached. */
  readonly clampDrags: number;
  /** Half-size of the window the confirmation searches around the projected point. */
  readonly verifyRadiusPx: number;
}

export interface AtlasTravelOptions {
  /** What must confirm at the projected point. Default icon. */
  readonly confirm?: AtlasConfirm;
  /** The icon template; defaults to the site's own templateId. */
  readonly templateId?: string;
  /** Confirmation floor. Default 0.75 (the icon floor). */
  readonly minScore?: number;
  /**
   * Half-size of the confirmation window, strip px. Default 180: the node art is anchored at the
   * node point, not centred on it, so the icon drawn at max zoom-in sits tens of px from the
   * atlas coordinate (the screenshot of the first successful zoom put 北穿 near y 193, not 119).
   */
  readonly windowPx?: number;
  /** Pin the locator to one banner (the 诺森霍洛村 relay); default: any banner. */
  readonly anchor?: string;
  /** How an unknown view is placed. Default anchor-then-clamp. */
  readonly locate?: AtlasLocator;
  /** Zoom plan. Default max — the tap is taken at the zoom where the label is drawn. */
  readonly zoom?: AtlasZoom;
  /** Pan corrections before giving up. Default 3. */
  readonly maxCorrections?: number;
  readonly timing?: Partial<AtlasTiming>;
  readonly policy?: Partial<AtlasPolicy>;
  /** Return the measurements. */
  readonly trace?: boolean;
  /**
   * The registration atlas, when the caller hands one in (a test at reduced resolution, or a host
   * that preloads it). Default: the committed atlas, built once per session.
   */
  readonly localiserAtlas?: LocaliserAtlas;
}

export interface AtlasTrace {
  readonly target: Point;
  readonly located?: {
    readonly by: 'anchor' | 'clamp' | 'registration';
    readonly anchor?: string;
    readonly offset: Point;
    readonly anchors?: number;
    readonly spreadPx?: number;
  };
  readonly placed?: { readonly offset: Point; readonly level: number; readonly predicted: Point };
  readonly corrections: number;
  readonly zooms: number;
  readonly confirmed?: { readonly by: 'icon' | 'label'; readonly score: number; readonly scale: number };
  readonly tapped?: Point;
}

export type AtlasTravelResult =
  | { readonly ok: true; readonly trace?: AtlasTrace }
  | { readonly ok: false; readonly reason: TravelReason; readonly detail?: string; readonly trace?: AtlasTrace };

const ATLAS_TIMING: AtlasTiming = { zoomSettleMs: ATLAS_ZOOM_SETTLE_MS, dragSettleMs: 300, parkSettleMs: 240 };
const ATLAS_POLICY: AtlasPolicy = {
  parkPoint: null,
  dragStepPx: 320,
  panGain: 1,
  clampDrags: 8,
  verifyRadiusPx: 180,
};

function clampNumber(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Strip coordinates a map point occupies at a zoom level, given the max-out offset. */
function placementAt(point: Point, offset: Point, level: number): Point {
  const factor = Math.pow(MAP_ZOOM.stepScale, level);
  const centre = { x: MAP_STRIP.width / 2, y: MAP_STRIP.height / 2 };
  return {
    x: Math.round(centre.x + factor * (point.x - offset.x - centre.x)),
    y: Math.round(centre.y + factor * (point.y - offset.y - centre.y)),
  };
}

/** The offset that puts the point on the aim point when the view is zoomed to the level. */
function offsetThatAims(point: Point, level: number): Point {
  const factor = Math.pow(MAP_ZOOM.stepScale, level);
  const centre = { x: MAP_STRIP.width / 2, y: MAP_STRIP.height / 2 };
  const before = {
    x: centre.x + (ATLAS_AIM.x - centre.x) / factor,
    y: centre.y + (ATLAS_AIM.y - centre.y) / factor,
  };
  return {
    x: clampNumber(Math.round(point.x - before.x), 0, WORLD_MAP_SIZE.width - MAP_STRIP.width),
    y: clampNumber(Math.round(point.y - before.y), 0, WORLD_MAP_SIZE.height - MAP_STRIP.height),
  };
}

/**
 * The offset that aims the point at the tap area when the pan happens **at that zoom level**.
 * `offsetThatAims` clamps to [0, W - strip] because the legacy path pans at max zoom-out; a
 * registration pan happens at the zoom it measured, where the reachable offsets span
 * `-C(1 - 1/f) .. W - strip/f - C(1 - 1/f)`.
 */
function offsetThatAimsLevel(point: Point, level: number): Point {
  const factor = Math.pow(MAP_ZOOM.stepScale, level);
  const centre = { x: MAP_STRIP.width / 2, y: MAP_STRIP.height / 2 };
  const before = {
    x: centre.x + (ATLAS_AIM.x - centre.x) / factor,
    y: centre.y + (ATLAS_AIM.y - centre.y) / factor,
  };
  const low = { x: -centre.x * (1 - 1 / factor), y: -centre.y * (1 - 1 / factor) };
  const high = {
    x: WORLD_MAP_SIZE.width - MAP_STRIP.width / factor - centre.x * (1 - 1 / factor),
    y: WORLD_MAP_SIZE.height - MAP_STRIP.height / factor - centre.y * (1 - 1 / factor),
  };
  return {
    x: clampNumber(Math.round(point.x - before.x), Math.min(low.x, high.x), Math.max(low.x, high.x)),
    y: clampNumber(Math.round(point.y - before.y), Math.min(low.y, high.y), Math.max(low.y, high.y)),
  };
}

function insideAtlasTap(point: Point): boolean {
  return point.x >= ATLAS_TAP_AREA.x
    && point.x <= ATLAS_TAP_AREA.x + ATLAS_TAP_AREA.width
    && point.y >= ATLAS_TAP_AREA.y
    && point.y <= ATLAS_TAP_AREA.y + ATLAS_TAP_AREA.height;
}

/** The highest zoom level at which the point still lands in the tap area. */
function chooseLevel(point: Point, limit: number): number {
  for (let level = limit; level >= 1; level -= 1) {
    if (insideAtlasTap(placementAt(point, offsetThatAims(point, level), level))) return level;
  }
  return 0;
}

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

/** One 放大 press, verified against the strip signature; a press that changed nothing is retried. */
async function zoomInOneStep(env: WorldMapEnv, timing: AtlasTiming, log?: (line: string) => void): Promise<TravelResult> {
  let previous: Float64Array | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (previous === null) {
      const before = await captureAndObserve(env);
      if (!before.ok) return before;
      const image = await decode(before.frame);
      if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
      previous = stripSignature(image);
    }
    const sent = await env.actuator.holdKey(MAP_ZOOM_KEYS.in, PRESS_MS);
    if (!sent.ok) return failure(sent.reason, sent.detail);
    await pause(env, timing.zoomSettleMs);
    const view = await captureAndObserve(env);
    if (!view.ok) return view;
    if (view.observation.screen !== 'worldmap') {
      return { ok: false, reason: 'location-not-found', detail: 'the map closed while zooming in' };
    }
    const image = await decode(view.frame);
    if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
    const signature = stripSignature(image);
    if (signatureDiff(previous, signature) >= 0.6) return { ok: true };
    previous = signature;
    log?.('wvd: the zoom press changed nothing; repeating it');
  }
  return { ok: true };
}

/**
 * Zoom out to the map's own clamp. The game has no zoom readout, so the clamp is the zoom state:
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
 * Pan the content right and down until the map refuses to move: the view is then at the map's
 * north-west corner, which is atlas (0,0) — verified on the saved corner frame (5 banners, 0 px
 * spread). A clamp is exact whatever the drag gain does, which is why it is the fallback locator.
 */
async function clampToNorthWest(env: WorldMapEnv, policy: AtlasPolicy, timing: AtlasTiming, log?: (line: string) => void): Promise<TravelResult> {
  const from = { x: 760, y: 420 };
  const to = { x: 760 + policy.dragStepPx, y: 420 + policy.dragStepPx };
  let previous: Float64Array | null = null;
  for (let drag = 0; drag < policy.clampDrags; drag += 1) {
    const sent = await env.actuator.drag(from, to, 300);
    if (!sent.ok) return failure(sent.reason, sent.detail);
    await pause(env, timing.dragSettleMs);
    const view = await captureAndObserve(env);
    if (!view.ok) return view;
    if (view.observation.screen !== 'worldmap') {
      return { ok: false, reason: 'location-not-found', detail: 'the map closed while clamping' };
    }
    const image = await decode(view.frame);
    if (image === null) return { ok: false, reason: 'unavailable', detail: 'frame did not decode' };
    const signature = stripSignature(image);
    if (previous !== null && signatureDiff(previous, signature) < 0.6) {
      log?.('wvd: the view is at the map north-west corner after ' + (drag + 1) + ' drags');
      return { ok: true };
    }
    previous = signature;
  }
  return { ok: true };
}

/**
 * The view's atlas offset from the label banners in one frame: every banner whose atlas rectangle is
 * known votes, and the largest cluster within 6 px wins. Null when none is drawn.
 */
function locateView(image: RgbaImage, anchorId?: string): { offset: Point; anchor: string; anchors: number; spreadPx: number } | null {
  const votes: { id: string; x: number; y: number }[] = [];
  for (const anchor of LABEL_ANCHORS) {
    if (anchorId !== undefined && anchor.id !== anchorId) continue;
    const match = findTemplate(image, MAP_STRIP, anchor.template, { scales: [1], minScore: ATLAS_LABEL_FLOOR });
    if (match === null) continue;
    const offset = offsetFromMatch(anchor, { x: match.at.x - MAP_STRIP.x, y: match.at.y });
    votes.push({ id: anchor.id, x: offset.x, y: offset.y });
  }
  // The node icons are drawn at every zoom, labels are not: at max zoom-out the game culls colliding
  // banners (北穿幽冥城 has none), and the icon is then the only absolute anchor in the frame.
  for (const site of WORLD_MAP_SITES) {
    if (site.templateId === undefined) continue;
    if (anchorId !== undefined && site.id !== anchorId) continue;
    const template = iconTemplateFor(site.templateId);
    if (template === null) continue;
    const match = findTemplate(image, MAP_STRIP, template, { scales: ATLAS_ICON_ANCHOR_SCALES, minScore: ATLAS_ICON_ANCHOR_FLOOR });
    if (match === null) continue;
    const centre = {
      x: match.at.x + Math.round(match.width / 2) - MAP_STRIP.x,
      y: match.at.y + Math.round(match.height / 2),
    };
    votes.push({ id: site.id, x: site.x - centre.x, y: site.y - centre.y });
  }
  if (votes.length === 0) return null;
  let best = votes;
  for (const vote of votes) {
    const group = votes.filter((other) => Math.abs(other.x - vote.x) <= 6 && Math.abs(other.y - vote.y) <= 6);
    if (group.length > best.length) best = group;
  }
  const x = Math.round(best.reduce((sum, vote) => sum + vote.x, 0) / best.length);
  const y = Math.round(best.reduce((sum, vote) => sum + vote.y, 0) / best.length);
  const spreadPx = Math.max(...best.map((vote) => Math.max(Math.abs(vote.x - x), Math.abs(vote.y - y))));
  return { offset: { x, y }, anchor: best[0]!.id, anchors: best.length, spreadPx };
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
 * The icon's drawn scale at a zoom level: ~0.45 of the legacy art at max-out, 1.34x per step, with a
 * +-15% sweep. Measured live: 0.917 at scale 0.96 on the max zoom-in frame.
 */
function iconScalesAt(level: number): number[] {
  // **Measured on a live level-1 frame, 2026-11-09 02:00**: ffxi-gcn's icon matches at scale **0.90**
  // (score 0.993), and nowhere in the old 0.51-0.69 bank. That is why the two live runs found nothing:
  // the basis below used to be 0.45 — the *atlas stills'* art — which is about half the live scale. The
  // ladder is the same 1.34 step, anchored on the measurement instead of on the stills.
  // Back to the atlas's own basis (0.45 at max-out): this ladder serves the **legacy** atlas path, whose
  // fixtures and live confirms are measured against it. The senses have their own wide bank
  // (`ICON_SCALES_ANY`), because one ladder cannot serve every site's template size.
  const centre = 0.45 * Math.pow(MAP_ZOOM.stepScale, level);
  return [0.85, 0.92, 1, 1.08, 1.15].map((fraction) => Math.round(centre * fraction * 100) / 100);
}

/** The banner's drawn scale at a zoom level (screen-space art scaled with the map). */
function labelScalesAt(level: number): number[] {
  const factor = Math.pow(MAP_ZOOM.stepScale, level);
  return [0.94, 1, 1.06].map((scale) => Math.round(factor * scale * 100) / 100);
}

interface ConfirmSpec {
  readonly by: AtlasConfirm;
  readonly templateId: string | null;
  readonly minScore: number;
  readonly windowPx: number;
  readonly site: WorldMapSite | null;
}

interface Confirmed {
  readonly point: Point;
  readonly by: 'icon' | 'label';
  readonly score: number;
  readonly scale: number;
}

/**
 * Confirm the node at the projected point and return its tap point in strip coordinates. The icon
 * is checked first (it is drawn at every zoom); the label is the fallback and is placed relative to
 * the icon through the atlas band, scaled by the level.
 */
function confirmAt(image: RgbaImage, level: number, projected: Point, spec: ConfirmSpec): Confirmed | null {
  if (spec.by === 'none') return { point: projected, by: 'icon', score: 1, scale: 1 };
  const radius = spec.windowPx;
  if (spec.by !== 'label' && spec.templateId !== null) {
    const template = iconTemplateFor(spec.templateId);
    if (template !== null) {
      const area = { x: MAP_STRIP.x + projected.x - radius, y: projected.y - radius, width: radius * 2, height: radius * 2 };
      const match = findTemplate(image, area, template, { scales: iconScalesAt(level), minScore: spec.minScore });
      if (match !== null) {
        return {
          point: { x: match.at.x + Math.round(match.width / 2) - MAP_STRIP.x, y: match.at.y + Math.round(match.height / 2) },
          by: 'icon',
          score: match.score,
          scale: match.scale,
        };
      }
    }
  }
  const site = spec.site;
  if (spec.by !== 'icon' && site !== null && site.labelBand !== undefined) {
    const anchor = LABEL_ANCHORS.find((candidate) => candidate.id === site.id);
    if (anchor !== undefined) {
      const factor = Math.pow(MAP_ZOOM.stepScale, level);
      const band = site.labelBand;
      const at = {
        x: Math.round(projected.x + factor * (band.x - site.x)),
        y: Math.round(projected.y + factor * (band.y - site.y)),
      };
      const area = { x: MAP_STRIP.x + at.x - radius, y: at.y - radius, width: radius * 2, height: radius * 2 };
      const match = findTemplate(image, area, anchor.template, { scales: labelScalesAt(level), minScore: ATLAS_LABEL_FLOOR });
      if (match !== null) {
        const topLeft = { x: match.at.x - MAP_STRIP.x, y: match.at.y };
        return {
          point: {
            x: Math.round(topLeft.x + factor * (site.x - band.x)),
            y: Math.round(topLeft.y + factor * (site.y - band.y)),
          },
          by: 'label',
          score: match.score,
          scale: match.scale,
        };
      }
    }
  }
  return null;
}

interface MapView {
  readonly ok: true;
  readonly image: RgbaImage;
}
interface MapViewFailure {
  readonly ok: false;
  readonly failure: TravelResult;
}

/** Let the map settle and hand back the decoded strip. No tap: every pillar point pans it. */
async function lookAtMap(env: WorldMapEnv, policy: AtlasPolicy, timing: AtlasTiming): Promise<MapView | MapViewFailure> {
  if (policy.parkPoint !== null) {
    const parked = await env.actuator.tap(policy.parkPoint);
    if (!parked.ok) return { ok: false, failure: failure(parked.reason, parked.detail) };
  }
  await pause(env, timing.parkSettleMs);
  const view = await captureAndObserve(env);
  if (!view.ok) return { ok: false, failure: view };
  if (view.observation.screen !== 'worldmap') {
    return { ok: false, failure: { ok: false, reason: 'location-not-found', detail: 'the map closed while placing the site' } };
  }
  const image = await decode(view.frame);
  if (image === null) return { ok: false, failure: { ok: false, reason: 'unavailable', detail: 'frame did not decode' } };
  return { ok: true, image };
}

function resolveAtlasTarget(target: AtlasTarget): { point: Point; site: WorldMapSite | null } | null {
  if (target.kind === 'point') return { point: { x: target.x, y: target.y }, site: null };
  const site = siteById(target.id);
  return site === null ? null : { point: { x: site.x, y: site.y }, site };
}

function zoomLimitFor(zoom: AtlasZoom | undefined): number {
  if (zoom === 'none') return 0;
  if (zoom === 'in') return Math.min(1, MAP_ZOOM.steps);
  if (typeof zoom === 'number') return clampNumber(Math.round(zoom), 0, MAP_ZOOM.steps);
  return MAP_ZOOM.steps;
}

/**
 * Travel to a stored coordinate: open the map, clamp the zoom out, locate the view, pan the site to
 * the aim point, zoom in, confirm the node, tap it, and wait until the map is gone.
 */
export async function travelViaAtlas(
  target: AtlasTarget,
  env: WorldMapEnv,
  options: AtlasTravelOptions = {},
): Promise<AtlasTravelResult> {
  const resolved = resolveAtlasTarget(target);
  if (resolved === null) {
    return { ok: false, reason: 'unknown-location', detail: target.kind === 'site' ? target.id : 'point' };
  }
  const policy: AtlasPolicy = { ...ATLAS_POLICY, ...options.policy };
  const timing: AtlasTiming = { ...ATLAS_TIMING, ...options.timing };
  const trace: {
    target: Point;
    corrections: number;
    zooms: number;
    located?: AtlasTrace['located'];
    placed?: AtlasTrace['placed'];
    confirmed?: AtlasTrace['confirmed'];
    tapped?: Point;
  } = { target: resolved.point, corrections: 0, zooms: 0 };
  const finish = (result: TravelResult): AtlasTravelResult => {
    const carried: AtlasTrace | undefined = options.trace === true ? { ...trace } : undefined;
    return result.ok
      ? { ok: true, trace: carried }
      : { ok: false, reason: result.reason, detail: result.detail, trace: carried };
  };
  const spec: ConfirmSpec = {
    by: options.confirm ?? 'icon',
    templateId: options.templateId ?? resolved.site?.templateId ?? (target.kind === 'point' ? target.templateId ?? null : null),
    minScore: options.minScore ?? ATLAS_ICON_FLOOR,
    windowPx: options.windowPx ?? policy.verifyRadiusPx,
    site: resolved.site,
  };

  const opened = await openWorldMap(env);
  if (!opened.ok) return finish(opened);
  const byRegistration = (options.locate ?? 'anchor-then-clamp') === 'registration';
  const registrationAtlas = byRegistration ? (options.localiserAtlas ?? worldMapAtlas()) : null;

  /**
   * The registration pose in the atlas's own frame: `offset` is the max-zoom-out offset the pan
   * loop and placementAt/offsetThatAims speak, and `level` re-expresses the measured factor on the
   * atlas's own scale (0.45 * 1.34^level = 0.45 * factor) so the icon scale bank stays right.
   */
  const register = (image: RgbaImage, prior?: { offset: Point; level: number }, windowPx = 320) => {
    if (registrationAtlas === null) return null;
    const pose = localiseView(image, registrationAtlas, {
      ...(prior === undefined ? {} : { prior, windowPx }),
      minScore: REGISTRATION_FLOOR,
    });
    if (pose === null) return null;
    const shift = {
      x: (MAP_STRIP.width / 2) * (1 - 1 / pose.factor),
      y: (MAP_STRIP.height / 2) * (1 - 1 / pose.factor),
    };
    return {
      pose,
      offset: { x: Math.round(pose.origin.x - shift.x), y: Math.round(pose.origin.y - shift.y) },
      level: Math.min(MAP_ZOOM.steps + 0.25, Math.max(0, Math.log(pose.factor) / Math.log(MAP_ZOOM.stepScale))),
    };
  };

  // 1. Where is the view? Registration measures the pose outright — no zoom clamp, no banners — and
  //    the level it reports replaces chooseLevel's plan. The legacy locator reads the banners, with
  //    the north-west pan clamp as its fallback, after clamping the zoom to max-out.
  let offset: Point;
  let level: number;
  let locatedByClamp = false;
  if (byRegistration) {
    const first = await lookAtMap(env, policy, timing);
    if (!first.ok) return finish(first.failure);
    let registered = register(first.image);
    if (registered === null) {
      return finish({ ok: false, reason: 'location-not-found', detail: 'the atlas did not register (floor ' + REGISTRATION_FLOOR + ')' });
    }
    // Registration reads a pose at any zoom, but the **pan** only works at max zoom-out: at max
    // zoom-in a drag is ignored and a drag that starts on a node is read as a click (live
    // 2026-11-09 21:52: the travel started at max-in and the first pan opened the inn). So clamp the
    // zoom out first, and verify every press by re-reading the level — the luma signature cannot
    // tell a swallowed press from the clamp, the localiser can.
    for (let press = 0; press < MAP_ZOOM.steps && registered.pose.level > 0; press += 1) {
      const before = registered.pose.level;
      const sent = await env.actuator.holdKey(MAP_ZOOM_KEYS.out, PRESS_MS);
      if (!sent.ok) return finish(failure(sent.reason, sent.detail));
      await pause(env, ATLAS_ZOOM_SETTLE_MS);
      const view = await lookAtMap(env, policy, timing);
      if (!view.ok) return finish(view.failure);
      const next = register(view.image, { offset: registered.offset, level: Math.max(0, before - 1) }, 640);
      if (next === null) {
        return finish({ ok: false, reason: 'location-not-found', detail: 'the atlas did not register after a zoom-out press' });
      }
      if (next.pose.level >= before) {
        return finish({ ok: false, reason: 'location-not-found', detail: 'the zoom-out press did not change the level (still ' + before + ')' });
      }
      registered = next;
    }
    offset = registered.offset;
    level = registered.level;
    trace.located = { by: 'registration', offset };
    env.log?.('wvd: registration located the view at ' + registered.pose.origin.x + ',' + registered.pose.origin.y
      + ' (level ' + registered.pose.level + ', factor ' + registered.pose.factor.toFixed(2)
      + ', score ' + registered.pose.score.toFixed(3) + ')');
  } else {
    const clamped = await zoomToMaxOut(env);
    if (!clamped.ok) return finish(clamped);
    const first = await lookAtMap(env, policy, timing);
    if (!first.ok) return finish(first.failure);
    const located = locateView(first.image, options.anchor);
    if (located !== null) {
      offset = located.offset;
      trace.located = { by: 'anchor', anchor: located.anchor, offset: located.offset, anchors: located.anchors, spreadPx: located.spreadPx };
      env.log?.('wvd: atlas located by ' + located.anchor + ' at ' + located.offset.x + ',' + located.offset.y
        + ' (' + located.anchors + ' anchors, spread ' + located.spreadPx + ' px)');
    } else if ((options.locate ?? 'anchor-then-clamp') === 'anchor') {
      return finish({ ok: false, reason: 'location-not-found', detail: 'no atlas label was in view' });
    } else {
      const corner = await clampToNorthWest(env, policy, timing, env.log);
      if (!corner.ok) return finish(corner);
      offset = { x: 0, y: 0 };
      locatedByClamp = true;
      trace.located = { by: 'clamp', offset };
    }
    // 2. Plan: the highest level the placement can still put inside the tap area.
    level = chooseLevel(resolved.point, zoomLimitFor(options.zoom));
  }
  const desired = byRegistration ? offsetThatAimsLevel(resolved.point, level) : offsetThatAims(resolved.point, level);
  let predicted = placementAt(resolved.point, desired, level);
  trace.placed = { offset: desired, level, predicted };

  // 3. Pan at max zoom-out: drag, measure the view again, and learn the gain from what actually
  //    moved. The gain is not a constant (0.32 horizontally and 1.72 vertically on one live run,
  //    2.2 on another), so a fixed constant would overshoot or crawl.
  let gainX = policy.panGain;
  let gainY = policy.panGain;
  const corrections = options.maxCorrections ?? 8;
  for (let step = 0; ; step += 1) {
    if (env.abort?.aborted) return finish({ ok: false, reason: 'cancelled' });
    const deltaX = desired.x - offset.x;
    const deltaY = desired.y - offset.y;
    // 16 atlas px is 38 strip px at max zoom-in — well inside the 80 px confirmation window.
    // The confirmation looks in an 80 px window (see the comment above), so a place within half of it is
    // a place: a 16 px tolerance made the loop chase a delta the pointer clamp cannot deliver and it
    // limit-cycled at ~14 px forever (live 2026-11-07 23:02: asked +15, moved -2, asked +14, moved -13).
    if (Math.abs(deltaX) <= PAN_CONVERGED_PX && Math.abs(deltaY) <= PAN_CONVERGED_PX) break;
    if (step >= corrections) {
      return finish({ ok: false, reason: 'location-not-found', detail: 'the map stayed ' + deltaX + ',' + deltaY + ' px from the planned offset' });
    }
    const drag = {
      x: clampNumber(Math.round(-deltaX / Math.max(0.15, gainX)), -policy.dragStepPx, policy.dragStepPx),
      y: clampNumber(Math.round(-deltaY / Math.max(0.15, gainY)), -policy.dragStepPx, policy.dragStepPx),
    };
    // Leave the pointer away from the projected target: the cursor is drawn into the frame and the
    // confirmation looks in an 80 px window around it.
    // Both ends stay inside the strip: a drag that starts on the black pillar is ignored (measured —
    // three such drags moved the map 13, 0 and 0 px). The pointer ends on the side the drag travels
    // toward, which is the side away from the target for the pan that brings the target in.
    const end = {
      x: drag.x >= 0 ? MAP_STRIP.x + MAP_STRIP.width - 40 : MAP_STRIP.x + 40,
      y: drag.y >= 0 ? 960 : 60,
    };
    const start = {
      x: clampNumber(end.x - drag.x, MAP_STRIP.x + 20, MAP_STRIP.x + MAP_STRIP.width - 20),
      y: clampNumber(end.y - drag.y, 20, 1_040),
    };
    const actual = { x: end.x - start.x, y: end.y - start.y };
    drag.x = actual.x;
    drag.y = actual.y;
    env.log?.('wvd: panning ' + drag.x + ',' + drag.y + ' to place ' + (resolved.site?.id ?? 'the point'));
    const sent = await env.actuator.drag(start, end, 300);
    if (!sent.ok) return finish(failure(sent.reason, sent.detail));
    await pause(env, timing.dragSettleMs);
    trace.corrections += 1;
    const again = await lookAtMap(env, policy, timing);
    if (!again.ok) return finish(again.failure);
    const relocated = byRegistration
      ? (() => {
        // A drag's reach is dragStepPx * the pan gain (~320 x 2.2 = 700 atlas px): the prior's
        // window must cover it, or the constrained search loses the pose it was meant to track.
        const next = register(again.image, { offset, level: Math.round(level) }, 900);
        return next === null ? null : { offset: next.offset };
      })()
      : locateView(again.image, options.anchor);
    if (relocated === null && locatedByClamp) {
      // Nothing legible in the new view and the only fix already applied: dead-reckon the drag, and
      // let the confirmation refuse the tap if the estimate was wrong.
      offset = {
        x: clampNumber(Math.round(offset.x - drag.x * gainX), 0, WORLD_MAP_SIZE.width - MAP_STRIP.width),
        y: clampNumber(Math.round(offset.y - drag.y * gainY), 0, WORLD_MAP_SIZE.height - MAP_STRIP.height),
      };
    } else if (relocated === null) {
      const corner = await clampToNorthWest(env, policy, timing, env.log);
      if (!corner.ok) return finish(corner);
      offset = { x: 0, y: 0 };
      locatedByClamp = true;
    } else {
      const before = offset;
      offset = relocated.offset;
      const movedX = offset.x - before.x;
      const movedY = offset.y - before.y;
      // offset moves against the pointer, so the gain is -moved/drag. A sample that started or ended
      // on a pan clamp is a truncated move and says nothing about the gain — the live run read 2.28
      // from one that had hit the corner, which then overshot on the next drag.
      const edge = (value: number, limit: number): boolean => value <= 1 || value >= limit - 1;
      const maxX = WORLD_MAP_SIZE.width - MAP_STRIP.width;
      const maxY = WORLD_MAP_SIZE.height - MAP_STRIP.height;
      if (Math.abs(drag.x) >= 30 && Math.abs(movedX) >= 4 && !edge(before.x, maxX) && !edge(offset.x, maxX)) {
        gainX = clampNumber(-movedX / drag.x, 0.15, 6);
      }
      if (Math.abs(drag.y) >= 30 && Math.abs(movedY) >= 4 && !edge(before.y, maxY) && !edge(offset.y, maxY)) {
        gainY = clampNumber(-movedY / drag.y, 0.15, 6);
      }
      env.log?.('wvd: pan moved ' + movedX + ',' + movedY + ' for a ' + drag.x + ',' + drag.y + ' px drag (gain '
        + gainX.toFixed(2) + ',' + gainY.toFixed(2) + ')');
    }
  }

  // The pan is done at max zoom-out and the tap one step in, where a culled-label node takes the
  // click. Registration measured the level it started at, so it can re-measure the one it just
  // zoomed to and reproject the node for it, instead of confirming against a plan made at 0.
  if (byRegistration) {
    const zoomed = await zoomInOneStep(env, timing, env.log);
    if (!zoomed.ok) return finish(zoomed);
    const view = await lookAtMap(env, policy, timing);
    if (!view.ok) return finish(view.failure);
    const again = register(view.image, { offset, level: 1 }, 640);
    if (again === null) {
      return finish({ ok: false, reason: 'location-not-found', detail: 'the atlas did not register after zooming in to tap' });
    }
    offset = again.offset;
    level = again.level;
    predicted = placementAt(resolved.point, offset, level);
    env.log?.('wvd: registration re-read the view at ' + again.pose.origin.x + ',' + again.pose.origin.y
      + ' (level ' + again.pose.level + ', factor ' + again.pose.factor.toFixed(2)
      + ', score ' + again.pose.score.toFixed(3) + ') before the tap');
  }

  // 4. Zoom to the planned level and confirm the node at the projected point. Each press is checked:
  //    a swallowed E leaves the map at the previous level and the icon then matches at the wrong scale.
  // The node may already be visible at the zoom the map opened at: confirm first, and zoom only when it
  // is not. (Operator, 2026-11-07: *if the target location is already visible, then there needs to be no
  // zoom in or out, just locate the target and tap.*)
  let levelNow = byRegistration ? level : 0;
  let view = await lookAtMap(env, policy, timing);
  if (!view.ok) return finish(view.failure);
  let confirmed = confirmAt(view.image, levelNow, predicted, spec);
  while (confirmed === null && levelNow < level) {
    const zoomed = await zoomInOneStep(env, timing, env.log);
    if (!zoomed.ok) return finish(zoomed);
    levelNow += 1;
    trace.zooms += 1;
    view = await lookAtMap(env, policy, timing);
    if (!view.ok) return finish(view.failure);
    confirmed = confirmAt(view.image, levelNow, predicted, spec);
  }
  if (confirmed === null) {
    return finish({
      ok: false,
      reason: 'location-not-found',
      detail: (resolved.site?.label ?? (target.kind === 'point' ? target.label ?? 'the point' : target.id))
        + ' did not confirm at ' + predicted.x + ',' + predicted.y + ' (zoom ' + levelNow + ')',
    });
  }
  trace.confirmed = { by: confirmed.by, score: confirmed.score, scale: confirmed.scale };
  const tapPoint = { x: MAP_STRIP.x + confirmed.point.x, y: confirmed.point.y };
  trace.tapped = tapPoint;
  env.log?.('wvd: tapping ' + (resolved.site?.id ?? 'the point') + ' at ' + tapPoint.x + ',' + tapPoint.y
    + ' (' + confirmed.by + ' ' + confirmed.score.toFixed(3) + ' @ ' + confirmed.scale + ')');
  const pressed = await env.actuator.tap(tapPoint);
  if (!pressed.ok) return finish(failure(pressed.reason, pressed.detail));
  const left = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, env.now ?? (() => Date.now()), 'location-not-found');
  if (!left.ok) return finish(left);
  return finish({ ok: true });
}

/**
 * Travel to one catalogued node: open the map, match the node, tap it, and wait until the map is
 * gone. Zoom out up to three times and pan in eight directions before giving up.
 */
/** WASD scan codes for the pointer, and the map's own zoom keys (Q in, E out). */
const POINTER_KEYS: Readonly<Record<'w' | 'a' | 's' | 'd', number>> = { w: 0x11, a: 0x1e, s: 0x1f, d: 0x20 };
const ZOOM_KEY_IN = 0x10;
const ZOOM_KEY_OUT = 0x12;

/**
 * The bank the senses search at. **One ladder cannot serve every site**: each catalogue template has its
 * own native size, so the same drawn icon matches at a different scale per site — measured live
 * 2026-11-09: vnh at ~0.45-0.5, ffxi-gcn at 0.90. A per-level ladder therefore misses whichever sites do
 * not happen to fit it, which is why the level-1 travels found neither the target nor a landmark. The
 * bank covers the whole live range instead; the level only decides which end of it is likely.
 */
const ICON_SCALES_ANY = [0.4, 0.45, 0.5, 0.55, 0.6, 0.67, 0.75, 0.83, 0.9, 1, 1.1, 1.21, 1.3] as const;

/**
 * The swipe vectors, in client pixels, named by the direction the **view** travels (legacy's own
 * convention): to see further north, drag the map down. Fixed length — the loop never uses the distance,
 * only "look again after the move".
 */
const SWIPE_VECTORS: Readonly<Record<'w' | 'a' | 's' | 'd', readonly [Point, Point]>> = {
  w: [{ x: 960, y: 380 }, { x: 960, y: 980 }],
  s: [{ x: 960, y: 980 }, { x: 960, y: 380 }],
  a: [{ x: 1_220, y: 540 }, { x: 620, y: 540 }],
  d: [{ x: 620, y: 540 }, { x: 1_220, y: 540 }],
};

/** The travel through the new senses: icon + title, the white ring, the pointer's edge push. */
async function travelBySenses(entry: LocationEntry, env: WorldMapEnv): Promise<MapTravelResult> {
  const now = env.now ?? (() => Date.now());
  const opened = await openWorldMap(env);
  if (!opened.ok) return { ok: false, reason: 'refused', detail: opened.reason };
  // Put the map at **level 1** deterministically: three zoom-ins saturate at the most zoomed-in level
  // (extra presses clamp), then one zoom-out lands on level 1 — where every title is drawn and every
  // site is clickable (operator, 2026-11-09). Counting from the opening level would be a guess: a
  // swallowed press, or a map left at another level by an earlier action, would put every icon scale wrong.
  for (let step = 0; step < 3; step += 1) {
    await env.actuator.holdKey(ZOOM_KEY_IN, 60);
    await env.sleep(300);
  }
  await env.actuator.holdKey(ZOOM_KEY_OUT, 60);
  await env.sleep(420);
  const levels = (level: 0 | 1 | 2): number[] => iconScalesAt(level);
  const image = async (): Promise<RgbaImage | null> => decode(await env.capture());
  // The catalogue's art is the **whole node** (icon over its banner); at every zoom the game draws the
  // banner separately (screen-space art), so an uncropped template cannot match the icon. The atlas
  // solved this long ago by cropping to the banner's top (`iconTemplateFor`), and the finder must match
  // the same art — that mismatch is why the first live run found neither the target nor a landmark
  // (2026-11-09 01:19: the atlas confirmed the same node at 0.69 on the same frame).
  const iconOnly = (candidate: LocationEntry): LocationEntry => {
    const cropped = iconTemplateFor(candidate.id);
    return cropped === null ? candidate : { ...candidate, template: cropped };
  };
  const target = iconOnly(entry);
  const catalogue = [...LOCATIONS.values()].map(iconOnly);

  // The level is verified from the frame, not from the number of presses: an icon that matched at ~1.21
  // is level 2, at ~0.90 level 1, at ~0.67 level 0 (measured 2026-11-09). One correction each way.
  for (let repair = 0; repair < 2; repair += 1) {
    const current = await image();
    if (current === null) break;
    const wide = findSite(current, target, {
      strip: MAP_STRIP, iconScales: [0.6, 0.67, 0.75, 0.83, 0.9, 0.98, 1.08, 1.21, 1.3], titleScales: [1], wantTitle: false,
    });
    if (wide === null) break;
    if (wide.iconScale > 1.05) {
      env.log?.('wvd: the level reads ' + wide.iconScale + ' (too close); zooming out once');
      await env.actuator.holdKey(ZOOM_KEY_OUT, 60);
      await env.sleep(420);
    } else if (wide.iconScale < 0.75) {
      env.log?.('wvd: the level reads ' + wide.iconScale + ' (too far); zooming in once');
      await env.actuator.holdKey(ZOOM_KEY_IN, 60);
      await env.sleep(420);
    } else {
      break;
    }
  }
  // The atlas hint: which way the target lies from the view's own centre (other sites inform, never gate).
  const atlasPoint = siteById(entry.id);
  const senses: MapSenses = {
    site: async () => {
      // A captured art (perception/site-art.ts) is matched at scale 1 — the legacy rule, and the end of the
      // scale sweep for any site that has been recorded. Unrecorded sites keep the wide bank.
      const art = capturedArt(entry.id, 1);
      const current = await image();
      if (current === null) return null;
      const found = findSite(current, art === null ? target : { ...target, template: art.template }, {
        strip: MAP_STRIP,
        iconScales: art === null ? [...ICON_SCALES_ANY] : [0.98, 1, 1.02],
        titleScales: [1],
        wantTitle: true,
        minIconScore: 0.78,
      });
      return found === null ? null : { at: found.point, confidence: found.confidence };
    },
  };
  const input: MapInput = {
    swipe: (direction) => {
      const [from, to] = SWIPE_VECTORS[direction];
      return env.actuator.drag(from, to, 300);
    },
    tap: (at) => env.actuator.tap(at),
    sleep: (ms) => env.sleep(ms),
    log: (line) => env.log?.(line),
  };
  const travelled = await travelToSite(senses, input, {
    now,
    nextDirection: async () => {
      const site = atlasPoint;
      const current = await image();
      if (site === null || current === null) return 'd';
      const located = locateView(current, undefined);
      if (located === null) return 'd';
      const dx = site.x - (located.offset.x + MAP_STRIP.width / 2);
      const dy = site.y - (located.offset.y + MAP_STRIP.height / 2);
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
    },
  });
  if (!travelled.ok) return travelled;
  const left = await poll(env, (screen) => screen !== 'worldmap', LEAVE_TIMEOUT_MS, now, 'location-not-found');
  return left.ok ? travelled : { ok: false, reason: 'not-found', detail: 'the map did not leave after the tap' };
}

export async function travelTo(id: string, env: WorldMapEnv): Promise<TravelResult> {
  const now = env.now ?? (() => Date.now());
  const entry = destinationOf(id);
  if (entry === null) return { ok: false, reason: 'unknown-location', detail: id };
  if (entry.kind === 'dungeon-select') return selectDungeon(entry, env);

  // The stored atlas is the normal path for any node it catalogues: the site's coordinate is
  // measured and one label banner tells the view where it is, so the spiral below is the fallback
  // for destinations the atlas does not know.
  const atlasSite = env.atlas === true ? siteById(id) : null;
  const navigation = env.navigation ?? (env.pointer === true ? 'senses' : 'legacy');
  if (navigation === 'senses') {
    const entryForSenses = LOCATIONS.get(id);
    if (entryForSenses !== undefined) {
      const viaSenses = await travelBySenses(entryForSenses, env);
      if (viaSenses.ok) return { ok: true };
      env.log?.('wvd: the senses could not reach ' + entry.label + ' (' + viaSenses.reason + '); falling back to the atlas');
    }
  }
  if (atlasSite !== null) {
    const viaAtlas = await travelViaAtlas(
      { kind: 'site', id },
      env,
      env.localiser === 'registration' ? { locate: 'registration' } : {},
    );
    if (viaAtlas.ok) return { ok: true };
    env.log?.('wvd: the atlas could not place ' + entry.label + ' (' + viaAtlas.reason
      + (viaAtlas.detail === undefined ? '' : ': ' + viaAtlas.detail) + '); falling back to the template search');
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
 * The party arrives by tapping the dungeon's node on the world map; the row is a `dungeon-select`
 * screen the perceiver names, so this action can wait for its own effect: it taps the row and does
 * not return until the list is gone. A travel that returned on the tap alone was read as "still on
 * the list" by the caller, which asked again — live 2026-11-02 the orientation tapped 第三区 three
 * times in a row and the third tap failed on the loading list.
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
  // The tap is not the travel: wait until the list is gone, the way the site travel waits for the
  // world map to leave. The load that follows is the caller's settle to watch.
  const left = await poll(env, (screen) => screen !== 'dungeon-select', LEAVE_TIMEOUT_MS, now, 'location-not-found');
  if (!left.ok) return left;
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
