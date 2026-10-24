# Status — WVD World v1

Where the plan stands. The plan file is the specification of the work, not the record of it: this file
is the record, updated at each milestone, and `docs/plans/2026-10-24-wvd-world-v1.md` stays the
authority on *what* each task requires.

Last updated 2026-10-24 15:20, on `main`.

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

236 tests across 18 files, `pnpm typecheck` clean.

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
