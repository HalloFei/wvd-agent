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
- **Icons**, as measured then: chest (high — every instance matched at NCC 0.97–1.00, no false
  positive above 0.55), hazard (high — an 85×36 red bar, `R−B ≥ 45`), stairs (medium, one sample),
  and the sparkle, which was not identifiable at one scale and is read at two since 2026-10-24 (§6).
- **Map versus not-a-map** is decided by structure, not colour: the readout's eight glyph runs, the white
  ink count (15k–200k px), eight wall lines at 36 px pitch, then the chevron. Across 198 non-map frames
  the run count was never eight; the HUD-only fixture yields two runs and 1 424 ink px against the map's
  36 380.
  The lattice line count's quality test is a **support count**, not a residual (2026-10-25): the frame
  must explain at least 6 of its detected X-axis lines with one 36-px grid, because the FFXI floors draw
  the map translucent over the 3D view and the harken's glow lights long runs of the row profile that a
  least-squares residual would follow. The grid is still fitted by minimum residual — its phase is what
  places the icons and the chevron's cell — and the Y axis is cross-checked by the chevron's own cell
  residual rather than gated on support. `src/perception/map.ts` carries the measurements.
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
- **Crossing floors is the exit's job, not the chest's.** Automove to a chest never leaves the floor.
  Automove to the **exit** (`F`) does: pressed on `B1F -巨坑-`, the party walked to the special
  next-floor tile and the screen changed to `B2F -圣堂-`, `X:9 Y:1`, with no further input (observed
  2026-10-24 night). So the transition tile is a map destination like any other — it is the
  destination that crosses, not a special key.
- The operator's constraint is narrower than "no crossing": the route must not expect automove to
  reach a **previous** floor, and chest moves stay within one floor. Descending through the exit is
  the mechanism FFXI 4F uses.
- What is still unobserved: the reverse direction (back up), and whether a floor transition can be
  triggered from a tile the party is already standing on.

## 3e. Walking to one tile — the command this World uses (2026-10-24, round 4)

§3d records `L` working on the map floors and calls it the whole movement command. On the FFXI
collab floors that is false: **`L` (移动至宝箱) is inert on both 第三区 and 第四区**, including the
third floor whose map reads three chests. The route's own floor is 第四区, so a World whose only
movement command is `L` cannot move there at all.

The path that answers is **§3c's pointer mode**, now measured end to end:

1. `R` (切换指针模式). Without it a tile click is ignored — §3c's first correction still holds.
2. Click a **walkable black tile** (the dark cells are road; the white lines are walls, and a click
   on anything else does nothing).
3. The `自动移动` element appears **79-84 px above the clicked tile** (three instances, 2026-10-24;
   the earlier top-left observation in §3c was a different frame). Click it. Since 2026-11-02 the
   command finds the element instead of assuming that rise — see the last bullet below.
4. The map closes and the party walks. The game paths, fights what it meets and never leaves the
   floor — the same guarantees §3d records for `L`.

Two consequences for the build, and both are now in the code:

- **The target is a tile, so the map must publish a screen anchor.** The canvas scrolls, so the
  chevron is the only absolute point: contracts §3 gained `MapState.origin` (the chevron's own
  screen point), and `tileOnScreen` inverts the icon transform from it. The route keeps speaking
  grid cells; the conversion is the composition root's, taken **at tap time** from a frame captured
  then (`AutoMoveAim.locate`) — the canvas also moves between frames, and a point converted from
  the decision's frame was measured 112 px (3.1 cells) off on 2026-11-06.
- **The element is detected since 2026-11-02.** `perception/automove.ts` matches the pill's glyph
  (28x28, `scripts/extract-automove-template.ts`) in a band around the clicked tile and taps where
  the game drew it; the 81 px rise stays only as the fallback for a caller with no frame source.
  The measurement that forced it: on 第四区 at party X:21 Y:1 a tap on the cell north of the party
  raised the pill 78 px above and 36 px left, with the glyph at (1212,690), while a tap on the chest
  cell 18 rows up raised **nothing** — no element, so no walk, and the old fixed tap landed on the
  panel's title bar. A tile that raises no element is now a typed failure, and the World puts that
  cell on the cycle's skip list (`RouteState.unreachable`, operator rule 2026-11-02): the farm aims
  at another chest, and a floor with none left takes its next stage — the exit script.
  Measured cost of the detector: one small-band match of a 240x170 band, run once per walk.

`L` is therefore no longer pressed by the World. It stays in the legend (contracts §4's `SCAN`)
and a task file may press it, but no route intent depends on it.
## 4. What this means for the route policy

- A chest run is: press `G` twice, walk to a tile, wait for the walk (and any battle it drags in),
  open the chest, walk again until no chests remain. Since §3e the walk is the pointer-mode chain,
  aimed at a cell; on a floor where `L` works it is still the cheaper single press.
- Chest moves are single-floor; the **exit move crosses down** (observed `B1F → B2F`). So a route can
  descend by pressing `F` once the floor's chests are done, and the next floor starts a fresh sweep.
  Going back up is not established.
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

## 6. Crossing a floor — the markers, measured 2026-10-24

Which markers cross a floor is the operator's account, and it splits the vocabulary three ways:

- **The harken crosses.** The white 4-point sparkle is 哈肯; its arrival menu lists the zones
  (第一区/第二区/第三区/第四区, 归还, 什么也不做) — verified 2026-10-24.
- **The entries and exits cross.** The staircase and the down-arrow over an oval.
- **The orchid ring does not.** It moves the party within one floor. 第四区 draws five of them; none
  of them changes the floor, and no route may treat one as a crossing.

| Marker | What it is | Read where | Margin |
| --- | --- | --- | --- |
| `harken` | the white 4-point sparkle, 哈肯 | B1F (20,21), 第三区 (6,24), 第四区 (10,23) — one per floor | 0.72 / 1.00 / 0.72, best impostor 0.63 |
| `stairs` | the staircase | B1F (25,25) | 1.00, next best 0.63 there, ≤ 0.65 anywhere else |
| `hole` | the white down-arrow over an oval | 第三区 (1,17) and (20,8) | 1.00 / 0.98, best elsewhere 0.65 |
| `teleport` | the orchid ring — **within a floor** | 第四区 ×5: (12,18) (7,13) (17,13) (17,15) (4,9) | colour rule, zero false pixels off 第四区 |

**How the harken is read.** The game draws it at two sizes — 16 px on 第三区, 12 px on B1F and
第四区 — and one scale cannot carry it: at 16 px it scores 0.84 on the hole glyph and 0.78 on a B1F
background cell that outranks that floor's own sparkle. So the parser matches both scales at the cell
centre and keeps the better score, behind an ink gate (30–140 lit px in a chest-sized box). That is
what makes 第四区 and the glow frames readable at all: they parsed as **zero icons** before.

**The mechanic, as far as it is measured.**

- `F` (移动至出口) crosses a floor: pressed on B1F the party walked to the tile and the screen came up
  B2F (2026-10-24). `L` (移动至宝箱) never leaves the floor. B1F draws one harken and one staircase,
  so on that floor the crossing has exactly two candidates.
- **Up is unproven.** No committed frame carries the mirrored staircase (`stair_down` in the mobile
  art); the mirrored template matches nothing anywhere (best 0.68, on a wall cell). Descending has
  candidates on B1F; ascending has none.
- Which of a floor's markers the menu actually opens on is unmeasured. This section says what each
  glyph **is** and what the operator says it **does**; it does not claim the pairing.

**Initiating the move.** Identification and initiation meet at one cell. The parser publishes the
marker's grid cell; `tileOnScreen(map, cell)` turns it into a screen point on a frame captured then;
`automoveToTile` presses `R`, clicks that point and clicks the 自动移动 element 79–84 px above it
(§3e). The link is tested, not assumed: 第四区's ring (12,18) maps to (925,446) against a measured
ring centre of (923.5,449), and the harken's cell is the same cell a walk would be aimed at
(`tests/map.test.ts`). Since 2026-11-06 the walk takes the **cell**, not the point: the point is read
from the frame the tap follows, because a stale one lands on another cell.

**Still open:** which entry/exit a floor crosses at (needs one live pairing of a marker with a floor
change — the p0 FFXI session); and the door-with-arrow drawn at the top edge of both FFXI maps, which
no template of ours matches yet (0.48 at best) and which is the most likely entrance marker.
