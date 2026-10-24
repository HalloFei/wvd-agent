# World-map entry — design

Status: design, awaiting approval. Binding declarations go into
[`2026-10-24-contracts.md`](2026-10-24-contracts.md) §3–§5 and §10 and `src/contracts.ts` in the
same commit.

## 1. Why

The FFXI task's entry is two fixed taps: (1200,1030) opens the world map and (1051,388) picks
北穿幽冥城. The world map opens at a pan centred on the party, so the second tap only lands on the
icon when the map opens from the village; from the capital it lands on 诺森霍洛村 (board p1). A
session started in town also escalates: all five town fixtures are `unknown` at 0.2 through the
production composite, and the board recorded six escalations in 35 s.

The legacy script solves both. `IdentifyState` (wvd `src/script.py:1456`) names the screen by
templates; `TeleportFromCityToWorldLocation` (`:1286`) finds `intoWorldMap`, zooms out once,
finds the target with swipe fallbacks and clicks it; `DungeonFarm` (`:2453`) runs the cycle. Its art
is 900×1600 mobile, but the PC build draws the same UI at 1080/1600 = 0.675 and the templates match at
0.66–0.68 (measured below). `wvd/AGENTS.md`'s "useless against 1920×1080" is false as written.

## 2. Goals

- Name `town` and `worldmap`; both are `ScreenId` values with no producer today.
- From town, find the world-map icon and tap it; when the party panel covers it, find the collapse
  chevron, tap it, then find the icon.
- On the world map, find the task file's destination by its legacy image; when it is off-view, zoom
  out and drag the map until it is; tap its centre.
- Verify every transition. A failed match stops the session with a typed reason and never taps blind.
- Add the drag gesture the engine lacks.

## 3. Non-goals

- Which town the party stands in. The four `City_*` templates are destination anchors on the world
  map, not scene fingerprints; every town has the same world-map control.
- OCR. Templates are matched as images.
- The dungeon-select list. Its rows sit at x≈1082 and stay static taps in the task file.
- The inn rest chain. §4 records where it belongs in the cycle; it is a separate task.
- A map model or inertial panning. The search is a bounded spiral.

## 4. The complete cycle (legacy, and what the task file mirrors)

`DungeonFarm` (wvd `src/script.py:2453`) repeats:

1. `IdentifyState()` (`:1456`) reads the frame and returns `Inn`, `EoT`, `Dungeon` or `Quit`.
   It matches `dungFlag`, `chestFlag`, `mapFlag`, `returntoTown`, `worldmapflag`,
   `openworldmap`, the four `City_*` templates and `Inn`.
2. `State.Inn` (`:2475`): rest only when `ACTIVE_REST`, a chest or battle was met, and
   `(COUNTERDUNG−1) % REST_INTERVEL == 0`. `StateInn` (`:1690`) clicks 旅店 → 住宿 → 经济房 →
   确定 → 返回; then `State.EoT`.
3. `State.EoT` (`:1700`): when `_EOT[0]` is `intoWorldMap`, `TeleportFromCityToWorldLocation`
   opens the map (or returns when `dungFlag`/`openworldmap` is already there), zooms out once
   (`_ZOOMWORLDMAP`), finds the target with swipe fallbacks and clicks it. The remaining `_EOT`
   entries are matched and pressed on the dungeon-select screen. Then `State.Dungeon`.
4. `State.Dungeon` (`:2153`): works `_TARGETINFOLIST` (chests, harken, stairs, `leaveDung`) and
   leaves when the list is done or a return-to-town screen leads to `Inn`.
5. Back to `state=None`. If rest is due and the party is on the world map or select screen,
   `TeleportFromDungeonToCity(*quest._RTT)` (`:1328`) returns to the rest town before the next
   cycle.

FFXI 4F (`resources/quest/quest.json`): `_EOT = [intoWorldMap → FFXI/GCN → FFXI/ZONE3]`,
`_RTT = City_RoyalCityLuknalia`, targets `stair_zone4`, `chest`, `leaveDung`. The rest town is
per-quest data, not a constant; the task file's equivalent is a `travel` step.

This design implements the entry leg and the `travel` primitive. The exit and rest legs reuse them.

## 5. Perception

### 5.1 Templates

The catalog is the legacy art; the matcher rescales it. `scripts/extract-location-templates.mjs`
(provenance, not part of CI) decodes each source with ffmpeg — measured: it decodes the `.png` that
is really WebP and the JPEG fixtures — scales nothing, and emits base64 grayscale arrays into
`src/perception/location-templates.ts`. Runtime scaling is bilinear inside the matcher, so one
catalog entry serves every UI scale. This is the existing map-template pattern
(`scripts/extract-map-templates.mjs`); Node still has no image decoder.

Coverage: `intoWorldMap` and `closePartyInfo` (+ its `_fortress`/`_waterway` variants if they
differ), the four `City_*` nodes, `FFXI/City_VNH` (诺森霍洛村), `FFXI/GCN` (北穿幽冥城), the
FFXI zones `ZONE1/2/3`, and `Inn`.

Measured 2026-10-24 on 1920×1080 engine captures, best NCC over scales 0.60–0.75:

| Match | Frame | Scale | NCC |
| --- | --- | --- | --- |
| world-map icon `intoWorldMap` | town, panel down (`.tmp/120.jpg`) | 0.66 | 0.975 |
| panel chevron `closePartyInfo` | town, panel up (`town-0.jpg`) | 0.68 | 0.955 |
| 诺森霍洛村 `City_VNH` | world map (`.tmp/14.jpg`) | 0.66 | 0.955 |
| 北穿幽冥城 `GCN` | world map (`.tmp/14.jpg`) | 0.68 | 0.989 |
| 都卢库纳里亚 | world map, zoomed out (`07.jpg`) | 0.68 | 0.930 |
| 都卢库纳里亚 | world map, zoomed in (`20.jpg`) | 0.66 | 0.768 (node partly off-frame) |
| 旅店 `Inn` | town (`town-0.jpg`) | 0.71 | 0.882 |
| world-map icon | town, panel up | — | 0.475 |

Threshold 0.80. A partly visible node (北穿幽冥城 at the top edge, `07.jpg`) scores 0.555 and must
be refused; the fix is zoom-out or a drag, never a click.

### 5.2 `TownPerceiver`

The lower band carries the chevron in both panel states and the icon when the panel is down. Match
both over y ≥ 720 at 0.62–0.72; `town` at confidence ≥ 0.5 when either clears 0.80. Refuse on
dungeon, map, combat, select and menus. The chevron is the primary evidence: the icon alone scores
0.475 with the panel up.

### 5.3 `WorldMapPerceiver`

Name `worldmap` structurally from the parchment field (bright low-saturation map ink with black
side pillars), the zoom row (`−`/`+` at y≈1017) and the `关闭` cross. Fixtures: `07`, `14`,
`20`, `22` at 1920×1080. The observation carries no payload; node matching belongs to the action.
No node id enters contracts.

### 5.4 Cost

The entry runs before the first tick or inside a task script, not in the 10 Hz loop, so a 100–300 ms
match is acceptable. Search only the map area (x 450–1650), downsample 2× for the coarse pass, then
refine the best five candidates at full resolution.

## 6. Actions

`src/actions/worldmap.ts`:

- `openWorldMap({capture, observe, actuator})`
  1. Observe. `worldmap` → done; `dungeon`/`dungeonmap` → done (already past the entry);
     `loading` → wait up to 10 s.
  2. Find the icon. Found → tap its centre; wait for `worldmap` (≤5 s).
  3. Not found → find the chevron. Found → tap it, wait 300 ms, capture, find the icon, tap, wait.
  4. Neither → `world-map-control-not-found`.
- `travelTo(id, …)`
  1. Resolve the catalog entry; unknown → `unknown-location`.
  2. Ensure the world map is open.
  3. Match the node. Found → tap its centre; wait until the screen is no longer `worldmap` (≤6 s,
     `loading` counts as leaving).
  4. Not found → `Q` (zoom out) up to 3 times, re-matching after each.
  5. Not found → drag search: 8 steps of 400 px from a safe point, clockwise (right, down, left, up,
     right-down, …), re-matching after each. A safe point is a 64×64 window in the map area with the
     least ink, at least 80 px from any control.
  6. Budget spent → `location-not-found`.

The tap point is the template's centre plus the catalog's `anchor` offset (zero until measured).
Measured centres: 诺森霍洛村 (960,469), 北穿幽冥城 (1063,402), world-map icon (1194,1024), chevron
(697,799).

## 7. Drag

Contracts §4 and §5:

```ts
export const MAX_DRAG_MS = 500;
// Actuator
drag(from: Point, to: Point, durationMs: number): Promise<ActionResult>;
// EngineRequest
| { op: 'drag'; x1: number; y1: number; x2: number; y2: number; durationMs: number }
```

`gestures.mjs` `drag`: foreground guard, `moveToClient(from)`, `mouseDown`, then
`clamp(ceil(durationMs/25), 4, 20)` straight-line moves with a sleep between, `mouseUp`
unconditionally, foreground guard again → `rejected`. `releaseHeld` already covers a teardown
mid-drag; `MAX_DRAG_MS < TEARDOWN_GRACE_MS` keeps the §4 invariant. The codec accepts finite
coordinates and `0 < durationMs ≤ MAX_DRAG_MS`, and drops anything else as malformed.

**Risk:** the guide records a synthetic drag that did not move the view and the board one that
selected an icon. The difference is likely a single jump versus incremental moves, or starting on an
icon. The first live probe is a 300 px drag from an empty parchment point. If the view still does not
move, this design stops at zoom-out only, and the entry falls back to it. This is the one fact a unit
test cannot settle.

## 8. Task file

`TaskStep` gains `{ op: 'travel'; to: string }`. `parseTask` takes the catalog's ids and rejects an
unknown `to` at load (`unknown-location`), so a typo refuses the session instead of stopping
mid-entry.

```json
"entry": {
  "timeoutMs": 180000,
  "steps": [
    { "op": "expect", "screen": "town", "timeoutMs": 20000 },
    { "op": "travel", "to": "ffxi-gcn" },
    { "op": "tap", "at": [1082, 520] },
    { "op": "expect", "screen": "dungeon", "timeoutMs": 45000 },
    { "op": "tap", "at": [1849, 110] },
    { "op": "expect", "screen": "dungeonmap", "timeoutMs": 8000 },
    { "op": "expectFloor", "timeoutMs": 5000 }
  ]
}
```

The two world-map taps leave the file; the dungeon-select tap stays (fixed list, 第三区 at y≈520).
`exit` is unchanged in this slice; `{ "op": "travel", "to": "city-royal" }` is added when the
归还 exit is verified (board p0). The entry is defined from town: a session started mid-dungeon stops
at the first step instead of clicking a map it is not on.

## 9. Contracts

- §4: `Actuator.drag` and `MAX_DRAG_MS`.
- §5: `EngineRequest.drag`; the reply keeps `{ inputMs }`.
- §10: `TaskStep.travel`; `ScriptEnv.travel(to)`; `ScriptFailure` gains
  `world-map-control-not-found` and `location-not-found`; `TaskFileProblem` gains
  `unknown-location`.
- `ScreenId`, `Observation`, `Intent` and the route policy are unchanged. The route's
  `town → exit` stays; with a task a tick that sees town runs the exit script, which is the
  cycle's leave leg.

## 10. Failure policy

| Where | Failure | Result |
| --- | --- | --- |
| load | unknown destination id | session refuses to start |
| entry | icon/chevron not found | stop `world-map-control-not-found`, step index in the log |
| entry | node not found after zoom+drag budget | stop `location-not-found` |
| entry | match below 0.80 | treat as not found; never click |
| any | press rejected (not foreground) | stop with `rejected`; no retry |
| any | capture failing three times | `capture-unavailable` |
| any | stop hotkey/console stop | abort at the next step; the in-flight drag completes |

## 11. Tests

- `tests/location-templates.test.ts` — every catalog entry matches its committed fixture at the
  measured scale with NCC ≥ 0.80; the panel-up icon and the clipped node are below it; two different
  nodes are not confused.
- `tests/location.test.ts` — `TownPerceiver` names the five town fixtures and refuses view, map,
  combat, prompt, third-floor; `WorldMapPerceiver` names the four map frames and refuses the rest.
- `tests/engine-gestures.test.ts` (extend) — drag order (move, down, moves, up), release on
  foreground loss, duration clamp, `releaseHeld` mid-drag.
- `tests/engine.test.ts` (extend) — `drag` codec round trip, malformed requests dropped,
  `MAX_DRAG_MS < TEARDOWN_GRACE_MS`.
- `tests/worldmap-action.test.ts` — icon found; panel up → chevron then icon; neither → typed
  failure; node found first view; found after Q; found after a drag; never found; low score → no tap;
  rejected drag → no retry; unknown id.
- `tests/task-schema.test.ts` (extend) — `travel` parses, unknown id fails, mixed fields fail.
- `tests/task-steps.test.ts` (extend) — `travel` reaches `env.travel`, failure ends the script at
  its index.
- `tests/world.test.ts` (extend) — the entry runs travel before the first tick; a failed travel
  ends the session with exactly one `wvd.stopped`; a stop during travel aborts.

## 12. Live acceptance

1. Promote the fixtures: `testdata/worldmap/2026-10-24/{07,14,20,22}.jpg` and
   `testdata/frames/town-panel-down.jpg` from `.tmp/120.jpg`.
2. Drag probe: from the town, open the world map, drag 300 px from an empty point, and compare the
   frames. Record the result in the guide.
3. Entry: start in town with the panel up; the task file's `expect town` → `travel ffxi-gcn` →
   select 第三区 → floor gate. Repeat with the map panned away so the drag path is used.
4. Record the measured NCCs and the drag result in `docs/status.md`.

## 13. Left to the builder

- The exact `TownPerceiver` structural gate and the `WorldMapPerceiver` field thresholds; measure
  on the committed frames, do not guess.
- The drag step, the number of zoom-outs, and whether a drag starts on a safe patch or a fixed point;
  measure on the live game.
- The `anchor` for each node: the clickable hitbox may not be the template centre.
- The extraction script's source list and whether the `_fortress`/`_waterway` chevrons are needed.
- The rest-town id in the FFXI task file: `city-royal` follows the legacy `_RTT`; if the operator
  wants 诺森霍洛村, it is another catalog entry.
