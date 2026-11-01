# The orientation: resuming the farm from any screen (2026-11-02)

**Status:** implemented, unit- and world-tested; the live acceptance is the last step.

## 1. The observable

A session started while the party is **inside** the dungeon used to refuse to start:

```
wvd: the task entry stopped at step 0: expect-timeout: screen stayed dungeon
```

The entry script's first step was `expect town`, and a script cannot adapt: every step assumed the
screen the last one produced. So a stop, a crash, a full inventory or an operator who simply closed
the console left the party in the dungeon and the next session dead on arrival. Recovery was manual:
`G` → `F` (移動至出口) → `归还` → `travel vnh`, then start again in town.

After this change the same start opens the map, reads the floor and takes the party the rest of the
way — travel, climb, or nothing at all if it is already home.

## 2. The seam that owns the fact

The task file's **entry** is the wrong seam for "where the party starts": it is a blind script, and
the starting screen is a fact only the frame knows. The World already owns the frame-driven loop and
already answers one screen at a time from a stateless policy, so the seam that owns the fact is the
task's declaration: it should say *where the farm is*, not *how to drive there from town*.

Contract change (contracts §10, mirrored in `src/contracts.ts`):

- `TaskDefinition.entry` becomes optional; `TaskDefinition.goal` is added; a task carries exactly one
  of them (`exclusive-field`).
- `TaskGoal { site, zone?, climb? }`, `TaskClimb { from, script }`, `TaskOrient { goal, floor }`.
- `ScriptId` gains `'climb'`: the measured stair-up is a script like any other, and the runner gates
  its `expectFloor` on `climb.from` instead of the farm floor.
- `SessionTask.orient?: TaskOrient` — what the World needs to orient, and nothing more.

## 3. The decision table

`src/policy/orient.ts` answers one question per tick from the frame the loop already observed. Pure
and total; no clock and no memory (retry budgets belong to the World, which counts across ticks).

| the screen is | the decision | why |
| --- | --- | --- |
| `dungeonmap`, floor ≈ `orient.floor` | `arrived` | the party is on the farm floor; the route takes over |
| `dungeonmap`, floor ≈ `goal.climb.from` | `climb` | the one measured detour up (below) |
| `dungeonmap`, any other floor | `stop` | no measured way off it; a blind tile is how a party changes floor by accident |
| `dungeon` | `open-map` | the map is the only surface that prints the floor |
| `dungeon-select` | `travel goal.zone ?? goal.site` | the row that opens the zone |
| `town`, `worldmap` | `travel goal.site` | the atlas travel, proven 10/10 in 220 s |
| `loading`, `unknown` | `wait` | a transition resolves itself; a persisting one is the stall clock's |
| `chest-prompt`, `chest-open`, `chest-qte`, `chest-opening`, `loot`, `combat` | `yield` | never abandon a chest or a fight |

`yield` falls through to the farm route *in the same tick*, so a chest the party walked into while
orienting is opened, and its battle fought, exactly as during farming.

## 4. What the World does with it

`#orienting` is a session phase, not a script:

- it starts true for a goal task, and the entry never runs;
- the tick runs it after the in-flight/heal/verdict handling and before the farm policy, so one
  command per tick, the same one-command-at-a-time rule as the farm;
- `open-map` and `exit` go through `#press`, so they share the in-flight rules (a map that never
  opens is not pressed twice; a walk is waited out by arrival);
- `climb` runs the task's script through the runner and then calls the entry hand-off, because the
  climb's last press starts a game-driven walk;
- `travel` is the loop's one long command and the only one that reads frames, so it arrives through
  `RouteCommands.travel(to, abort)` and the composition root binds it to the live session's source
  and perceiver with the stored atlas on;
- retries are bounded and reported: one retry for a failed travel, one for a failed climb, then the
  session stops with the reason (`ORIENT_TRAVEL_TRIES`, `ORIENT_CLIMB_TRIES`);
- after the exit script, a new cycle **re-orients** instead of running an entry — the loop the
  operator asked for: farm, leave, come back, from wherever the exit left the party.

The orientation does not heal by itself. It does not need to: a battle or a chest the party meets
on the way sets `#healDue` exactly as during farming, and the heal spends the flag on the next 3-D
view tick (world.ts, 2026-11-01). That is the heal "in between" of the acceptance.

## 5. The climb, and why it is data

The 4F farm is reached from 第三区 by a measured sequence: `R` (pointer mode), tap the door at
**(960, 158)**, then the 自动移动 element at **(960, 236)** — not the usual 81 px above the tile.
Those points are only correct while the map is scrolled to the origin the row entry produces, so
they are **data in the task file**, not constants in code, and the script's own first step gates the
floor (`expectFloor`, falling back to `climb.from`). Any other floor refuses before the taps.

The stairs down are not a decision the orientation makes: the farm route's exit script already
encodes `F` on 4F → 第三区, `F` on 3F → the harken, 归还 at (960, 714), `travel vnh`. The
orientation only ever climbs.

## 6. Rejected alternatives

- **A pre-entry orientation loop.** It cannot fight: a battle during a walk needs 倍速/自動, and
  `ScriptEnv` has no such command. It also blocks the console's state line for minutes. The tick loop
  already has one-command-at-a-time, stalls, escalation and the fight path — reuse it.
- **An `expect-any` step in the task language.** It would let the entry skip `expect town`, but the
  entry still has to branch (exit the dungeon, or travel, or nothing) and a script has no branch.
- **Orient as a policy decorator** (in front of the route for every tick). It would have to know
  when to stop being a decorator and let the farm's own map decisions through; the phase flag is the
  same information stated once.

## 7. Failure model

Everything is a value: `arrived | wait | yield | command | stop`. The stops are the honest ones —
an unmeasured floor, a travel that failed twice, a climb that failed twice, a climb script that
stopped at a step — and each ends the session with the reason the operator needs. A screen nobody
names (`unknown`) is not the orientation's guess: the session classifier escalates it, and the
stall clock stops the session if it persists.

## 8. Tests

- `tests/orient.test.ts` — the decision table, one case per row, including the floor-key tolerance
  and both stop cases.
- `tests/task-schema.test.ts` — the goal form: no entry required, exclusivity, catalog ids, the
  climb's key and script; and the committed `tasks/ffxi-4f.json` read back step for step.
- `tests/task-run.test.ts` — the runner exposes `orient`, runs the climb against `climb.from`, and
  runs no entry for a goal task.
- `tests/world.test.ts` (`the orientation`) — resume from inside the dungeon (no entry, map opened),
  travel from town/worldmap/dungeon-select, arrival on the farm floor, the climb then the hand-off
  walk then the first farm command, a stranger floor stopping, a chest during the orientation, a
  failed travel retried then stopped, and a new cycle re-orienting after the exit script.
- 605 tests, `tsc --noEmit` clean.

## 9. Live acceptance

`scripts/world-run.ts` with `tasks/ffxi-4f.json`, started with the party **inside** 第三区-城内2F-,
is expected to: open the map, climb, and farm 第四区 without a manual step. Recorded in
`docs/status.md` once run.

## 10. What this does not cover

- A party left in a *different* dungeon: its floor is neither the farm floor nor the climb floor, so
  the orientation stops and reports instead of guessing. A measured leave-script per dungeon is the
  next step if that ever happens in practice.
- The harken menu as a screen: it is not named, so a party parked on it is an `unknown` (escalate),
  not an orientation case.
