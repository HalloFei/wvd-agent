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

## 4. What this means for the route policy

- A chest run is: G, find the nearest reachable chest icon, click its tile, double-click automove,
  wait, open the chest, repeat until no chests remain, then change floors via the exit.
- No pathfinding, no keys, no corridor vision. The map is the only perception input for movement,
  and it is a high-contrast grid with a floor title and `X/Y` coordinates.
- Because icons are random, every run is a fresh search; a recorded route is worthless as
  coordinates but valuable as a procedure.
- Combat is not avoidable, so battle policy is on the critical path for any long route: every
  enemy that touches the party must be fought.
- The command is two clicks plus a popup, so the World must recognise the popup and the automove
  control inside it, not just the tile.

## 5. Remaining questions

1. What does the automove popup look like — one button, or several (move, mark, cancel)? A
   screenshot with the popup open would settle the detector.
2. Does the popup appear for every tile, or only for reachable ones? How does an unreachable tile
   behave?
3. `移动至出口` (F) — next floor down, or the dungeon exit? Does it always prefer a haken?
