# Status — WVD World v1

Where the plan stands. The plan file is the specification of the work, not the record of it: this file
is the record, updated at each milestone, and `docs/plans/2026-10-24-wvd-world-v1.md` stays the
authority on *what* each task requires.

Last updated 2026-10-24 21:40, on `feat/worldmap-entry`.

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