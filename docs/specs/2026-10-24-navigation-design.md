# Navigation — design

Status: accepted; open: world-map entry unobserved, the G binding unexplained
Owner: the repository root
Evidence: `testdata/nav-1024-0213/` (14 segments, ~56 s), plus the map screen captured 2026-10-24.

## 1. What the Steam build already does for us

The map screen is a control surface, not just a picture. It shows the floor and offers automove.

- Title: `B1F -巨坑-` — floor and dungeon name, in the clear.
- A grid map with walls, doors, chests, stairs, and the party's position.
- Player grid position as `X: 20  Y: 14`.
- `层数` with up/down arrows — a floor selector.
- Commands, each with a hotkey:
  - `移动至宝箱` L — move to a chest
  - `移动至标记` Q — move to the marker
  - `移动至出口` F — move to the exit
  - `移动至目的地` N — move to the destination
  - `切换指针模式` R — pointer mode
  - `标记` — set the marker, and `关闭` to close.

This replaces the mobile build's approach entirely. wvd opens the map, pans and zooms, template-matches a floor icon, taps it, taps automove, and waits. The Steam build takes the command directly. **The agent does not need to path-find, walk with keys, or read a 3D corridor.**

## 2. Consequence for the route policy

A dungeon step becomes:

1. Open the map.
2. Read: floor title, player X/Y, which icons exist (chest, stairs, doors).
3. Issue one command — a chest, the exit, or a marked tile.
4. Wait for arrival, watching for combat or a dialog.
5. Close the map or let it close, then act on what is there.

The map is also the cheapest state source in the game: a static, high-contrast, text-labelled
image, far easier to parse than the 3D view, and it carries the floor and coordinates as text.

## 3. The loop, as the operator describes it

1. **G** opens the map; **G** closes it. Automove does not care whether the map is open.
2. **Click a tile.** A small automove window appears next to that tile.
3. **Double-click the automove control in that window.** The party walks.
4. Automove is free. It crosses the current floor, prefers a haken when one shortens the trip, and
   routes around the hazard automatically.
5. **Enemies are fought, not avoided.** Anything that touches the party starts a battle, and the
   battle must be won. Automove does not path around enemies.
6. If automove stops, it resumes from the **circular-arrow button under the minimap** in the
   top-right corner.
7. **A floor cannot be changed from the map view.** Tile automove is current-floor only. Changing
   floors is what `移动至出口` (F) is for, which is the cross-floor command that prefers haken.

Confirmed by the operator: automove costs nothing, chest and stair icons are re-randomised every
run, and for the FFXI 4F route the whole navigation is "open the map, tap".

## 3a. Verified by the agent, 2026-10-24

The command chain works end to end, driven entirely by the mouse:

1. **Click the minimap** in the top-right corner. The full map opens. (G did **not** bind in
   testing, although the HUD lists it; the minimap click is the reliable path.)
2. **Click a tile** — a chest icon at (1322, 622) in this instance. A small **自动移动** window
   appears beside the clicked tile.
3. **Double-click that window.** The map closes and the party walks.
4. The party walked for several seconds, then **stopped in a corridor** and stayed still: two
   frames 2.5 s apart differed by 1.3%, which is particle flicker, not movement.
5. A click at (1825, 195), the circular-arrow control under the minimap, **did not resume it**.

So issuing a command is solved; what remains is diagnosing a stop.

**Why that one stopped (operator, 2026-10-24):** the hazard blocked the path. That is not the normal
case, and it has a fallback — the party can be walked out with **WASD**. Two lessons:

- A stop needs a cause check before any retry: hazard-blocked is walked out by hand, an interrupted
  automove is resumed with the circular control, an arrival is simply over.
- **Resume only works while an automove is interrupted.** With no live automove set, the control
  does nothing — which is what happened in the test above. It is a resume, not a restart.

## 3b. The map, measured from the frames

A parser was prototyped against `testdata/nav-1024-0213/` and 198 other captured frames before Task 4
existed (`research-map-parser.md`). What it settled:

- **The canvas scrolls.** Whole-map shifts of 21, 72 and 210 px were measured on the same floor between
  captures, and 210 is not a multiple of the tile size. So there is no absolute map origin: every
  position is relative to the **chevron**, which sits at the centre of the player's cell (±1 px).
- **Tile size is 36.0 px**, square on both axes (wall lines fit to rms 1.6 and 2.7 px). Click a target
  at `chevron + ((x_t − x_p)·36, −(y_t − y_p)·36)` — Y inverts, because grid Y counts upward. Validated
  to ≤1.1 px against a popup-to-map pair.
- **The readout** `X: n Y: n` is 12 px digits at a fixed rect (ink rows 900–911, x 1010–1146). No OCR
  exists on this machine; template matching read 26 of 26 map frames, but only seven of the ten digit
  glyphs have ever been seen. An unseen digit returns `null`.
- **Icons**, by reliability: chest (high — every instance matched at NCC 0.97–1.00, no false positive
  above 0.55), hazard (high — an 85×36 red bar, `R−B ≥ 45`), stairs (medium, one sample), **haken
  (not identifiable)**. `haken` must therefore never be emitted, and no policy may depend on it.
- **Map versus not-a-map** is decided by structure, not colour: the readout's eight glyph runs, the white
  ink count (15k–200k px), eight wall lines at 36 px pitch, then the chevron. Across 198 non-map frames
  the run count was never eight; the HUD-only fixture yields two runs and 1 424 ink px against the map's
  36 380.
- **The 自动移动 banner** sits at x 1223–1402, y 533–567 (centre 1313, 550); double-click the text centre,
  not the arrow tips.

## 3c. What the live build contradicted, 2026-10-24 evening

The party was driven from the title screen into 第四区 by the engine itself (world map → 北穿幽冥城 →
Dungeon Select → 第四区-城内2F深处- → minimap). That run falsified three things §3a asserts, so §3a is
now history, not procedure:

- **A tile click does nothing in the default mode.** The 自动移动 element only appears after pressing
  **R (切换指针模式)**. Any navigation step that clicks a tile first must press R first.
- **The element does not appear beside the clicked tile.** It appeared at the **top-left of the map**,
  and it did not activate with a single click, a 2×60 ms engine double-click, a 12 ms native
  double-click, or Enter. The party did not move. **The activation gesture is unknown.**
- **The right-hand list is a key legend, not buttons**: 移动至宝箱 L, 标记 Q, 出口 F, 目的地 G,
  指针 R. Keys do reach the game (G opened and closed the map, Q/E zoomed the world map), but **L did
  nothing** on the dungeon map — it may require a discovered chest or a different mode.

Two hazards for the loop:

- The **3D-view bottom bar is HUD, not map commands.** One of its icons opened the **altar
  teleporter** (移动 → 第一区 / 第二区 / 第三区 / 归还 / 什么也不做). It was dismissed with
  什么也不做 and no zone changed. A blind click there can move the party to another floor, which would
  invalidate the route silently.
- The engine's own input leg, measured during that run: single taps 62–90 ms, double taps ~220 ms.
  That is the number a QTE planner must add, not an assumption.

Consequence: **Task 5 cannot be implemented from §3a.** It needs one recorded instance of the
automove gesture succeeding — performed by the operator, or driven with explicit authorisation and
recorded — before its detector and activation can be written. Until then the route stops at "standing
on the map".

## 3d. The command set, verified live 2026-10-24 night

Driven through the engine with the operator's authorisation, on `B1F -巨坑-`:

- **From the 3D view, `G` opens the menu; `G` again opens the dungeon map** (the menu lists 地图 `G`,
  调查 `F`, 切换指针 `Tab`, 返回 `Esc`). Clicking the minimap also opens the map.
- **On the map, keys are the commands, not buttons.** The right-hand list is a legend:
  移动至宝箱 `L`, 移动至标记 `Q`, 移动至出口 `F`, 移动至目的地 `G`, 切换指针模式 `R`, 关闭 `X`.
- **`L` works and is the whole movement command**: it closed the map and the party walked to a chest,
  fighting two encounters on the way with auto-battle already on, and the readout changed from
  `X:19 Y:21` to `X:11 Y:19`. The earlier attempt failed because the map had no focus, not because
  the key is inert.
- **A tile click still needs `R` (pointer mode)**, shows 自动移动 beside the target, and needs a click
  on that element to confirm. It is a second, slower path to the same command.
- **Automove does not cross floors** (operator, 2026-10-24). It stays on the current floor; stairs,
  the exit and any floor change are not reachable through it. The altar teleporter is the only
  floor-change mechanism seen so far.

## 4. What this means for the route policy

- A chest run is: press `G` twice, press `L`, wait for the walk (and any battle it drags in), open
  the chest, press `L` again until no chests remain. No tile coordinates are needed for movement.
- Automove is **single-floor**. Leaving the floor is not a map command: the route ends when the
  chests are gone, and a human (or the altar menu) moves the party. Any plan that assumed automove
  would climb stairs was wrong.
- No pathfinding, no corridor vision. The map is the only perception input for movement, and it is a
  high-contrast grid with a floor title and `X/Y` coordinates.
- Because icons are random, every run is a fresh search; a recorded route is worthless as
  coordinates but valuable as a procedure.
- Combat is not avoidable, so battle policy is on the critical path for any long route: every enemy
  that touches the party must be fought, and the party's auto-battle does that unaided today.
- `L` chooses the chest; the World does not. The policy's target is therefore advisory — it says "go
  to a chest", and the game picks which one. A policy that needs a *specific* chest must use the
  pointer-mode path and accept its two extra interactions.

## 5. Remaining questions

1. What does the automove popup look like — one button, or several (move, mark, cancel)? A
   screenshot with the popup open would settle the detector.
2. Does the popup appear for every tile, or only for reachable ones? How does an unreachable tile
   behave?
3. `移动至出口` (F) — next floor down, or the dungeon exit? Does it always prefer a haken?
