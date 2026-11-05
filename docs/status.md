# Status — WVD World v1

Where the plan stands. The plan file is the specification of the work, not the record of it: this file
is the record, updated at each milestone, and `docs/plans/2026-10-24-wvd-world-v1.md` stays the
authority on *what* each task requires.

Last updated 2026-11-02 22:10, on `main`.

## Task table

| # | Task | State | Commit(s) |
| --- | --- | --- | --- |
| 1 | Extension skeleton that loads | done, reviewed clean | `55541d0`, `15bdeb1` |
| 2 | Engine child — capture, foreground guard | done, reviewed clean, validated on the live game | `fcc51d2`, `3649cdd`, `87b69e5`, `68a4886`, `5571ea9` |
| 3 | Frame ring buffer | done, approved | `7bff768` |
| 4 | Map perception | done, approved | `6627242` |
| 5 | Automove command chain | done, approved | `b59275d` |
| 6 | Chest opener and QTE parser | done, approved | `b6a24df` |
| 7 | Route policy | done, reviewed clean | `41f2c56`, `a3f0c28`, `deb11b2` |
| 8 | Session lifecycle and escalation | done | `9392cc2`, `c4960f4` |
| 9 | Replay harness | done, approved | `1c9529e`, `e126d0c` |
| 10 | The loop and the composition root | done, final fix wave reviewed clean | `b7ad52b`, `2cff58c`, `61b341b` |
| 11 | Recognise the 3D view | done, reviewed clean | `2be0357`, `6df13ff` |

421 tests across 28 files, `pnpm typecheck` clean.

## What runs

- The package mounts in Coopanion (verified through the host's own loader, `worldId: wvd`, api 6).
- The engine child captures the real game at 30 fps while **occluded** — 2.5 ms round trip, 23 ms
  native decode, 20 ms native encode — which is the whole point of the design.
- Screen recognition: the dungeon map (floor token, `X/Y`, chests, hazards, stairs), the 3D walking
  view, and the chest QTE bar (199 of 250 recorded frames parsed, the other 51 refused correctly).
  A frame that is on screen but namable by nothing is reported at a low confidence and **escalates**;
  only a uniform or black frame stops the session.
- One command at a time: the loop opens the map, walks to a chest or the exit, waits for arrival by
  scene stillness, and does not re-press keys while a walk is in flight.
- Escalation to Coo: a `wvd.stuck` event with a JPEG, one question open at a time, a 90 s wait, a late
  answer named as expired, and an hourly budget that stops the session.
- Stopping: engine failure, dead child, stop hotkey, stall, spent budget — each ends the session with a
  reason and exactly one `wvd.stopped`. A held key cannot outlive the process: the hold ceiling and the
  teardown grace are declared side by side in `src/contracts.ts`.

## Farm tasks as data (2026-10-24, after v1)

`tasks/ffxi-4f.json` now declares a location's entry script, the floor to verify and the exit
script; `src/tasks/` parses, runs and decorates it. Contracts §10 has the declarations, and
`Intent.run-script` is the policy's only new word. The World runs `enter` before the first tick,
`exit` when the policy says leave, and re-enters for `cfg.cycles` cycles.

Measured live the same day, and binding for the next attempt:

- **`MapState.titleKey`** (R27a): the FFXI floors print a Chinese title where the Latin slots
  expect `B1F`; `readMap` refused the whole map. The 32-hex fingerprint makes it readable —
  `000000007f3ffe007f7efe00220ba600` on `第四区-城内2F深处-`, stable across four frames.
- **The FFXI map's icons are not the B1F icons.** On `第四区` the map parses (title, player,
  `X:11 Y:23`) but yields **zero icons**; `L` (移动至宝箱) is inert on both FFXI floors. The route
  policy therefore sees "no chests" and would leave, so a task session cannot farm there yet.
- **`第三区-城内2F-` now parses, with three chests.** Its readout band carries the panel's
  scrollbar and the frame has single-digit coordinates; R28 (chrome columns), R28a (one or two
  digits), R28b (the scrollbar's glow on the last glyph) and R28c (a colon touching its label) are
  the four fixes, plus one extracted glyph for `5`. Fixtures:
  `testdata/nav-2026-10-24-ffxi4f/{third-floor,third-floor-glow}.jpg`.
- **The map is translucent over the 3D view**, so a lit background raises the lattice residual to
  ~5.8 and R29 raises its ceiling to 6.5. The same glow moves the title fingerprint by 2 of 128
  bits, so the floor gate compares with a tolerance (R27b).
- **The harken menu is the zone teleporter**: `第一区` / `第二区` / `第三区` / `第四区` (the zones
  that are not current), `归还` (town), `什么也不做`; it opens on *arrival* at the sparkle, not on
  `F`. `层数` switches which zone's map is drawn.
- **The harken is the white sparkle** (wvd's `harken.png` matches it), and the altar's `移动` menu
  (`第一区` / `第二区` / `第三区` / `归还` / `什么也不做`) is its teleporter. Standing on the
  sparkle does not open it; arriving by 自动移动 does.
- **The stairs were not triggered.** 自动移动 walks to the tile under the map's arch and stops; a
  forward key press and the map's `G` (移动至目的地) do nothing there. How the party climbs on the
  PC build is open.

## Round 3 — the chest path, measured

- **The farm path exists without `L`.** Pointer mode plus a click on a walkable tile shows
  `自动移动`; the party walks there and, standing next to a chest, the game offers `打开` /
  `什么也不做` (`testdata/chest/2026-10-24-opener/prompt-ffxi.jpg`). `L` (移动至宝箱) stays inert on
  these floors, so the loop needs the pointer command.
- **The 由谁打开? panel on FFXI is the same panel** (`panel-ffxi.jpg`); the opener parser reads it
  through jpeg-js. Through GDI+ — the decoder the live World uses — a numeral's right edge lands one
  pixel over and the whole panel was refused. R30 walks the numeral's edges (0–6 left, 0–2 right)
  before refusing, which fixes the fixture panel and leaves one live card (爱丽丝, `90`) unreadable:
  its warm heart fringe fuses with the digits into a single 17-px run. `parseOpener` still refuses
  the whole panel when any heart is unreadable, so the live chest is not openable yet.
- The chest prompt screen (`打开` / `什么也不做`) is **not** in `ScreenId`; the perceiver reports
  `unknown` for it, so the loop cannot yet act on it.

### What the perceivers make of the FFXI screens (measured 2026-10-24)

| Frame | Composite verdict |
| --- | --- |
| 由谁打开? panel (`panel-ffxi.jpg`) | `chest-open` 1.00 — the chest module's own screen |
| dungeon map, third floor | `dungeonmap` (after R27a–R29) with three chests |
| combat (`combat.jpg`, auto + 倍速 on) | **unknown 0.20** — no recogniser names a battle |
| chest prompt 打开 (`prompt-ffxi.jpg`) | **unknown 0.20** — not in `ScreenId` |
| 3D view walking | `dungeon` (HUD) |

So two of the five screens a farm cycle needs are unnamed on these floors: **combat** and the
**chest prompt**. The loop classifies an unknown screen at positive confidence as an escalation, so
a session on this floor would escalate the moment a battle starts — which it did, twice, during
this survey.

## Round 4 — the walk to a tile (2026-10-24)

- **`L` is inert on the FFXI floors**, including 第三区 whose map reads three chests. It is not the
  focus problem §3d of the guide settled: the key reaches the game and the map stays put, so no
  route that presses `L` can move the party on the floor this World farms.
- **Pointer mode is the movement command**: `R` (切换指针模式), a click on a walkable black tile, and
  a click on the `自动移动` element that click raises. Measured 2026-10-24: the element sits
  **79–84 px above the tile** (three instances), and clicking it closes the map and walks the party.
- **`MapState.origin`** (contracts §3) publishes the chevron's screen point, and `tileOnScreen`
  (`src/perception/map.ts`) is the grid→screen transform the icon reader already used, inverted.
  The route still speaks grid cells; the loop converts once, in `#execute`, and the canvas is never
  re-derived.
- **`automoveToTile`** replaces `automoveToChest` in `src/actions/automove.ts`: `R`, the tile, the
  element. The element is *assumed* at the measured rise, not detected — a tile that is not walkable
  raises nothing, the confirming tap lands on the map and is ignored, and the walk simply does not
  start. The in-flight rules already treat that as "changed nothing" and do not retry until the farm
  advances. A detector is the upgrade if that ever costs a session.
- The route policy is unchanged: it already named the nearest chest's cell, which is now the tile a
  walk is aimed at rather than an advisory value nothing read.
- **A QTE sample decodes in a fifth of a full frame.** Measured on `frame-3.jpg` with GDI+ — the
  decoder the World uses — the fixture's 1920×1080 JPEG takes **27.5 ms** (median of 3) and the same
  still cropped to `qteWindow` (631×699, 21.3 % of the pixels) and re-encoded at the engine's q75
  takes **5.0 ms** (minimum of 5): **1/5.5**, inside the design's 1/4 bound with margin
  (`tests/qte-band.test.ts`). Add the parser's measured 0.8 ms band-and-button read (chest spec §8a)
  and the 2.5 ms capture round trip, and a sample lands in **≈ 8 ms**; three of them (~25 ms) fit
  inside one 33 ms bar pass — the "three-in-one-pass" the design was after. The same claim holds at
  scale: all **199** parsed frames of the 250-frame recording were cropped to `qteWindow` and
  re-parsed, and every one agreed with the full frame's `QteState` (**199 band frames, 0
  mismatches**, `tests/replay.test.ts`).
- **The 60 fps experiment is still unmeasured.** None of the above says a faster game helps: the
  sub-loop was limited by the decode, and at 30 fps a sample now costs a fifth of a frame, so 60 fps
  stays an experiment to run against the 33 ms cadence, not a decision. `qteMinWindowMs` stays
  **150 ms** until #18 has measured the planned-instant → `SendInput` distribution.
- **The planning model is checked against the recording** — design acceptance 5, delivered by
  `planCheck` in `scripts/replay.ts`: each of the recording's `chest-qte` observations, at its own
  timestamp, feeds the last three readings through `qteVelocity` and `planTap`, and every returned
  plan is judged against what the recording actually shows. Plans are therefore produced from
  recorded marker motion; each target must lie inside a zone `measurements.json` recorded; none may
  cross the planner's own reversal points (656.5 / 1261.5, not the 694 / 1224 zone edges); and the
  marker position a plan predicts at the reading nearest its press instant,
  `x0 + v·(next.atMs − reading.atMs)`, must agree with that reading within **12 px**. The
  prediction is evaluated at the reading's own time, not at the press instant: that reading can sit
  up to one frame (33.3 ms, 20.4 px of travel at 610 px/s) from the instant, and predicting at the
  instant spends the allowance on the lookup's own offset. At the reading's own time the residual
  measures only the velocity estimate's error; over the **38** compared plans it is **0.05 px min,
  2.09 px median, 5.98 px p90, 8.25 px max** (the worst is ~3 % velocity error over a 452 ms plan),
  so 12 px leaves ~45 % headroom while staying under the ~27 px a 10 % speed error leaves on a
  450 ms plan. The recording yields **51 plans, 38 press positions, 0 violations**: 44 plans have a
  reading within one frame of their press instant, but six of them (frames 15, 30, 45, 60, 75 and 90;
  press delays 8–16 ms) name an instant after their own reading, so the nearest reading *is* that
  reading — predicting its position from itself is a tautology (residual 0), and at those delays a
  10 % speed error moves the marker 0.5–1 px, so they cannot discriminate it and are counted as
  unchecked, not as passing. The other seven name instants after the recording's own press (~3.3 s),
  when the operator has braked the marker to rest, so there is no straight line the recording can
  compare them with. Triples that straddle a bounce refuse legitimately, so `tests/replay.test.ts`
  pins ≥ 25 plans, 38 press positions and 0 violations rather than the plan count alone. **The
  press-position check is what catches a wrong sign or a wrong speed**: a sign error moves the
  prediction by `2·v·d`, hundreds of px on the long plans, and a 10 % speed error by ~27 px on a
  450 ms plan, both outside the 12 px tolerance. The zone and reversal branches cannot fire on this
  recording — `planTap` already refuses those targets — so `tests/replay-plan.test.ts` proves they
  fire with synthetic inputs instead of implying coverage from the recording.

## Round 5 — the floor-transition markers (2026-10-24)

The map now names its own crossing markers. Which of them cross is the operator's account: **the
harken and the entries/exits cross; the orchid ring only moves the party within a floor.**

- **`harken`** (哈肯, the white 4-point sparkle) is read on every floor — B1F (20,21), 第三区 (6,24),
  第四区 (10,23). The game draws it at two sizes (16 px, 12 px) and one scale cannot carry it: at
  16 px it scores 0.84 on the hole glyph and 0.78 on a B1F background cell that outranks that floor's
  own sparkle. Matching both scales behind an ink gate gives 0.72 / 1.00 / 0.72 against a 0.63 best
  impostor — and it is what finally reads 第四区 and the glow frames, which parsed as *zero icons*.
- **`teleport`** — the orchid ring. Five on 第四区, matched as a colour rule (R≈148 G≈50 B≈188) with
  no false pixel on any other committed frame. It is an intra-floor marker: no route may cross on it.
- **`hole`** — the white down-arrow over an oval, two on 第三区 at NCC 1.00 / 0.98 vs 0.65 elsewhere.
  **`stairs`** is unchanged (B1F only); no direction is published, because no fixture carries the
  mirrored `stair_down` orientation.

Identification and initiation meet at one cell: `tileOnScreen` maps the published cell to the screen
point `automoveToTile` clicks, pinned by a test against 第四区's ring (12,18) → (925,446) and its
measured centre (923.5,449). Navigation design §6 is the record; which entry/exit a floor crosses at
is left to the live pairing the p0 FFXI session owes.
## World-map entry (2026-10-24)

Implemented on `feat/worldmap-entry` (`8be41cb`, `713568e`, `87def23`, `b8b1a91`, `75fb3e1`);
460 tests, typecheck clean. The design is
[`2026-10-24-worldmap-entry-design.md`](specs/2026-10-24-worldmap-entry-design.md); the plan is
[`2026-10-24-worldmap-entry.md`](plans/2026-10-24-worldmap-entry.md).

- **Drag** is in the engine protocol and the gesture rules (contracts §4/§5): press, linear moves,
  release, 500 ms ceiling, inside the teardown grace.
- **The legacy location art matches the PC UI at 0.675.** Scaled by the matcher: world-map icon 0.975
  @0.66, panel chevron 0.955 @0.68, 诺森霍洛村 0.955 @0.66, 北穿幽冥城 0.989 @0.68. The icon scores
  0.475 with the party panel up, and a clipped 北穿幽冥城 0.555 — both refused. `wvd/AGENTS.md`'s
  "useless against 1920×1080" is false as written.
- **`TownPerceiver`** names the five town fixtures and the panel-down capture; 16 ms on the live
  frame. **`WorldMapPerceiver`** uses the black letterbox pillars (0.0 / 1.5 mean luma against
  ≥20.5 on every other committed screen).
- **`openWorldMap` / `travelTo`**: icon at its hit point (the template centre is 17 px off) → node;
  then three zoom-outs, eight 400-px drags and two zoom-ins; a score below 0.80 is not a node, and the
  action never falls back to a coordinate. A stale capture is retried three times.
- **`travel`** is a task step; `tasks/ffxi-4f.json` now starts `expect town` → `travel ffxi-gcn`
  and gates on the measured 第三区 key.

Live run 2026-10-24 23:33, from the town to the floor:

- **`focus` works**: a lone Alt tap + `SetForegroundWindow` brought the game foreground (the
  technique Coopanion's computer use uses); the session now does it at start.
- **The world-map entry works**: the town named at 0.95, the parchment icon matched at 0.98 and
  opened the map at its hit point (1177,1012 — the template centre, 1194,1024, does nothing);
  北穿幽冥城 matched; Dungeon Select's row at (1082,535) loaded 第三区; the dungeon map's key
  `0c0280000deff8000d7ffc0008c37000` matches the task's key within the 8-bit tolerance. **The floor
  gate passes.** The live minimap centre is (1787,96).
- **The 3D view is named by its minimap.** The operator's rule — a minimap in the top-right corner
  means the dungeon — is now the Hud's fallback: the saturated yellow player arrow measures **35 px**
  in both 3D views and **0** on every other committed screen. The live view named `dungeon` 0.8; the
  minimap tap at (1787,96) opened the map; the floor key matched again. The replay tally moves with
  it: **48 unknown + 3 dungeon** (was 51 unknown) — see the screen table below.
- A stale capture during the first travel is now retried three times; the action also zooms in (E)
  after the drags, per 诺村/北穿.
- **The Dungeon Select row is matched by its label**, not clicked at a coordinate: the catalog's
  `ffxi-zone1/2/3` entries are `dungeon-select` destinations, and `travel` to one taps the row its
  template matches (第三区 0.781 at scale 0.70, centre (1098,534)). `ffxi-4f.json` uses
  `travel ffxi-zone3`; a frame without the row is `location-not-found` and taps nothing.

The rest town is 诺森霍洛村 (`vnh`), chosen by the operator.

## Screen classification (2026-10-25)

Every screen now has a **standing** on every frame: the frame's cheap facts (`facts.ts` — the
minimap's arrow, the centred title band's ink, the two battle-button windows) either support the
screen or rule it out, and a recogniser cannot win a screen the frame rules out
(`CompositePerceiver.classify` returns the standings with its answer, and the live CLI prints them).

- **The zeros are the measured part**, over 1920×1080 frames: a battle carries 0–1 px of title ink
  and 0 arrow px; every map 759–1 824 title px; the 3D view 35 arrow px and no title; the town,
  Dungeon Select, the opener panel and the chest QTE 865–5 251 title px.
- **What it changed.** The B1F map `nav-1024-0213/popup.jpg` fills both battle windows (0.0355 /
  0.0212) and was fought on whenever the map parser refused the frame; its title band now rules
  `combat` out before the windows are read. The chest recording's light burst (frames 124–127,
  title 6 400–7 075 px) was named `dungeon` by the arrow alone and is now `unknown` at 0.8: the
  frame is drawn, the screen is not the walking view.
- **What it does not do.** The standings are ordinal, not calibrated — the labelled corpus is about
  twenty screens — and the recognisers are still tried in an order, because scoring every
  recogniser on every frame would not fit the 50 ms half-tick. The table decides what is impossible;
  the order only decides what to materialise first.

## The lattice gate is a support count (2026-10-25)

The live 第三区 capture the farm owed was refused as `unknown` while the party stood at the harken:
`X: 7 Y: 24` on screen and every gate but one readable. The gate was G6's residual ceiling — 7.86 px
against R29's 6.5 — and the residual was not measuring the lattice. The harken's light column is
white and unsaturated, so it counts as map ink and lights long runs of the row profile (52, 4 and 20
rows where the committed glow capture has one 82-row band); `lineCentres` centres each run, so that
band contributed three off-grid points instead of one, and a least-squares fit followed them.

G6's quality test is now **support**: how many of the frame's own line centres lie within 2 px of the
fitted 36-px grid, on the X axis only. Measured over every committed 1920×1080 frame: maps 9–19 (B1F
15, popup 19, 第四区 12, 第三区 10, its glow capture 9, the live capture 9); non-maps at most 3 (the
town HUDs 0–2, Dungeon Select 2, the rest fewer than eight detected lines). The floor is 6. The Y
axis is still fitted for its phase — the icon rows and the chevron's cell — but it cannot carry a
quality test on these floors: the glow crosses its rows, and its support reads 1–2 there.

The fit itself is unchanged (it still minimises the residual: the phase is geometry, not quality), so
no accepted frame moved — `third-floor.jpg` still reads 13,23 at chevron (959.5, 264.7), the B1F and
第四区 fixtures are unchanged, and no refused frame became a map. The live capture is committed as
`testdata/nav-2026-10-25-ffxi4f/third-floor-harken.jpg` and pinned in `tests/map.test.ts`; the
composite names it `dungeonmap` 0.8, reading the party at 7,24 with the harken at 6,24 and the two
holes at 1,17 / 20,8 — the clean capture's own cells. 482 tests, typecheck clean.

## Focus is a retry, not one check (2026-10-25)

The 2026-10-24 run put the cause of the chest QTE's failed Space presses outside the QTE. The World
that pressed them started at 20:31, the game was launched at 20:37, and the one focus attempt at
20:31 could not find a window. The log then names the cost: the 20:40 `open-map` was refused
`not-foreground`, and keys only worked after the World restart at 21:51 (`open-map` at 22:03 / 22:05
/ 22:28, and the 22:04:55 Space press that answered the bar). The sixteen 21:30 presses were the
pre-restart engine instance, not the QTE and not the key.

`focusGame` now gives the focus a buffer instead of believing one immediate check: four attempts
200 ms apart, and 200 ms after the window takes the foreground before the first input ([win32.ts](../src/engine/win32.ts)).
The child also looks again 120 ms after a refused `SetForegroundWindow` before reporting it
([child.mjs](../src/engine/child.mjs)). An input whose foreground check fails now asks for the focus
and only then refuses — so the first command after the operator launches the game can heal a session
the World started before it.

`tests/engine.test.ts` pins the retry, the settle and the no-input-on-refusal. 484 tests, typecheck
clean. The live half is the operator's: one Space press on an unpressed bar in a fresh session.

## Round 6 — the 4F stair and the way back (2026-10-31, live)

The operator's decision: farm **第四区** by taking the 第三区 stair up and back down; the QTE planner
defaults to **no brake term** (`worlds.wvd.qteBrakeEnabled = false`) until a probe says otherwise.

Measured live with the game open (1920×1080):

- **The stair up works.** On the 3F map (player 7,24, origin 744.7,230), `R` then tap **(960,158)**
  selects the door; the 自动移动 element is at **(960,236)** (not the usual 81 px above the tile).
  Confirming it walks the party to 第四区 and lands at a chest prompt.
- **The live 4F key is `000000007f3ffe007ffeff00220bb600`** (fixture `…7efe…`; 2-4 bits apart,
  inside the 8-bit gate). The 4F map shows the two chest icons and a harken, but `readMap` returns
  only six teleports — the chest/harken detectors miss them at this scroll. Pinned as a p0 board card.
- **The stair down works.** On the 4F map, `F` (移动至出口) walks the party to 第三区. On the 3F map,
  `F` walks to the harken altar; its menu opens on arrival.
- **The harken menu's 归还 is at (960,714), not (955,822).** It returns to **Dungeon Select**, not the
  rest town. The p0 card's coordinate is wrong for this menu.
- **The way home.** The Dungeon Select `打开世界地图` row matches the legacy `openworldmap` control at
  0.946 @ 0.68 (template centre (1028,650), hit (1100,666)); `src/actions/worldmap.ts` now has that
  branch. But `travel vnh` from the world map opened there still misses 诺森霍洛村 after 3 zoom-outs,
  44 serpentine drags and 2 zoom-ins; the town-to-map path is not yet proven. Pinned as a p1 board card.

## Round 7 — the entry hands the party to the loop (2026-11-01)

The 2026-10-31 entry could not satisfy its own 4F gate: `expectFloor` only matches while the map is
open (`src/tasks/steps.ts`), and the stair's `自动移动` lands the party in the 3-D view — the live
frames for that leg also show the 打开 prompt and a battle. A blind script cannot wait out a
game-driven walk, fight, or dismiss a farm prompt, and the map is opened by the loop after it. So the
gate moved to where the floor is read:

- `createTaskPolicy` checks **every** `dungeonmap` read against `task.floor.titleKey` (8-bit
  tolerance) and returns a `stop` intent naming both keys before the route can move from that map.
- The World's `#handOffEntry` seeds the existing in-flight arrival bookkeeping with the walk the
  entry's last step started (`walking: true`), so the loop's first command waits for stillness
  exactly as it does after its own `move`; the entry is progress, so the stall clock restarts there.
- `tasks/ffxi-4f.json` no longer ends with the 4F `expectFloor`; the entry ends where the stair walk
  begins. No contract changed (`Intent.stop.reason` was already a string; the task schema is
  unchanged).

Tests: the decorator's mismatch/tolerance cases and the loop's hold-until-arrival case
(`tests/task-run.test.ts`, `tests/world.test.ts`); the committed task file still parses
(`tests/task-schema.test.ts`). 103 targeted tests, typecheck clean. Live session: pending — start in
诺森霍洛村 with `worlds.wvd.taskFile = tasks/ffxi-4f.json`, `cycles = 3`.

## The world map, stored (2026-11-01)

The world map is now a stored artefact with measured geometry, and travel uses it before the
template spiral. Everything below was measured on the live 1920x1080 window.

**The engine bug behind "panning does not work".** The guide's §4.1 open item was real, and its
cause was ours: `moveToClient` moved the pointer with `SetCursorPos`, which relocates the cursor
without producing a pointer-motion event, so a drag built from it never panned — 20+ such drags
moved nothing. A drag that injects `MOUSEEVENTF_MOVE` (absolute, virtual-desktop normalised) moves
the map. `src/engine/win32-native.mjs` now injects the move; the measured pan gain is **2.05**
(100 px drag, label-anchored) to **2.48** (a run whose first drag had 2.48), so the navigator treats
it as nominal and corrects closed-loop. 53 engine tests, typecheck clean.

**Geometry, measured.**

- The map is drawn in a **960x1080 strip** at x=480; black pillars either side, the 放大/缩小 legend on
  the right pillar, −/+/关闭 inside the strip's bottom band.
- Zoom is discrete: **max zoom-out .. 3 steps .. max zoom-in**, measured **≈1.34x** content per step
  (max-out → 2 steps = 1.79x, max-out → 1 step = 1.30x, both by NCC on terrain).
- At max zoom-out the whole map is **1360x1496** atlas pixels: it pans ~400 px horizontally and
  ~416 px vertically. The vertical span was missed on the first pass because the capture's drag
  out-of-bounds clamp (a negative client y) silently refused every southward drag; the corrected
  capture reads the map's own clamp in both axes. Tiles are placed by the label offsets they report
  (five anchors agreeing to within 6 px), not by assuming the pan distance.
- **Labels scale with the zoom** (about 2.4x at max zoom-in), unlike the earlier note in
  `locations.ts`; at max zoom-out they are the size the templates were cropped at.
- At max zoom-out the game **culls colliding labels** — 北穿幽冥城 is culled — while every icon is
  still drawn, at **~0.45** of the legacy art's size (ffxi-gcn matched the atlas at 0.986, city-royal
  0.957, vnh 0.893).
- Clicking a **labelled** node's icon at max zoom-out travels (王都卢库纳里亚 validated live: the tap
  left the map at `town` 0.95). Clicking **北穿幽冥城's** icon at max zoom-out does nothing — the node
  needs the zoom level at which its label is drawn; that is the remaining work (pinned on the board).

**What is stored.**

- `testdata/worldmap/2026-11-01/overview.jpg` — the stitched max-zoom-out atlas, 1469x1080, from five
  pan positions whose offsets were measured by label displacement (0, -468, -209, -23, +41), plus the
  ladder frames (`max-out.jpg`, `level-in-1.jpg`, `max-in.jpg`, …) as the zoom fixture.
- `src/perception/worldmap-labels.ts` — generated by `scripts/extract-worldmap-labels.mjs`: seven
  label banners cropped from the atlas, in grayscale, with their atlas rectangles.
- `src/perception/worldmap-atlas.ts` — the geometry (map size, strip, zoom ladder, icon scale, the
  label rise, the safe tap area, the pan gain), the **site table** with eight nodes and their atlas
  coordinates and relative positions, and the pure geometry a navigator needs (offset from one
  matched label, screen point of any site, the safe-area test, the pan drag).
- `src/actions/worldmap.ts` — `travelViaAtlas`: open the map, press Q until the clamp (the clamp is
  the zoom state), match one label banner for the view offset, pan the target into the safe area
  (closed-loop, re-measured each pass), **confirm the node's own icon template at the projected
  point**, then tap. `travelTo` tries it first when `env.atlas` is set (the World's task travel and
  the live CLI set it); the template spiral remains the fallback.

Live validation of the pieces: the atlas located the live view exactly (vnh 0.975 at offset 510,0;
ancient-shrine 0.978; guard-fortress 0.972; red-sand-bastion 0.968), the navigator panned
510 → 210 → 55 → 0 to bring 北穿 into the safe area, and its icon confirmation first failed only
because the pointer sat on the icon — the pointer is now parked on the inert black pillar before each
measurement. 23 world-map action tests + dungeon-select tests, typecheck clean.

## The orientation — resuming from any screen (2026-11-02)

**The gap that made a farm session brittle:** the task file's `entry` was a blind script whose first
step was `expect town`. A stop or a crash that left the party inside the dungeon refused the next
session at step 0 (`expect-timeout: screen stayed dungeon`), and recovery was the operator's manual
`G` → `F` → `归还` → `travel vnh`. There were state *checks* but no state *machine*.

**The seam:** the task now declares where the farm is instead of how to drive there —
`goal: { site, zone?, climb? }` — and the World orients toward it one command per tick from
whatever screen the session started on. `src/policy/orient.ts` is the decision table: the map read
says `arrived` (on the farm floor), `climb` (on the measured stair floor) or `stop` (any floor with
no measured way off); `dungeon` opens the map; `dungeon-select` travels to the zone; town and world
map travel to the site; a chest, a bar, the loot card or a battle **yields to the farm route** so
nothing the party is doing is abandoned.

The measured stair-up (第三区, `R` then the door at **960,158** and the 自动移动 element at
**960,236**) moved from the entry script into the task file as `goal.climb`, gated on its own floor
key; the runner runs it as `runScript('climb')`. Any other floor is a stop before those taps.

**The loop the operator asked for:** after the exit script, the next cycle re-orients instead of
running an entry — farm, leave, come back, from wherever the exit left the party. Retries are bounded
(one travel, one climb) and each failure stops the session with its reason.

`tasks/ffxi-4f.json` is now a goal task (no entry, the climb inline, the exit unchanged). 607 tests
(`tests/orient.test.ts`, the schema's goal cases, the runner's climb gate, nine world cases) and
`tsc --noEmit` clean. Design: `docs/specs/2026-11-02-orient-goal-design.md`.

**Live, 2026-11-02 (two runs, both started with the party inside the dungeon):**

1. From a leftover loot banner (00:29): the World dismissed it, opened the map through the
   escalation fallback, read the farm floor and said "on the farm floor; the farm takes over" — the
   first time a session started inside the dungeon and reached the farm without a manual step. It
   then exited (the map showed no chest) and the exit script refused on one `stale-frame` capture;
   that probe now retries.
2. From the open 4F map (00:37): `on the farm floor` within the first second, and `chestsLeft: 1`.
   The farm's own walk then missed — the chest cell converted to a tap on the panel's top border and
   the party never moved, so the loop escalated at 30 s and stopped at 120 s with a clear reason.

Two board items carry what the runs found: `t-mvm2kfvh-d9kc0s` (the 自動移動 element — the tap 81 px
above a chest near the panel's top edge lands on the title bar, and a tile that raises no element is
indistinguishable from one that does; fixture `testdata/nav-2026-11-02-4f-top-edge/`) and
`t-mvy23qe2-nszsfl` (the G-menu view is `unknown`, costing the full 90 s escalation).

**The same-floor key measurement that the gate needed:** the live 4F map, re-opened from the menu,
read `600004007f3ffe007ffefe0002032200` against the task's `000000007f3ffe007ffeff00220bb600` —
9 bits, outside R27b's 8; the two collab floors read 30 and 31 bits apart the same day, so the
tolerance is 16 now. Without that, the orientation would have refused the floor it was standing on.

## Unreachable chests are skipped (2026-11-02)

The operator's rule, after the live walk missed on 第四区: a chest whose walk never starts — the tap
raises no 自動移動 element and the party does not move — has no path to it, so the farm skips it and
loots another; when none is left it takes its next stage (the exit script leaves the dungeon and
returns to the rest town), and the next cycle tries the chest again.

`RouteState.unreachable` (contracts §6) carries the cells so the route stays pure: it never aims at
one again, and answers `exit` when a floor's chests are all on the list. `world.ts` records the cell
when a `move` is given up (`#gaveUp`) instead of marking the command failed — which is what used to
wedge the farm: one miss, and the loop refused to move until the farm advanced, and it never did.

612 tests (`tests/route.test.ts` skip cases, `tests/world.test.ts` the skip-then-next-chest sequence,
and the earlier "sends one command" test now ends at the exit instead of at silence), tsc clean.
## The 自動移動 element is found, not assumed (2026-11-02)

The walk tapped a fixed 81 px above the clicked cell. On 第四区 that was wrong twice over: a tile near
the panel's top edge put the tap on the title bar, and a cell the game has no path to raises no
element at all. Both looked the same to the loop — the command "changed nothing" — which is what
stalled every live run tonight.

Measured with a new burst probe (`scripts/automove-burst.ts`: one process, tap, then six frames at
~120 ms, which the per-command CLI could never do): tapping the cell north of the party at (1248,766)
raised the pill over (1182,672)-(1322,706), its glyph 36 px left and 78 px above the tap at
(1212,690), and clicking the glyph walked the party. Tapping the chest cell at (924,154) raised
**nothing**.

`perception/automove.ts` matches that glyph — 28x28, generated from the frame by
`scripts/extract-automove-template.ts`, scoring 1.0 with the pill and at most 0.28 without, floor 0.7 —
in a band around the clicked tile. `automoveToTile` taps the element where the game drew it (the 81 px
rise stays as the fallback for a caller with no frame source) and returns a typed failure when none
appears. The World turns that failure into the same skip the 2026-11-02 rule uses, so an unreachable
chest costs one tick instead of a stalled session. 615 tests, tsc clean.

**Live, same night.** The World skipped the chest at 12,19 twice —
`the chest at 12,19 cannot be walked to (the tile raised no 自動移動 element); skipping it this cycle`
— and went to the exit. The harken's 归还 needed a **second tap** (the first only focused the row),
so `tasks/ffxi-4f.json` now taps it, waits 800 ms and taps again; after that the party reached
Dungeon Select and `travel vnh` returned it to the rest town.

Two perception gaps met on the way and are pinned separately: the G-menu 3-D view is `unknown`
(`t-mvy23qe2-nszsfl`) and the rest town's arrival dialogue is named `loot` (`t-mvy4482...`).
## The cycle pipeline, and the first live chest (2026-11-02)

The operator set the cycle's priorities: **1. healed before and after a battle, 2. claim every chest
available, 3. skip the ones that are not, 4. return to town and rest at the end of each cycle.** The
order was already the tick's (in-flight -> heal -> route) and the route's, so it is pinned rather than
rewritten: a world test proves the heal preempts the route's next command, and the chest-policy design
records the four steps and where each is enforced. One rule was added to serve 2 and 3 together: a
refused walk is **retried once** on the settled map, and only a second refusal marks the cell
unreachable — the first refusal is often the map's own fade, and a chest that is available must not be
dropped for it.

**Live, 02:35 — the first run to claim a chest end to end:**

```
18:35:45 open-map -> climbing (attempt 1)                    <- the goal form's climb, from 第三区
18:35:56 climb script finished (7 steps, 11036 ms)
18:36:02 on the farm floor; the farm takes over
18:36:03 move took effect: the party is moving on the map   <- the element detector's walk
18:36:10 move arrived: the screen is chest-prompt
18:36:11 opening the chest with #4 (陷阱解除 114) at the bottom-left card
18:36:14 chest QTE pressed: v=564 delayMs=77 target=1111     <- the first live QTE press
18:36:18 collected the loot card
18:36:24 unknown -> escalate
```

Fixed on the way (committed): the exit script's map-close settle, the harken's second 归还 tap,
`selectDungeon` waiting for its row's effect (it was tapped three times in a row), and the load window
that ended on the old screen still showing.

**What stopped this one:** the frame after the loot — the encounter intro (camera on the opened chest,
enemy names and an HP bar, no HUD, a ✕ at the bottom right) is named by nothing, so the loop escalated
after 5 s and paused for its 90 s question. Pinned as `t-mvy4p2vz-...`; the party stands at that chest.
## The battle opener's name read (2026-11-02)

The opener filter (contracts §11) was complete except for the name: `BattleMemberReader` answered
`null`, so every battle fell through to auto. The operator supplied the party's names — six members,
in the panel's own card order — and the read is now realised off the battle party panel:

- The command phase draws six member cards; **the turn card is tinted gold across its face** (mean
  `min(r,g) - b` of 53.7 and 33.9 on the two recorded command phases, against ≤ 3.5 on the others).
- `src/perception/party.ts` reads that card and answers the roster name (艾莉赛, 本杰明, 拉纳维尔,
  DragonSlayer, 爱丽丝, 薇薇安娜DEX6); `main.ts` hands it to the World as the `BattleMemberReader`.
- The ACTIVE band's glyph was measured and rejected: the band draws the name at a different size from
  the panel, and normalised cross-correlation against all six panel templates scored 0.25–0.37 for
  every candidate — no discrimination at all.
- Guards: the battle HUD's own evidence first (`battleHudUp`, the same facts `CombatPerceiver` uses),
  then the gold floor 20 and a 2.5× lead over the runner-up. Anything else is `null` — a miss, no
  slot tap. The design record is `docs/specs/2026-11-02-battle-member-read-design.md`.
- 635 tests, tsc clean.

**Live, 22:14 — the first cast.** A farm cycle reached the floor, claimed the chest, and a battle
followed the loot. The reader named the member and the filter cast:

```
22:14:48 open-map was overtaken: the screen is now combat
22:14:49 cast 爱丽丝's 右上 opener at party-front
```

The heal resolved (爱丽丝's MP 161 -> 152 = the skill's 9 MP cost; 拉纳维尔 256 -> 497 HP), and the
next command phase drew DragonSlayer's card gold — the member after Alice in the speed order, and
not on the list.

**Revised 2026-11-03 — the operator's call.** Alice's opener is now the **bottom-left slot**: 拉巴迪奥
斯的秘术, whose 攻击范围 is 全体, aimed at an **enemy** — any enemy tap resolves the whole group.
`BATTLE_OPENERS` is `{ name: '爱丽丝', slot: '左下', target: 'enemy' }`. The party-target form
(`PARTY_FRONT_AT`) stays in the contract for a skill that covers one row; no configured member uses it
today. This does not settle `t-mvzds4ku-efhjkd`: the live cast's *target tap* selected nothing, and the
enemy side is a new point that needs the same measurement.

## A title is characters: the 3-D view with its menu legend is `dungeon` again (2026-11-03)

The operator asked why the frame with the menu legend
(`testdata/screens/2026-11-03-gmenu/gmenu-3d-view.jpg`) is not `dungeon` although the minimap is
drawn — and set the rule: **a title bar needs a title, characters and words; with nothing there it is
not a title bar, so it is the dungeon. Whenever a minimap, it is the dungeon.**

The measured cause: the band's 5 119 bright pixels were the room's glowing wall, not text. The raw ink
count treated any bright pixel as a title, ruled `dungeon` out, and left the frame unnamed — the same
bright-frame case the map parser met on 2026-11-01.

`titleBarInk` now counts **text ink**: a bright pixel within 2 px of a pixel below luma 90 — a stroke
carrying its own dark gap. Calibrated over the 1 080p corpus (`map.ts` carries the table): real titles
1 159–1 854 px, the world map 306, the chest QTE and opener panels 31–56 (above the floor, so their
corner gold still rules the 3-D view out), **the menu frame 0**, the rest town 0, battles 0–1. Floor
20. The menu frame now reads **`dungeon` 0.96** and no recogniser changed.

`dungeonLike` and the map press before the question stay: a 3-D-like frame that no recogniser names (a
genuinely new overlay) is still recovered by asking the game's own map, and only a frame still unnamed
afterwards is the unnamed policy's business.

**The cast exposed two things.**

1. **The auto press is now a fallback** (operator rule, same evening). The loop presses 倍速 + 自動
   again while the battle is still on screen — paced at 1.5 s and capped by
   `autoBattleEnableAttempts` (contracts §8.5, the key the config declared and the loop had never
   used), re-armed when the battle leaves (`#track`). A press swallowed while a skill resolves no
   longer leaves the fight to the stall clock. Four world tests pin the retry, the cap, the re-arm and
   the once-per-battle cast; 639 tests, tsc clean.
2. **The cast did not reach its target** (pinned `t-mvzds4ku-efhjkd`). Four minutes after the two
   taps the panel still showed the skill's *preview* (MP 161 > 152, target rows up) and the heal only
   landed later, on the game's idle timeout — so the slot tap opens the panel and the target tap at
   (787,939) selects nothing. Candidate causes: the 700 ms settle, or the panel layout's row geometry
   (with the panel up the party grid moves up ~84 px). One live battle with the cast measured decides
   it; that is the operator's call to start.
## Readers, and the harken's floor menu (2026-11-03)

The operator's rule: *a reader is a primitive module — similar readers can all inherit a basic reader
class, similar attributes.* `perception/reader.ts` is that base: `FrameReader<T>` (a region of a frame
in, `{ value, confidence }` or null out, never a throw), the region/scaling helpers, and
`StripLibraryReader` — a fixed band whose label is matched against a **measured library** (labels are
learned patches, not decoded text). The design record, with the survey of the readers that already
exist (findTemplate, parseMap, the per-screen measures) and how each becomes a subclass, is
`2026-11-03-readers-design.md`.

The first new consumer is the harken's floor menu (`perception/harken.ts`, fixture
`testdata/screens/2026-11-03-harken-menu/harken-2f.jpg`): rows found by their text lines in the centre
band, each label matched against `harken-library.ts` (第一区-城外-, 第二区-城内1F-, 第四区-城内2F深处-,
归还). **The list is not fixed** — a harken offers a floor only once that floor's harken is reconstructed,
so a new harken may draw nothing but 归还 — and the reader says `null` for a label it has never measured.
The World taps the row the climb names (`goal.climb.destination`); when the menu does not offer it, it
taps 归还 and the stair icon is the way up. Because a script owns the loop while it runs, the climb also
gets a step of its own — `{ "op": "harken", "destination": "第四区-城内2F深处-" }` polls for the menu and
taps the named row (or 归还) — so the climb is now `expectFloor → F → wait → harken → wait → expect
dungeon`, with no measured tile anywhere.

## The character page is a screen now, and the loop closes it (2026-11-03)

The one-key heal opens a party member's page; twice tonight (03:18, 03:39) the close tap was swallowed
and the page — named by nothing — held the loop: a 90 s question, then a stall. The frame is saved as
`testdata/screens/2026-11-03-character-page/page-1920.jpg` and its **X 关闭 tile** (61×67 at (683,983))
is the evidence: template-matched in the bottom band it scores **1.000** on the page and **at most 0.357**
on every other 1920×1080 frame recorded (battle command phases, the 3-D view with its menu legend, a
dungeon map, the town, the opener panel, the revive QTE). `character-page` is a `ScreenId` now, with a
perceiver of its own.

The World *finishes* the page: one tap on the close per tick (capped at three, warned once), and the
next frame proves it left. The close was measured live: one tap at (699,1012) drops the page and the
frame answers `dungeon` 0.88; a second tap at the same point on the 3-D view opens *another* member's
page, so the close is never doubled blindly. The heal waits `HEAL_CLOSE_SETTLE_MS = 1.5 s` after 恢复
before its close — the 03:18 failure was that window.

661 tests, tsc clean.

## The battle order: speed → opener → auto → finish (2026-11-03)

The operator's rule: *1. check multi speed on, 2. team member open skill cast if set, 3. auto battle
on, 4. finish combat.* Both battle buttons are **toggles**, so the order needs their state, not just
presses. The `combat` observation now carries `speedOn`/`autoOn` (contracts §2): a toggle that is on is
drawn gold, one that is off white/grey — measured over the same 60×60 windows the facts count, warm
**39.5–56.4** when on against **1.0–2.3** when off (`alice-command-phase.jpg`: both off;
`command-phase.jpg`: 倍速 on, 自動 off).

The World's fight branch follows the order literally:

1. `倍速` — pressed only when the frame says it is off; then return, and the next frame says whether it
   took.
2. **The opener** — read and cast (the 3 s read window still applies, and 自動 waits while the read is
   owed: auto would take the command phase the cast needs).
3. `自動` — again only when the frame says it is off.
4. **Finish** — both on and the opener decided: nothing is pressed; the mode holds until the battle
   ends and `#track` re-arms the counts for the next one.

Both presses are paced by `AUTO_PRESS_RETRY_MS` against `#togglePressAtMs` and capped by
`autoBattleEnableAttempts`, with one warning when a cap is spent. The commands split into
`battleSpeed`/`battleAuto` (`enableBattleAuto` stays for one-off scripts and measurements).

658 tests, tsc clean.

## The battle's operations are a sequence (2026-11-04)

The operator's rule: *a battle is turn-based, not real time, so one decision can be made slowly. Do
the operations in order but not at the same time: wait for a stable frame, and pace them in units of
1 s, at least 700 ms. The timings are configurable from the start.*

The cause is measured in the code, not the live game: the pacing primitive keys its stability on the
**screen**, and inside a battle that key is `combat` for the whole fight — so "two stable frames" is
satisfied ~200 ms after the battle appears, while the party panel is still drawing (live 02:07: the
first combat frame read no gold card). And the World stamped the pace with the frame an operation
*started* on, so the opener's two taps and the 自動 press after them could be ~100 ms apart, inside
the skill's resolution.

`src/policy/battle-sequence.ts` now owns the battle's operations: settle → 倍速 → 自動 off (when
the cast is owed) → opener slot → opener confirm → 自動 → hold. One tap per tick, in that order, the
next step no sooner than `battleStepMs` after the previous tap returned. Three keys are the field knobs (contracts §8.5): `battleStepMs`
(1000, minimum 700 — the pacing primitive's floor), `battleSettleMs` (1000) and
`battleOpenerTimeoutMs` (10000, which replaces the old `OPENER_READ_WINDOW_MS` constant and the fixed
3 s window). The turn card is **confirmed** across frames, not read once: the same ACTIVE member on
two consecutive frames is the state (`BATTLE_STABLE_READS = 2`), and the loop keeps checking every
frame until the timeout rather than giving up after a short window. The sequence is created on the battle
**mode**'s first frame and dropped when the mode leaves, so an unnamed frame inside a battle can no
longer re-arm it (and a cast can no longer be sent twice).

**自動 is disengaged for the cast, in the first battle only (operator rule, later on 2026-11-04).**
*When starting a new farm task, at the first cycle when entering a battle, turn off auto battle if on,
then use the opener skill once, then turn on auto battle* — and, refined the same evening, *only the
first battle in the first cycle; in the following battles and cycles, only keep auto battle on.* So
the World hands the sequence its opener list for exactly that battle (`#cyclesDone === 0 &&
#battlesEntered === 0`, once per session); that battle, entered with 自動 on, is disengaged — 自動
off, the opener cast once, 自動 back on — because an auto battle draws no command phase. Every later
battle gets an empty list: the sequence only keeps 自動 on (presses it when the frame says it is off),
never casts and never reads a turn card. If 自動 will not come off within `autoBattleEnableAttempts`
tries the cast is given up and the battle plays itself.

`tests/battle-sequence.test.ts` pins the order, the one-per-pace rule, the pace measured from the
tap's return, the unreadable-panel wait, the not-listed fallthrough, the disengage sequence, the
no-toggle-evidence wait, the refused-tap rule and the attempt cap. `tests/world.test.ts` pins the
02:07 replay, the settle window, the fallback and the re-arm. The full suite is green (the change is a
timing seam, so it was run before and after, AGENTS.md §5).

**OWED:** the live battle — one session with the window untouched, the log's presses `battleStepMs`
apart and the battle reaching 自動 without a stall. Not run: it spends the operator's machine.

## The opener's 确认 is measured (2026-11-05)

The 2026-11-05 run cast the opener for the first time with the sequence in place
(`16:42:23 cast 爱丽丝's 左下 opener at enemy`), and then stalled on the **skill detail panel**: the
slot tap opened 拉巴迪奥斯的秘术 (取消 / 确定, MP 128 ▸ 103), the panel stayed up, the battle's HUD was
behind it and the loop read the frame as unknown. The enemy-side tap does not resolve this panel — the
operator's 2026-11-03 correction was right and the `confirm` point had never been configured.

Measured live on the stuck panel (`.tmp/panel-stuck.jpg`, 1920×1080): 取消 spans x 781–946 and 确定
x 971–1135 at y 975–1035; **确定 = (1053,1005)**. Pressing it resolved the panel and spent the skill's
25 MP (爱丽丝 128 → 103). `BATTLE_OPENERS` now carries `confirm: PANEL_CONFIRM_AT`, and the cast's
second tap is that button. `tests/battle-opener.test.ts` keeps the enemy-side form for an opener with
no confirm point.

## Stages are ticks, and a death is Coo's decision (2026-11-05)

The 2026-11-05 runs exposed two things the loop could not do. First, a task **stage** blocked the
World: `task.runScript('exit')` ran all 15 exit steps in one tick (48.7 s), so a battle that started
mid-exit was never dispatched — the script's `expect` timed out and the session ended
(`exit script stopped at step 1 (expect-timeout: screen stayed combat)`). Second, the death scene was
named but nothing acted on it.

Now `src/tasks/steps.ts`'s `advanceSteps` runs **one operation per tick** with a `StepCursor`
(next step, wait clock, expect deadline). The World hands it the frame it just observed:
`runScript(name, observation)`. A screen the loop owns — `combat`, any `chest-*`, `drop-item-claim`,
`main-character-dead` (`WORLD_SCREENS`) — yields `{ ok:false, reason:'interrupted' }` with the cursor
untouched; the next tick dispatches the plug-in by screen (the battle sequence, the chest pipeline),
and the stage resumes once its own screen is back. `enter` and `climb` still run blocking (they are
called outside the dispatch). A completed stage is `complete: true`; a per-tick partial is
`complete: false`; neither ends the session.

The death is escalated, not automated: `main-character-dead` → one `wvd.stuck` question to Coo with
the frame (the fallback is a **wait** — a death cutscene is not a screen to press into), and Coo
decides whether to close the game and the PC. `#deathEscalated` makes it one question per death.

`tests/task-run.test.ts` pins one-operation-per-tick, the yield-and-resume, and the wait clock;
`tests/world.test.ts` pins the interrupted stage's survival and the death question.

## The QTE press uses the measured carry, with a 95 % band (2026-11-05)

The chest path feeds its own measurements back into the plan (operator rule 2026-11-05). Each press
yields an input leg (the round trip, split by the child's `inputMs`) and, on a settled park, the
bar's carry time (`(restX − tapX)/v − delayActual − L`). The World keeps both for the bar on screen
and passes them to the next `timeQte`/`planTap`; `qteLatencyMs` and the brake model become the prior
for a bar nobody has measured yet. The plan now also returns a **stop band**: `Δ = |v|·ΔL + Δcarry +
T·Δv` (Δv = 5.8 % of v, ΔL = 15 ms, Δcarry = 20 px — chosen bounds, documented), and a plan is only
returned when that band lies inside a zone to **95 %** (`minOverlap`). A band that does not fit is
no press, not a gamble.

The measured evidence: carries 0.042 s at 457 px/s and 0.089 s at 558 px/s (both hits) on 2026-11-05,
0.044/0.069 s on the 2026-10-31 recordings, and 0.26–0.31 s on the 12:14 stuck bar (224 presses, all
misses) — a 7× spread that the fixed 0.1017 s model cannot cover. The input leg is stable at 62–76 ms.

`tests/qte.test.ts` pins the carry aim and the band refusal; `tests/qte-loop.test.ts` pins the plan
using a measured carry; `tests/world.test.ts` pins the feedback into the next call.

**OWED:** the first press of a bar still uses the config prior (no carry measured yet) — the
bootstrap; a bar whose prior band cannot fit the zone will not be pressed until it is measured, which
is the open policy question.

## The chest QTE measures its own timing (2026-11-05)

The chest path now measures the three terms the band model needs, on the run that produces them — no
new capture and no new request (operator rule 2026-11-05):

- `delayActualMs = pressAtMs − reading.atMs` — the delay actually waited, on the frame's own clock;
- `L ≈ ackAtMs − pressAtMs` — the press's round trip (IPC + the child's `inputMs` + the reply): an
  upper bound of the input leg, at most one game frame short of the registration;
- `tau = (restX − tapX)/v − delayActual − L` — the bar's carry, from a **settled** park only.

Two clock reads around the existing press are the whole cost; the child's `inputMs` splits the round
trip and the park is the rest read the loop already took. The QTE log line carries all three, and
`WVD_RECORD_QTE=1` writes them as JSONL (`.tmp/record/qte-<stamp>/qte.jsonl`: reading, plan, press,
rest, outcome) through `src/actions/qte-record.ts` — the sink is wired in `main.ts`, so the chest path
itself owns no file I/O.

What the five measured presses say: the carry is real on both days — 42.1 px at 953 px/s and 31.4 px
at 458 px/s on the 2026-10-31 recordings, 129.5 / 144 / 137.5 px at 439.5 / 550.8 / 449.5 px/s on
2026-11-05 — so the current no-brake plan is systematically short. Its coefficient is not a constant
(tau 0.044–0.306 s, 7×), so it must be measured per bar, which this change makes possible.

`tests/qte-loop.test.ts` pins the timing fields, the carry algebra and the refusal on an unsettled bar;
`tests/qte-record.test.ts` pins the sink.

**OWED:** the 95 % band gate (`stop ± Δ`, press only when the band overlaps the zone by ≥ 95 %),
which waits on recorded bars — the model is accepted, the data is now collected.

## The main character's death is a named screen (2026-11-05)

The 2026-11-04 run stalled at 16:06:57 on a frame the loop could not name — the camera fallen onto the
character's own gauntlets, no HUD — and the operator identified it as the **main character's death**
(traps, a chest's trap, or a battle). It is `main-character-dead` now (contracts §2), named by the
game's own treatment: the scene is rendered in **greyscale**. Measured on the live frame
(`testdata/screens/2026-11-05-main-character-death/death.jpeg`, a 1280×720 escalation snapshot): mean
saturation **0.000**, saturated pixels **0.00 %**, against 0.058–0.148 and 5.8–33.4 % on every other
recorded screen (battle command phase, revive QTE, dungeon map, chest prompt, character page). Black
transitions are excluded by luma (< 20). The rule is a fraction, not a rectangle, so it holds at 1280
and 1920.

The name is all there is (operator: *just name it*): the route **waits** on it and the game's own
revive changes the screen — no revive module, no recovery policy. `tests/death.test.ts` pins the
positive and the negatives.

## A party member's death is the revive QTE, and a stop is a stop (2026-11-05)

The second death the operator named (*a party member died during battle — like revive screen*) was
still an unnamed frame inside the battle **mode**: `testdata/battle-2026-11-02/revive-qte.jpg` at
`unknown` 0.80. It is `revive-qte` now (contracts §2), named by two facts of its own UI — the modal
close X in the bottom-right window (0.065 at 1920, 0.080 at 1280; 0.000 on every other recorded
screen) and the pale-violet revive ring in the centre band (3.4 % against at most 0.73 % elsewhere).
The recogniser runs **last** in the chain, so a chest, a list or the dungeon that a bigger recogniser
already named never reaches it; `tests/revive-qte.test.ts` pins the positive at both widths and ten
negatives.

The World's question was still a question, though: `main-character-dead` asked Coo and waited, and
nobody answers an unattended run. `worlds.wvd.stopOnDeath` (default false) now ends the session on
either death — the main character's scene or a member's revive QTE — with the frame pushed as
evidence. `scripts/world-run.ts` sets it for farm runs, writes `.tmp/runs/<stamp>/report.json`
(task, cycles, stop reason, final status, every pushed frame) and exits `0` only when the World
reports `task-complete`, `2` on any stop condition, `1` when the session never started. Its own
bounds are env-configured: `WVD_CYCLES`, `WVD_WALL_MS`, `WVD_SESSION_MINUTES`,
`WVD_STALL_SECONDS`, `WVD_ESCALATE_TIMEOUT_MS`, `WVD_REPORT_DIR`. The stop conditions an unattended
run must leave a record of — a death, a stall, a lost process — are exactly the three ways that exit
code becomes 2.

## The inn is a rest plug-in (2026-11-06)

The 2026-11-06 run ended stuck on the rest town's inn: the exit's town arrival escalated on a named
town frame, the question's map fallback opened the 旅店 dialog, and no recogniser could name it — the
loop asked about it every ~4 s until the run was killed. The dialog is a screen now (`inn`, contracts
§2), and the rest is a module of its own: `perception/inn.ts` reads the rows, `policy/inn.ts` chooses
one, `actions/inn.ts` taps it — the composition root binds the module's one command.

The operator's rule is the evidence: **the room options identify the inn** — a dialog offering rooms
(or 住宿, the row that leads to them) is the inn whatever the room types are. The rows are the game's
fixed UI, so they are measured positions rather than a text scan (the labels' dark outlines split a
scan into fragments on the live frame); each row's label is matched against
`perception/inn-library.ts`, generated by `scripts/extract-inn-labels.ts` from the two recordings
(`testdata/screens/2026-11-06-inn/`: the room list at 1280, the service menu at 1920). Two known rows
are the floor, so a stray match never turns a screen into the inn.

The choice is the operator's order: `worlds.wvd.innRoom` (default 标准房) when the inn offers it,
标准房 when it does not, the first room the dialog offers when neither is there (the "other room
types" case), 住宿 from the service menu, and 返回 / 离开 out of a list with no usable room. One tap
per pace; the rest scene and the healing are the game's, and the town it leaves the party in is the
orientation's business. Live check 2026-11-06: the probe answers `inn` at 1.00 on the service menu.

`tests/inn.test.ts` pins both recordings, the choice order and the negatives; `tests/world.test.ts`
pins the one tap the World sends.

### The message box, and the inn's visit state (2026-11-06)

The 01:53 live run rested (住宿 → 标准房 → 确定) and the game answered **背包已补充完毕。** — a centred
panel with a caption and a yellow continue mark. No recogniser named it: the loop escalated on it
every ~4 s, and when the chest's loot recogniser happened to claim it, it was dismissed as a loot card
by accident (that accident is why earlier runs looked like they handled it). It is `message` now: the
panel's border runs, the caption's ink and the yellow arrow (0.0031–0.0040 of its band, 0.0000 on every
other recorded screen) name it, and the World advances it one tap per pace.

The same run exposed the inn's missing **visit state**: after the rest the innkeeper's menu reappeared
and the module rested again, five times in 25 s. The room tap (or its confirmation) is now the visit's
commitment; after it the dialogs are backed out of (返回 / 離開 / 取消) instead of re-entered, and the
state resets once the party is back on the town's own screen.

**The confirmation is not one of the dialogs that follow (live 2026-11-06 02:03).** The room tap
committed the rest, the 确定 / 取消 confirmation came up, and the rested branch backed out of it with
**取消** — the module left all three dialogs cleanly and the party never slept. The confirmation belongs
to the rest the visit already committed, so the policy answers it even when the visit has rested; only
the dialogs after it (the room list, the service menu) are left.

`tests/message.test.ts` pins both sizes and ten negatives; `tests/inn.test.ts` the rested order;
`tests/world.test.ts` the box's one tap and the inn's leave-after-rest behaviour.

## The QTE model, calibrated on the press corpus (2026-11-06)

The chest path's priors were the last unmeasured part of the timing model. The corpus — 257 presses
across the recorded runs (17 rerolls, 246 refusals, 22 settled parks, 8 presses carrying the child's
own `inputMs`) — gives the numbers the plan needs:

- **the input leg**: 61–76 ms, median 63.5 → `qteLatencyMs` **64** (was 75).
- **the carry is real**: the ten normal parks implied 0.04–0.10 s of slide past the press (two more
  implied −0.07…−0.05), so a plan without it schedules the press too late and parks past the target.
  The prior slide is **0.05 s** (`qtePriorCarryTauS`, the corpus median; the 2026-10-24 stop's
  0.1017 s was an outlier against it). **There is no brake switch and no deceleration constant any
  more** (2026-11-06): the plan's one slide term is a measured time — the bar's own park once it has
  one, else the prior — so the model the World runs is `qteLatencyMs` + `qtePriorCarryTauS` + the
  stop band, and nothing else.
- **the window floor is gone**: the hard `qteMinWindowMs` 150 ms test was a second opinion beside the
  stop band and blocked the fast bars (the 2026-11-06 run rerolled 113–150 ms passes five times and
  lost the chest). The band's 95 % overlap is the one "can this pass succeed" test; a pass the band
  refuses for a whole sub-loop is `no-reachable-zone`, and the World cancels the bar (a free cancel)
  up to `maxRerolls` to try another opener, then leaves it to the stall clock.
- **the band**: before a bar has a park its carry is uncertain by ±0.08 s → `QTE_CARRY_SPREAD_PX`
  **45** (was 20); after the park the bar's own slide is stable (±0.02 s on the stuck bar) →
  `QTE_MEASURED_CARRY_SPREAD_PX` **12**; the input leg's own spread is **12 ms** (was 15).

The 2026-10-31 bar that would not resolve (224 presses in 4.5 min, every press a refusal) is bounded
now: one bar may consume `QTE_MAX_TRIES_PER_BAR` = 6 sub-loops, after which the loop stops pressing it
and the stall clock owns the stop.

`tests/qte.test.ts` pins the prior's slide (0.05 s, 30.5 px at 610 px/s), `tests/world.test.ts` the
spread the World hands the timing call (45 px before a park, 12 px after) and the spin guard. The
corpus is the `.tmp` logs and `qte.jsonl` files (not committed); the fit is a one-off extraction over
them, and the numbers above are its output.

## The walk is aimed where the map draws the marker, at tap time (2026-11-06)

The 02:05 cycle left two chests behind and the operator asked why. The map showed three chests on
第四区-城内2F深处-, the farm opened one, then called the other two **unreachable** twice each and left:
`the chest at 21,4 cannot be walked to (the tile raised no 自動移動 element); skipping it this cycle`.

**The probe was not the fault.** Live, same map, same order the World uses (read the map, press `R`,
tap the cell), the pill was found at 0.87-0.91 in the first frame 120-150 ms after the tap, for both
chests: `21,4` at tap (1248,694) -> pill (1212,618), `19,5` at tap (1176,770) -> pill (1141,695). The
template, its two bands and its 0.7 floor are healthy.

**The aim was the fault.** `tileOnScreen` bakes the chevron `origin` of *the frame the decision came
from* into the tap point, and the map's canvas is not fixed: two reads of the same party cell
(`X:21 Y:1`) put the chevron at y 802 and y 914 — **112 px, 3.1 cells** apart — and the chest glyphs
moved with it. A tap aimed from the 802 pose lands three cells north on the 914 pose, on a wall, and
the game answers a wall with no element at all. Reproduced: three taps aimed from the stale pose
(both chest cells and the walkable cell north of the party) raised nothing; the same cells aimed from
a fresh frame raised pills every time. The retry could never save it: it re-tapped the *same* point.

The fix is the seam, not the timing. The World now hands `automoveToTile` the **grid cell** and no
point; the composition root binds `AutoMoveAim.locate`, which captures a frame *now*, reads the map
and returns the marker's point from it; the one retry re-locates instead of re-tapping. Two answers
are now kept apart that used to be one: a walk that raised **no element** is a cell with no path
(`timeout`, skipped as before), and a walk that could not be **aimed** — the map unreadable, or no
frame at all — is `unavailable`, which the World logs and re-tries, never skips: live 2026-11-06 also
logged four `capture timeout: stale-frame` failures in that same window, and "nothing was looked at"
must not become "no path". The orientation's 楼梯-门 command carries its cell for the same reason.

`tests/automove.test.ts` pins the re-located retry, the unaimable refusal and the no-frame answer;
`tests/world.test.ts` pins that an unaimed walk skips nothing; `tests/orient.test.ts` the cell.

## A cycle ends asleep at the inn (2026-11-06)

The operator's rule: **the full cycle ends with the rest at the inn.** The 02:36 and 02:40 cycles
both ended standing in the rest town — the exit script's last step is `expect town` and nothing
after it — so the farm had never slept on its own. The inn module was not the gap: the live dialog
is read at confidence 1.00 (rows 住宿/对话/离开 at 1114,488 · 578 · 641), the room list and the
confirmation likewise. The gap was the **entry**: the party has to be taken to the inn.

Measured live 2026-11-06 02:47-02:52 on the rest town's view, which is a row of facility icons
(旅店 (916,488), 酒馆 (712,635), 交易商 (1034,498), 道具店 (1195,574), 偏僻的打铁铺 (1143,415),
寺院 (806,399)): **one tap on 旅店 opens the dialog**, and the whole visit — 住宿 → 标准房 → 确定 →
13 s of frames nothing names → the `背包已补充完毕。` box → the menu → 离开 — takes **23 s**. The
guide (live control, §4.1) records the points and the shape.

So the task file grew a `rest` block (`{"at": [916, 488], "timeoutMs": 90000}`, contracts §10)
and the World grows a **gate**: when the exit script finishes, the World taps `rest.at`, the inn
plug-in rests the party, and the cycle counts once the party is back on the town's own screen — not
when the script ends. While the gate is armed it owns the tick (the route must not aim at the town)
and it holds the nothing-perceived stop, because the rest's own scene is ~13 s of unnamed frames: a
slow rest must not end an unattended run. A visit that has not taken the party within
`rest.timeoutMs` is given up on **with a warning** and the cycle ends unrested, so one missed tap
cannot wedge the 99-cycle run.

`tests/world.test.ts` pins the tap, the wait for the visit, the town that ends the cycle and the
unrested timeout; `tests/task-schema.test.ts` the rest block and its refusals. A task whose floor
cycle has no inn simply carries no `rest` and behaves as before.




## The battle read: the frame colour, and the first frame is too early (2026-11-03)

The 02:07 live cycle reached its first battle with 爱丽丝 ACTIVE — and the opener did not cast. The
saved frame explains both halves:

- **The active card is told apart by its frame.** The operator's reading: *the active icon is yellow to
  orange, while inactive is white*. The reader now measures `max(r, g) - b` over a 3 px ring inside each
  card's edge — 68.8 / 98.9 / 63.2 on the turn card across the three command-phase frames, 32.9 at most
  on the others (the red-marked card); floor 40 and a 1.5× lead. The face tint it used before separates
  more, but the frame is the marker the game draws.
- **The battle's first combat frame is not the read.** The party panel is drawn a beat after the battle
  screen: at 02:07 the read answered nothing on the first frame, and the same panel 30 s later scores
  68.8 on 爱丽丝's frame. The World now retries the read for `OPENER_READ_WINDOW_MS = 3 s` and does
  **not** press 倍速/自動 while the read is owed — auto would take the command phase the cast needs. The
  one shot is spent only by a readable window.

656 tests, tsc clean; the frame numbers are in `2026-11-02-battle-member-read-design.md`.

## The game's mode: a pipeline per state (2026-11-03)

The operator's rule: *a state machine for the game's states — in battle, in dungeon, chest open — so
each state triggers its own module or pipeline.* The reason is measured: the loop perceived only
**screens**, so a battle's own moments (a skill's resolution, a fade, the **revive QTE** on
`testdata/battle-2026-11-02/revive-qte.jpg`, `unknown` 0.80) each became an unnamed frame — a 5 s
settle, a 90 s question, a fallback that does not fit the battle it was already in.

`src/policy/mode.ts` holds the mode: `modeOf` reads the named screens into `battle`, `chest`,
`dungeon`, `travel`, `town` (or none), and `advanceMode` holds it through every unnamed or loading
frame. `battle` and `chest` are **modal**: two named frames of another mode are needed to leave them,
so a battle's fade cannot end the battle and a chest's bar may vanish between passes. `RouteState.mode`
carries it (contracts §6), the World does not ask about unnamed frames inside a mode, and the console
status prints `mode battle`.

The revive QTE is now *held* rather than questioned; its ring timing is the next card (`t-mvy6dvsw`).
The design record is `2026-11-03-game-mode-design.md`.

## Open work — the task board is the authority

This file records what landed and what was measured. **Open work lives on the task board and only
there**: pinned items carry the reproduction, the fixtures and the acceptance test, and a gap that is
not on the board is not being tracked. The board is the operator's list; a duplicate list here went
stale the moment the work moved (2026-10-24), which is why this section is now a pointer.

Specs (`docs/specs/`) and guides (`docs/guides/`) still record decisions and measured procedure —
they are the record of *why* and *how*, not a backlog.

## The standing instruction

The operator's goal for this session, recorded verbatim on 2026-10-24:

> after finishing all tasks and implementation, shutdown the pc. if there's hard blocker that need my
> decision, then pause, save the status and also shutdown the pc.

The implementation is finished and the tree is green. Two of the gaps above need the operator — a
captured opener panel and a live multimodal run — so they are recorded here rather than guessed at.

## How the work is tracked

- `docs/status.md` (this file) — the committed record.
- The SDD ledger, `wvd-agent/.worktrees/world-v1/.superpowers/sdd/2026-10-24-wvd-world-v1/progress.md`
  — working state, rulings, deferred minors, and the pre-flight scan. Git-ignored: it is scratch, and
  the rulings that matter are written into the specs instead.
- The task board — the user-visible list of what is open.