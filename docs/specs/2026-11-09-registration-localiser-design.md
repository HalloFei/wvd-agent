# The world map, localised by registration — design

**2026-11-09.** The atlas travel infers its pose: it finds a label banner, or clamps the view to the
map's north-west corner; it assumes a zoom ladder of 1.34 per step, and it plans one level while it
confirms at another. Three failure modes follow, all measured this week:

- a view whose banners are culled has no banner to read, so it costs eight blind clamp drags, and a
  clamp that times out returns success with offset (0,0) (`worldmap.ts:675`);
- a zoom-out press that the window swallows is indistinguishable from the clamp, because both look
  like "the frame did not change" (`zoomToMaxOut`, `worldmap.ts:628`);
- the ladder is wrong. The label banners are **fixed-size screen art**, so `atlas distance / screen
  distance` measures the zoom directly: 0.95-1.09 on `max-out.jpg` (1.0), 1.48-1.55 on
  `level-in-1.jpg` (~1.52), 1.86-2.04 on `center-in-2.jpg` (~1.96), and `max-in.jpg` peaks at 2.4.
  `MAP_ZOOM.stepScale`'s 1.34 disagrees with every one; it explains why every live confirmation
  matched the node icon at 0.69 — 0.45 x 1.5 — the top of the level-1 bank, never at the planned level.

This design replaces the *pose* and the *zoom state* with measurements, and keeps the atlas's motion
plan (pan at max zoom-out, tap one step in) because that is a property of the map viewport, not of the
pose source: at max zoom-in a drag is ignored and a drag that starts on a node is read as a click
(live 2026-11-09 21:52: the pan opened the inn).

## 1. Surface

`src/perception/map-localiser.ts`:

    createAtlas(image: AtlasImageData): LocaliserAtlas
    worldMapAtlas(): LocaliserAtlas            // the committed atlas, built once per session
    localiseView(image: RgbaImage, atlas: LocaliserAtlas, options?: LocaliseOptions): Pose | null

    interface Pose { origin: Point; level: number; factor: number; score: number; cellPx: number }
    interface LocaliseOptions {
      prior?: { offset: Point; level: number };   // local search, for the pan loop
      windowPx?: number;                          // atlas px around the prior (default 320; 900 for a pan)
      levels?: readonly number[];                 // hypotheses (default all four, or the prior's)
      minScore?: number;                          // default 0.5
      factor?: number; refineScale?: boolean;     // the tests' hooks
    }

The projective model is **`screen = factor * (atlas - origin)`**, with no centre term: `origin` is
the atlas point the strip's top-left corner shows. At max zoom-out it equals the atlas's own
`offset`; at any other level it is the single number the pan and the confirmation need.

`src/perception/worldmap-atlas.ts` gains `ZOOM_LADDER = [1, 1.52, 1.96, 2.4]` and
`zoomFactor(level)`. `MAP_ZOOM.stepScale` stays only so the legacy path's arithmetic is unchanged.

## 2. The image

`scripts/extract-worldmap-atlas.mjs` turns `testdata/worldmap/2026-11-01/overview-full.jpg` (the
stitched 1360x1496 map, sha256 recorded in the generated header) into
`src/perception/worldmap-atlas-image.ts`: box-averaged 2x to 680x748, one byte per cell, base64 —
the same generated-module pattern as `worldmap-labels.ts`. One stored cell is two atlas pixels.

## 3. The search

A view at level `l` is the strip resampled into atlas space at `factor(l) * pixelsPerCell` screen px
per cell (the probe). The probe is compared against the atlas with Pearson correlation on a pyramid
of 16, 8, 4 and 2 atlas px per cell: every level hypothesis is scored at the top layer, the best three
placements of the winner are refined down the pyramid (±2 cells at each step), and the winning factor
is refined once by ±2% and ±4%. A prior replaces the exhaustive search with a window around the last
pose — that is what makes the pan loop's re-localisation cheap (the LKMapTools local search).

It is the LKMapTools / Game-Map-Tracker shape without the corner detector: the map never rotates and
the atlas is only 1.4x the strip, so their 4-DOF similarity fit is a 2-DOF translation here.

## 4. Integration

`travelViaAtlas(..., { locate: 'registration' })` — the World sets it from `WVD_LOCALISER=registration`;
the CLI passes the same and has a read-only `localize` command. The plan:

1. open the map, localise; refuse below `REGISTRATION_FLOOR = 0.45`;
2. press 缩小 until the level reads 0, **re-reading the pose after every press** — the level must drop,
   or the press was swallowed (a typed failure, not a blind clamp);
3. pan at max zoom-out (`offsetThatAimsLevel` clamps to the reachable range at that zoom) and
   re-localise through a **900 px** window after every drag, because a drag reaches ~320 x 2.2 px;
4. press 放大 once, re-read; if the zoomed frame does not register (the stitch is weakest there, 0.45-
   0.49), carry the pose forward — the frame offset is invariant under a zoom about the view centre —
   and let the confirmation be the check;
5. confirm the node's icon at that level's own scale inside ±180 px, then tap.

Two gates stand between a pose and a tap: the score floor above, and the confirmation (icon >= 0.75,
window 180 px). A bad pose therefore costs a fallback to the template search, never a wrong tap.

## 5. Measurements

| what | score |
|---|---|
| a view rendered from the atlas itself (level 0-3) | 0.988-1.000, origin exact |
| real `max-out.jpg` / `canonical-view-mid.jpg` vs the stitch | 0.805-0.814 at level 0, origin (0,0) |
| real `level-in-2.jpg` / `max-in.jpg` | 0.758 / 0.735 at levels 2 / 3 |
| real `level-in-1.jpg` (the stitch's weak case) | 0.49-0.54 at level 1 |
| a character page vs the stitch | 0.507 — the score alone cannot gate; the screen must |

Live, 2026-11-09, `WVD_LOCALISER=registration WVD_NAV=legacy`, WizardryVariantsDaphne PID 16808:
`ffxi-gcn` located 230,0 (level 0, 0.591), panned, re-read level 1 / factor 1.49 (0.452), tapped at
957,278 (icon 0.987 @ 0.67), ok; `vnh` located 230,0, panned 71,0 (gain 1.52), the zoomed frame did
not register so the pose carried, tapped 1052,341 (icon 0.981 @ 0.68), ok. Both taps matched the icon
at 0.45 x the live factor — the ladder reading is corroborated by the game.

## 6. Failure model

| outcome | meaning |
|---|---|
| pose null | no level scored at least the floor: not a map view, or the stitch is too weak (fall back) |
| zoom press did not change the level | the key is not landing (window not focused): typed failure, no blind pan |
| pose drift after a drag | the prior window lost the pose: the pan budget (8) bounds it |

## 7. Tests

`tests/map-localiser.test.ts` — synthetic views from the atlas at each measured level recover their
origin exactly (score > 0.95); the recorded frames read at level 0 / 2 / 3; the banner locator and the
registration agree within 60 px on the stitch's weak frame; the ladder is pinned.

`tests/worldmap-registration.test.ts` — a session that really zooms and drags (the frame is the atlas
at the current level and origin): from level 1 with the node off the aim, the first key is 缩小, the
drags follow, the tap lands on 诺森霍洛村, and the map leaves.

Not covered: the live drag gain at a non-zero level (the pan loop learns it), and the full task loop.

## 8. Open items

- The stitch is now the weak link: 0.59 at max-out on a live frame, 0.45-0.49 at zoom. A lossless
  re-capture (a pan tour at each level, tiles placed by their label anchors) would raise the scores,
  and only then can the floor and the icon floor be raised with them (card `t-mw9aqpya-ogv9kf`).
- The default is still the atlas path; a 3-5 cycle harness run with `WVD_LOCALISER=registration` is
  owed before the switch becomes the default.
- `MAP_ZOOM.stepScale` 1.34 is still what the legacy path plans with; making the legacy path use the
  measured ladder is card `t-mw9aqpy0-tfzxh7`.
