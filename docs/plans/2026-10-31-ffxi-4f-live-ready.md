# FFXI 4F live-ready — implementation plan

> **For agentic workers:** execute with the Team Lead. The Lead owns shared interfaces and the live game; teammates own disjoint implementation scopes. Targeted tests only; no exhaustive suite runs.

**Goal:** make the 4F farm cycle runnable end to end — 第三区 → stair up to 第四区 → farm a chest → stair back to 第三区 → harken → 归还 → Dungeon Select → world map → rest town — with the QTE brake behind a config switch defaulted off.

**Decisions (operator, 2026-10-31):**
1. `worlds.wvd.qteBrakeEnabled` defaults **false**. The planner and late press do **not** add the brake carry unless the switch is true; probes can flip it later.
2. The 4F route is the legacy shape: travel to ZONE3, walk up the stair to ZONE4, farm, walk back down to ZONE3, then teleport to the rest town.
3. This is bounded: targeted tests + `pnpm typecheck`; no full-suite runs.

## Live findings (2026-10-31, the game is open; Lead measured)

- **4F stair entry works.** From the 3F map at player (7,24), origin (744.7,230): `R`, tap **(960,158)** (the door/stair icon), then tap the 自动移动 element at **(960,236)**. The party walks to 第四区 and lands in a room with a chest prompt. The live 4F map key is **`000000007f3ffe007ffeff00220bb600`** (fixture key `000000007f3ffe007f7efe00220ba600`; within the 8-bit tolerance).
- **The 4F map parser misses the farm targets.** On the live 4F map (player (21,1), origin (1247.6,801.9)) `readMap` returns six `teleport` icons only — **no chest and no harken**, while the frame visibly draws two chest icons (white square, red W) at about (1140,575) and (1080,665) and a white harken sparkle at about (835,535). The 3F map reads its chests. This is the critical 4F blocker: the route sees zero chests and would exit.
- **Exit crossing works.** On the 4F map, `F` (移动至出口) walks the party down to 第三区. On the 3F map, `F` walks to the harken; the altar menu opens on arrival.
- **The harken menu's 归还 is at (960,714)**, not the p0 card's (955,822). `归还` returns to **Dungeon Select**, not the town. The rule-of-thumb coordinates in the card are wrong for this menu.
- **The return to town is not solved.** On Dungeon Select, the `打开世界地图` row is at about (1124,710); taps there and on the left back arrow did not open the world map. The legacy calls this control `openworldmap` (`wvd/resources/images/zh_CN/openworldmap.png`); the catalog has no such template. Add the legacy template/control and use it to open the world map, then `travel vnh`.
- **4F chests exist live.** The 4F map's chest icons are the same white-square/red-W art as 3F; the fixture captured no chests because that run showed none.

## Tasks

### T1 — QTE brake switch (owner: qte-dev)
**Files:** `src/policy/qte.ts`, `src/actions/qte.ts`, `tests/qte.test.ts`, `tests/qte-loop.test.ts`, `tests/replay-plan.test.ts`, `scripts/replay.ts`.
**Interface:** `brakeEnabled?: boolean` on `PlanTapInput`, `PredictRestInput`, `QteTimingOptions`; default false. When false, `planTap` uses `v * latencyMs / 1000` and `predictRest` uses `markerX + v * (ageMs + latencyMs) / 1000`; when true, add the existing `brakeDistancePx`. `timeQte` passes the option through. The replay plan check uses `brakeEnabled: false` unless it is given true. Update the tests: default no-brake expectations; keep the old brake expectations under `brakeEnabled: true`; add a test from the live 2026-10-31 presses (v=-429.79, tap 1088.5, rest 856.5; v=802.0, tap 953.5, rest 1096.5) showing the no-brake prediction is the closer one.
**Acceptance:** targeted qte/replay tests and typecheck pass. Do not edit config/world/docs.

### T2 — 4F map chest and harken icons (owner: map-dev)
**Files:** `src/perception/map.ts`, `tests/map.test.ts`, new fixture `testdata/nav-2026-10-31-ffxi4f-4f/fourth-floor-live.jpg` (copy of `.tmp/live-4f-map3.jpg`).
**Job:** reproduce the live 4F map read (player (21,1), key `000000007f3ffe007ffeff00220bb600`, six teleports, no chest/harken). The frame visibly has two chests at ~(1140,575)/(1080,665) and a harken at ~(835,535). Find why the chest/harken detectors miss them and fix it. The chest/harken art is the same as 3F; the 4F map is at a different scroll/grid phase. Do not regress 3F/B1F.
**Acceptance:** `readMap` on the live 4F frame returns the visible chest icons and the harken; a new test pins the fixture; targeted `tests/map.test.ts` passes. Do not edit the route/task files.

### T3 — 4F task file and return path (owner: task-dev)
**Files:** `src/tasks/schema.ts`, `src/tasks/steps.ts`, `tasks/ffxi-4f.json`, `tests/task-schema.test.ts`, `tests/task-run.test.ts`.
**Interface:** `expectFloor` gains an optional `key` (32 lowercase hex) so a script can gate the 3F leg and the 4F leg; the Lead adds `TaskStep.key?: string` to `src/contracts.ts`. `steps.ts` uses `step.key ?? taskKey`.
**Task file:** 4F floor key `000000007f3ffe007ffeff00220bb600`. Entry: town → `travel ffxi-gcn` → wait 8000 → `travel ffxi-zone3` → expect dungeon → tap (1787,96) → expect dungeonmap → `expectFloor` 3F key → `R` → tap (960,158) → wait 900 → tap (960,236) → wait 8000 → `expectFloor` 4F key. Exit: open 4F map (tap 1787,96) → expect dungeonmap → `F` → wait → expect dungeon → open 3F map (tap 1787,96) → expect dungeonmap → `F` → wait 8000 → tap (960,714) (归还) → wait 5000 → open the world map via the legacy `openworldmap` control (pending T3/Lead measurement) → `travel vnh` → expect town 30 s. If the Dungeon Select row still does not respond, use the legacy `openworldmap` template match (add the catalog entry) rather than a fixed row tap.
**Acceptance:** schema/steps tests (including the explicit key), the real task file parses, and the exit ends with `expect town`. Lead will adjust the one live-measured point if needed.

### T4 — Loot collector (owner: loot-dev)
**Files:** `src/perception/loot.ts` (new), `src/actions/chest.ts` (add `tapLoot` at (960,510)), `tests/loot.test.ts` (new).
**Job:** name the loot overlay from the committed `testdata/chest/2026-10-31-loot/loot-00.jpg` (1280×720) and from a native 1920 capture if the Lead provides one; the overlay is the centered brown contents card with the 获得了… line and AUTO. `tapLoot` is the measured one-tap collect at (960,510) on 1920×1080. The Lead wires the intent/route/world; the teammate owns the perceiver/action/tests.
**Acceptance:** the fixture names `loot` and `tapLoot` sends one tap; targeted loot test passes. Do not edit route/world/main/config.

### T5 — Lead integration (owner: lead)
Add `qteBrakeEnabled` to `src/config.ts` (default false) and the config group; add `TaskStep.key?`; add the loot waypoint (`Intent` / `route.ts` / `world.ts` / `main.ts`); pass the brake config to `timeQte`; on `#qteGivenUp` cancel the bar and clear the wait; reset `qteGivenUp`/`qteRerolls`/`battleAutoOn` per cycle; register the loot perceiver; update contracts/docs/status; add the `openworldmap` catalog/control if T3 needs it; run targeted integration tests. Live game: measure the Dungeon Select world-map control and confirm the exit.

### T6 — Independent review (owner: verifier)
Read the plan and the final diff; check the live findings against the code; run targeted tests/typecheck; report defects without editing.

## Write scopes
- qte-dev: `wvd-agent/src/policy/qte.ts`, `wvd-agent/src/actions/qte.ts`, `wvd-agent/tests/qte.test.ts`, `wvd-agent/tests/qte-loop.test.ts`, `wvd-agent/tests/replay-plan.test.ts`, `wvd-agent/scripts/replay.ts`.
- map-dev: `wvd-agent/src/perception/map.ts`, `wvd-agent/tests/map.test.ts`, `wvd-agent/testdata/nav-2026-10-31-ffxi4f-4f/`.
- task-dev: `wvd-agent/src/tasks/schema.ts`, `wvd-agent/src/tasks/steps.ts`, `wvd-agent/tasks/ffxi-4f.json`, `wvd-agent/tests/task-schema.test.ts`, `wvd-agent/tests/task-run.test.ts`.
- loot-dev: `wvd-agent/src/perception/loot.ts`, `wvd-agent/src/actions/chest.ts`, `wvd-agent/tests/loot.test.ts`.
- lead: `wvd-agent/src/config.ts`, `wvd-agent/src/contracts.ts`, `wvd-agent/src/world.ts`, `wvd-agent/src/main.ts`, `wvd-agent/src/policy/route.ts`, `wvd-agent/tests/world.test.ts`, `wvd-agent/docs/`, `wvd-agent/testdata/` (native loot/map captures), `wvd-agent/tasks/ffxi-4f.json` (only to apply a live-measured point after the task-dev lands).
