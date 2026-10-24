# World-map entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A session that starts in town opens the world map by finding its icon (collapsing the party panel when it covers the icon) and reaches the task file's destination node by template match, zoom-out and drag, with no fixed coordinates.

**Architecture:** three seams. A grayscale template matcher plus a location catalog (perception); a `town` and a `worldmap` recogniser registered in the composite, and one find-and-tap action module; one new task step `travel` that the runner executes. The engine child gains a `drag` request. The route policy is untouched.

**Tech Stack:** TypeScript (ESM, Node 22), vitest, koffi for Win32, ffmpeg only in the offline extraction script.

**Spec:** [`2026-10-24-worldmap-entry-design.md`](../specs/2026-10-24-worldmap-entry-design.md)

## Global Constraints

- Frames are 1920×1080 device pixels. Another size is refused, never rescaled (contracts §0.5).
- Failure is a value; no module throws across its boundary (contracts §0.6).
- `src/contracts.ts` mirrors `docs/specs/2026-10-24-contracts.md` declaration for declaration.
- No OCR. Templates are matched as images.
- No network in tests. Real components; only the LLM is scripted.
- Stage by explicit path; run `pnpm test` and `pnpm typecheck` before each commit.
- The entry runs outside the 10 Hz tick, so a 100–300 ms match is acceptable there; the recognisers in the composite must keep a coarse first pass under the 50 ms half-tick.

## Review Focus

- A drag that starts on an icon selects it instead of panning the map.
- The party panel is up: the icon is covered, and the chevron tap must reveal it elsewhere.
- A node at the map edge (北穿幽冥城 on `07.jpg` scores 0.555) must be refused, not clicked.
- Two cities must not match the same node above threshold.
- The entry must stop on a non-1920×1080 frame instead of clicking scaled coordinates.

---

### Task 1: Drag through the engine

**Files:**
- Modify: `src/contracts.ts` (§4, §5)
- Modify: `src/engine/protocol.mjs`, `src/engine/protocol.ts`, `src/engine/gestures.mjs`, `src/engine/win32-native.mjs`, `src/engine/child.mjs`, `src/engine/win32.ts`
- Test: `tests/engine-gestures.test.ts`, `tests/engine.test.ts`

**Interfaces:**
- Produces: `MAX_DRAG_MS = 500`; `Actuator.drag(from: Point, to: Point, durationMs: number): Promise<ActionResult>`; `EngineRequest` member `{ op:'drag'; x1; y1; x2; y2; durationMs }`; `win32.drag(hwnd, x1, y1, x2, y2, durationMs)`.

- [ ] **Step 1: Write failing tests.** `tests/engine-gestures.test.ts`: a fake device records the order `move, down, move…, up`; a foreground loss mid-drag still sends `up` and reports `rejected`; `durationMs` above `MAX_DRAG_MS` is clamped; `releaseHeld` mid-drag sends the `up`. `tests/engine.test.ts`: the codec accepts a drag and drops one with a missing or negative coordinate, a non-finite duration, or `durationMs === 0`; `MAX_DRAG_MS < TEARDOWN_GRACE_MS`; `contracts.MAX_DRAG_MS === protocol.MAX_DRAG_MS`.
- [ ] **Step 2: Run them and see them fail** (`pnpm exec vitest run tests/engine-gestures.test.ts tests/engine.test.ts`).
- [ ] **Step 3: Implement.** In `gestures.mjs`, `drag` guards the foreground, `moveToClient(from)`, `mouseDown`, then `clamp(ceil(durationMs/25), 4, 20)` straight-line moves with `await device.sleep(durationMs/steps)` between, `mouseUp` in a `finally`, then the foreground guard throws `Refused`. In `protocol.mjs`, add `'drag'` to `OPS`, export `MAX_DRAG_MS`, and validate finite coordinates plus `0 < durationMs <= MAX_DRAG_MS`. In `child.mjs`, `case 'drag'` calls `win32.drag` and returns `inputAcknowledgement`. In `win32.ts`, `Actuator.drag` sends the request and `InputRequest` includes the drag.
- [ ] **Step 4: Run the tests and the full suite; add `drag` to every test fake the typecheck names.**
- [ ] **Step 5: Commit** `feat(engine): add a drag gesture for map panning`.

---

### Task 2: Fixtures, catalog and matcher

**Files:**
- Create: `testdata/worldmap/2026-10-24/{07,14,20,22}.jpg` (from `.tmp`), `testdata/frames/town-panel-down.jpg` (from `.tmp/120.jpg`)
- Create: `scripts/extract-location-templates.mjs`, `src/perception/location-templates.ts` (generated), `src/perception/locations.ts`, `src/perception/match.ts`
- Test: `tests/match.test.ts`, `tests/location-templates.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface MatchTemplate { readonly width: number; readonly height: number; readonly gray: Uint8Array }
  interface Match { readonly at: Point; readonly width: number; readonly height: number;
                    readonly score: number; readonly scale: number }
  function findTemplate(image: RgbaImage, area: PixelRect, template: MatchTemplate,
    options?: { scales?: readonly number[]; minScore?: number }): Match | null
  interface LocationEntry { readonly id: string; readonly label: string;
    readonly screen: 'worldmap' | 'dungeon-select'; readonly template: MatchTemplate }
  const LOCATIONS: ReadonlyMap<string, LocationEntry>; const LOCATION_IDS: ReadonlySet<string>
  ```
  Catalog ids: `world-map-icon`, `panel-chevron`, `inn`, `city-royal`, `city-port`, `city-dhi`, `city-fortress`, `vnh`, `ffxi-gcn`, `ffxi-zone1`, `ffxi-zone2`, `ffxi-zone3`.

- [ ] **Step 1: Promote the fixtures** with `git add` by path; they are the engine captures at 1920×1080.
- [ ] **Step 2: Write failing tests.** `tests/match.test.ts`: the synthetic self-test (a crop of a random image matches at its own offset, score 1.0); a template scaled to 0.66 matches `120.jpg` at (1169,1005) with score ≥ 0.90; a low-variance window never scores. `tests/location-templates.test.ts`: every catalog entry used by the entry (`world-map-icon`, `panel-chevron`, `vnh`, `ffxi-gcn`) clears 0.80 on its fixture; the icon on `town-0.jpg` (panel up) is below 0.80; `ffxi-gcn` on `07.jpg` (clipped) is below 0.80; `vnh` and `ffxi-gcn` do not match each other's boxes.
- [ ] **Step 3: Implement the extraction script** (`scripts/extract-location-templates.mjs`): decode each source with `ffmpeg -f rawvideo -pix_fmt gray`, print a generated TS module with base64; sources are the legacy art in `../wvd/resources/images` (`common/intoWorldMap.png`, `common/closePartyInfo.png`, `zh_CN/Inn.png`, `zh_CN/City_*.png`, `zh_CN/FFXI/{City_VNH,GCN,ZONE1,ZONE2,ZONE3}.png`) with the id and native size. Run it and commit the generated module.
- [ ] **Step 4: Implement `findTemplate`.** Convert the area to grayscale; for each scale in `[0.62, 0.64, 0.66, 0.68, 0.70, 0.72]`, bilinear-resize the template, run a stride-4 NCC pass, then refine the best candidate at full resolution; return `null` below `minScore` (default 0.8) or when the window variance is under 100.
- [ ] **Step 5: Run the tests, the full suite and the typecheck; commit** `feat(perception): match the legacy location art at the PC UI scale`.

---

### Task 3: Town and world-map recognisers

**Files:**
- Create: `src/perception/location.ts`
- Modify: `src/main.ts` (register both after `HudPerceiver`)
- Test: `tests/location.test.ts`

**Interfaces:**
- Produces: `class TownPerceiver implements Perceiver`, `class WorldMapPerceiver implements Perceiver`.
- Consumes: `findTemplate`, `LOCATIONS` (Task 2).

- [ ] **Step 1: Write failing tests.** `TownPerceiver`: all five `testdata/frames/town-*.jpg` and `town-panel-down.jpg` are `town` at confidence ≥ 0.5; `view`, `map`, `combat`, `prompt`, `third-floor` are `unknown` at 0.2. `WorldMapPerceiver`: `07/14/20/22` are `worldmap` at ≥ 0.5; every other fixture is `unknown` at 0.2.
- [ ] **Step 2: Implement `TownPerceiver`.** Match `panel-chevron` and `world-map-icon` over the band `{x:0,y:720,width:1920,height:360}`; `town` when the best score ≥ 0.80, confidence `0.5 + 0.5·(score−0.8)/0.2`; otherwise `unknown` at 0.2. Refuse a frame whose width/height are not 1920×1080 with `unknown` at 0.2.
- [ ] **Step 3: Implement `WorldMapPerceiver`.** Cheap gate first: stride-4 mean over `x 0–400` and `x 1520–1920` is < 8 luma on both sides (measured 0.0/1.5 on the map, ≥20.5 everywhere else) and the middle `x 500–1500, y 100–900` mean is > 60. Pass → `worldmap` at 0.9; else `unknown` at 0.2.
- [ ] **Step 4: Register both in `main.ts` after `HudPerceiver`** so the common dungeon frame still exits the chain at the HUD.
- [ ] **Step 5: Run the tests, the full suite and the typecheck; commit** `feat(perception): name the town and world-map screens`.

---

### Task 4: `openWorldMap` and `travelTo`

**Files:**
- Create: `src/actions/worldmap.ts`
- Test: `tests/worldmap-action.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface WorldMapEnv { readonly actuator: Actuator; readonly capture: () => Promise<Frame>;
    readonly observe: (frame: Frame) => Promise<Observation>; readonly sleep: (ms: number) => Promise<void>;
    readonly abort?: AbortSignal; readonly log?: (line: string) => void }
  type TravelResult = { ok: true } | { ok: false;
    reason: 'world-map-control-not-found' | 'location-not-found' | 'unknown-location' | ActionFailure; detail?: string }
  function openWorldMap(env: WorldMapEnv): Promise<TravelResult>
  function travelTo(to: string, env: WorldMapEnv): Promise<TravelResult>
  ```
- Consumes: `LOCATIONS`, `findTemplate` (Task 2); the recognisers (Task 3); `Actuator.drag` (Task 1).

- [ ] **Step 1: Write failing tests** with a fake actuator, frame source and observer: icon on screen → one tap at its centre; panel up (icon 0.475, chevron 0.955) → chevron tap, then icon tap; neither → `world-map-control-not-found`; node on the first view → tap; node only after `Q` → three `Q` presses; node only after a drag → the drag then the tap; never found → `location-not-found`; low score → no tap; drag `rejected` → `rejected`, no retry; unknown id → `unknown-location`; `dungeon`/`dungeonmap` → ok, no input.
- [ ] **Step 2: Implement `openWorldMap`.** Observe; `worldmap`/`dungeon`/`dungeonmap` → ok; find the icon in the frame → tap its centre, then poll for `worldmap` ≤5 s; else find the chevron → tap, sleep 300 ms, capture, find the icon → tap, poll; else the typed failure. A `rejected` press returns immediately.
- [ ] **Step 3: Implement `travelTo`.** Resolve the catalog entry; observe; if in `dungeon`/`dungeonmap` → ok; ensure `worldmap`; match the node; found → tap the centre and poll until the screen is not `worldmap` (≤6 s, `loading` counts as leaving); not found → press `Q` up to 3 times, re-match; then 8 drags of 400 px (right, down, left, up, diagonals) from a safe point (the 64×64 window in the map field with the least edge energy, ≥80 px from the matched controls), re-match after each; budget spent → `location-not-found`.
- [ ] **Step 4: Run the tests, the full suite and the typecheck; commit** `feat(worldmap): find the world-map icon and the destination node`.

---

### Task 5: The `travel` step and the FFXI task file

**Files:**
- Modify: `src/contracts.ts` (§10), `src/tasks/schema.ts`, `src/tasks/steps.ts`, `src/tasks/runner.ts`, `src/main.ts`, `tasks/ffxi-4f.json`
- Test: `tests/task-schema.test.ts`, `tests/task-steps.test.ts`, `tests/task-run.test.ts`, `tests/world.test.ts`

**Interfaces:**
- Produces: `TaskStep` member `{ op:'travel'; to:string }`; `ScriptEnv.travel(to: string): Promise<TravelResult>`; `parseTask(text, knownLocations)`; `TaskFileProblem` member `'unknown-location'`; `ScriptFailure` members `'world-map-control-not-found' | 'location-not-found' | 'unknown-location'`.
- Consumes: `travelTo` (Task 4), `LOCATION_IDS` (Task 2).

- [ ] **Step 1: Write failing tests.** Schema: `travel` with `to` parses; an unknown id fails `unknown-location`; `travel` with `at` or a missing `to` fails. Steps: `travel` calls `env.travel(to)`; a failure ends the script at its index with that reason. Runner/world: the entry's `travel` runs before the first tick; a failed travel pushes exactly one `wvd.stopped`; a stop aborts.
- [ ] **Step 2: Implement the contracts and schema.** `parseTask(text, knownLocations)` validates `to`; `main.ts` passes `LOCATION_IDS`; `steps.ts` maps `TravelResult` to `Stop`; `runner.ts` builds `env.travel` from `travelTo` with the aborted sleep.
- [ ] **Step 3: Update `tasks/ffxi-4f.json`.** Entry: `expect town` (20 s), `travel ffxi-gcn`, keep the select tap `[1082,520]`, `expect dungeon` (45 s), then the existing map steps. Change `floor.titleKey` to the measured 第三区 key `0c0280000d6ff0000d7ffc0008c37000` (board p0); leave `exit` for the p0 rewrite.
- [ ] **Step 4: Run the full suite and typecheck; commit** `feat(tasks): enter the dungeon through a travel step`.

---

### Task 6: Live acceptance (operator-gated)

- [ ] **Step 1: Drag probe.** With the game foreground and the world map open, send one 300 px drag from an empty parchment point; compare the frames. If the view does not move, stop and record it in `docs/status.md`; the entry falls back to zoom-out only.
- [ ] **Step 2: Entry run.** Start in town with the party panel up; run the task file. Record `expect town` → `travel ffxi-gcn` → select 第三区 → floor gate.
- [ ] **Step 3: Pan case.** Pan the map so 北穿幽冥城 is off-view; run again; record the zoom/drag path.
- [ ] **Step 4: Record the measurements in `docs/status.md` and the guide; update the board note.**

## Self-Review

- Spec coverage: §5.1 → Task 2; §5.2–5.3 → Task 3; §6 → Task 4; §7 → Task 1; §8–9 → Task 5; §10 → Tasks 1, 4, 5; §12 → Task 6. The inn rest and the exit/rest leg are out of scope by §3.
- Type consistency: `TravelResult`, `findTemplate`, `LOCATIONS`, `LOCATION_IDS`, `MAX_DRAG_MS` are used with the same names in every task.
- Review Focus: Task 1 pins the drag order and release; Task 2 pins the covered icon and the clipped node; Task 3 pins the screens; Task 4 pins the safe point and the no-click-on-low-score rule; Task 5 pins the typed stop.
