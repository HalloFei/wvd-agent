# Travel by the stored world map — design

- Status: implemented 2026-11-01 (commit e0929a4); this record is the contract.
- Code: src/actions/worldmap.ts (travelViaAtlas, AtlasTarget, AtlasTravelOptions, AtlasTravelResult,
  AtlasTrace); atlas data in src/perception/worldmap-atlas.ts.
- Tests: tests/worldmap-atlas-travel.test.ts (synthetic map), tests/worldmap-action.test.ts (the
  template fallback, unchanged), tests/task-run.test.ts (the travel step's plumbing).

## 1. The problem

The game's world map is 1360x1496 atlas pixels drawn in a 960x1080 strip, zoomable over four steps
(1x, 1.34x, 1.80x, 2.41x). At max zoom-out the game culls colliding labels — 北穿幽冥城 has none —
and at max zoom-in only the middle ~60 % of the map is reachable by panning. The legacy autoscript
treats the map as a search space: zoom out blindly, then repeat screenshot -> template match -> fixed
swipe up to 25 times and restart the game on failure. It works, but it cannot say where it is, and it
cannot head for a place that is off screen.

The stored atlas answers "where": every catalogued site has a coordinate and every label banner has a
known rectangle. This design turns that into an aimed travel: locate the view, pan, zoom, confirm the
node, tap it — and never tap anything the frame did not confirm.

## 2. Surface

    travelViaAtlas(target: AtlasTarget, env: WorldMapEnv, options?: AtlasTravelOptions)
      : Promise<AtlasTravelResult>

    type AtlasTarget =
      | { kind: 'site';  id: string }                              // coordinate from WORLD_MAP_SITES
      | { kind: 'point'; x: number; y: number; label?: string;     // raw atlas pixels
          templateId?: string };

Options, with the default each one ships and the measurement behind it:

| option | type | default | rationale |
|---|---|---|---|
| confirm | 'icon' / 'label' / 'either' / 'none' | 'icon' | the icon is drawn at every zoom; a label may be culled |
| templateId | string | the site's | which legacy art confirms the node |
| minScore | number | 0.75 | measured icon matches live: 0.908-0.983 |
| windowPx | number | 180 | the icon art is anchored at the node, not centred on it: at max zoom-in it sits ~70 px from the atlas coordinate |
| anchor | 'any' or a site/banner id | 'any' | pins the locator for a relay (find 诺森霍洛村 first) |
| locate | 'anchor' / 'clamp' / 'anchor-then-clamp' | 'anchor-then-clamp' | the clamp is the guaranteed fallback |
| zoom | 'none' / 'in' / number / 'max' / 'auto' | 'max' | a node whose label is culled does not take the tap, so the tap is made zoomed in |
| maxCorrections | number | 8 | the pan is not linear; the budget is the loop's guarantee |
| timing | { zoomSettleMs, dragSettleMs, parkSettleMs } | 420 / 300 / 240 | every wait is data, so tests can zero it |
| policy | { parkPoint, dragStepPx, panGain, clampDrags, verifyRadiusPx } | none / 320 / 1 / 8 / 180 | the gesture constants |
| trace | boolean | false | returns the per-step measurements |

    type AtlasTravelResult =
      | { ok: true;  trace?: AtlasTrace }
      | { ok: false; reason: TravelReason; detail?: string; trace?: AtlasTrace };

    interface AtlasTrace {
      target: Point;                                     // atlas px
      located?: { by: 'anchor' | 'clamp'; anchor?: string; offset: Point;
                  anchors?: number; spreadPx?: number };
      placed?:  { offset: Point; level: number; predicted: Point };   // predicted = strip px
      corrections: number;
      zooms: number;
      confirmed?: { by: 'icon' | 'label'; score: number; scale: number };
      tapped?: Point;
    }

## 3. Procedure

1. Open the map (openWorldMap): a tap on the parchment icon from town, the Dungeon Select row, or
   accept the map that is already open.
2. Clamp the zoom out: press Q until two presses leave the strip unchanged. The game has no zoom
   readout, so the clamp is the zoom state.
3. Locate the view from one frame:
   - banners (8 known rectangles) matched at scale 1 — the largest cluster within 6 px wins;
   - node icons (4 catalogued arts) matched over the strip at 0.42-0.48 — they are drawn at every
     zoom, so they locate a view whose labels are all culled;
   - if nothing matches: drag the content right and down until the map refuses to move. That is the
     map's north-west corner, atlas (0,0) — verified on a recorded corner frame (5 banners, 0 px
     spread).
4. Plan: choose the highest zoom level at which the target still lands inside the tap area, and the
   offset that puts it on the aim point (the middle of that area, not the strip centre).
5. Pan at max zoom-out: drag by the remaining delta divided by the measured gain; after every drag
   re-locate and update the gain from what actually moved. A sample that started or ended on a pan
   clamp is truncated and is not used to update the gain. Both ends of the drag stay inside the strip —
   a drag that starts on the black pillar is ignored.
6. Zoom in to the planned level, one press at a time, each press verified against the strip signature
   (a swallowed press leaves the map a level back, and the icon is then looked for at the wrong scale).
7. Confirm the node at the predicted point: match its icon in a +/-180 px window at the level's scale
   (0.45 x 1.34^level, +/-15 %); the matched centre is the tap point. No match, no tap.
8. Tap, then wait for the map to close. A tap the game swallows ends as location-not-found.

Invariants:

- The atlas never taps blind. A tap exists only after an icon (or label) match at the prediction.
- All panning happens at max zoom-out. Drags are ignored at max zoom-in (measured).
- No pointer park. Every black-pillar point tried pans the map on a tap, so the pointer is left where
  the drag ended and the drag is aimed to leave it away from the target.
- Every step is measured. Zoom (signature), pan (re-locate), confirmation (template score). The only
  open-loop number is the first pan gain, and it is corrected by the second iteration.
## 4. Measurements this design rests on (2026-11-01)

| fact | value |
|---|---|
| map size / strip / pan range at max-out | 1360x1496 / 960x1080 at x=480 / 400x416 |
| zoom ladder | 4 levels, ~1.34x per step, anchored on the view centre |
| banner agreement in one frame | 5-6 anchors, spread 0-1 px |
| icon match at max zoom-in | 0.908 and 0.982, scale 0.92 |
| icon drawn offset from the atlas point at max-in | ~70 px (art is anchored at the node) |
| pan gain | 0.32-2.28 on the same map; not a constant |
| pillar tap | pans the map 14-270 px (that is what used to be called "the map moves on its own") |
| drag starting on the pillar | ignored (13, 0, 0 px for three drags) |
| idle map | pixel-identical for 8 s — the map never moves by itself |

## 5. Failure model

| reason | meaning |
|---|---|
| unknown-location | the target is not in the catalogue |
| location-not-found | no label/icon in view with locate 'anchor'; or the node did not confirm; or the map did not close after the tap; or the pan budget ran out |
| cancelled | the abort signal fired between steps |
| world-map-control-not-found | the map could not be opened (from openWorldMap) |
| unavailable | the frame did not decode |
| actuator failures | a refused press is returned unchanged, never retried blind |

## 6. Task-driven use

The World does not decide when to go; a task does. A task file carries:

    { "op": "travel", "to": "ffxi-gcn" }

runSteps calls env.travel(to); the runner wires that to travelTo(id, {...shared, atlas: true}), which
sends catalogued ids through travelViaAtlas and falls back to the template spiral for anything the
atlas does not know. Tested at the step level in tests/task-run.test.ts ("runs a travel step through
the env and stops at its index on failure") and at the action level in
tests/worldmap-atlas-travel.test.ts.

This is the accepted boundary: the task says where, the atlas says how, the frame decides whether.

## 7. Tests

tests/worldmap-atlas-travel.test.ts builds a synthetic map — the real banners and icons drawn at the
place the atlas says for a given offset and zoom level, drags moving the offset, keys changing the
level — and asserts:

1. a banner-located view is panned, zoomed three steps and tapped at the confirmed icon;
2. a label-less view is located by the node icons instead;
3. with nothing legible drawn the view is clamped to the north-west corner (trace by 'clamp') and the
   node is then refused rather than tapped;
4. a node whose icon is not drawn is refused and nothing is tapped;
5. zoom 'none' presses no zoom key and takes the node at max zoom-out;
6. an unknown id is a typed failure;
7. a pinned anchor that is not drawn, with locate 'anchor', fails without a tap;
8. travelTo with atlas true reaches the same result.

Live-only, not covered by the suite: the real drag gain, the real zoom animation timing, and whether
the game accepts the tap (the last is confirmed by the map closing).

## 8. Open items

- The catalogue holds 9 sites. 法师的试炼, 旧王墓, 灰山之砦, 花之洞窟, 亚歌拉神殿, 王之试炼,
  战士的试炼, 盗贼的试炼 and 古城遗迹 have no coordinates yet; a harvest task that reads a zoomed view
  and records its labels is the next feature.
- zoom 'auto' is implemented but unused: the default is 'max' because a tap at max zoom-out is ignored
  for culled-label nodes. It exists for nodes that confirm early.
- The pan gain is still learnt at run time rather than calibrated once per session; a per-session
  calibration would remove the first overshoot.
