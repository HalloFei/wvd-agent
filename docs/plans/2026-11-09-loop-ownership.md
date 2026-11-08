# The loop's stages: one arbiter, one owner

**Status:** executing, 2026-11-09.
**Board:** t-mw8dwvan-wm01ce (one arbiter), t-mw8dwvax-9zqrk4 (the exit's two owners),
t-mw8dps1b-ak1nlq (the harken deadlock — this plan's reproduction).
**Spec Task 1 writes:** `docs/specs/2026-11-09-stage-ownership-design.md`.

## Why

Live run 7 (`.tmp/runs/2026-11-09-3-cycles-7/console.log`):

- `06:00:02 leaving: walking to this floor exit with F` — the leave pressed F;
- `06:00:02 off the task floor; the orientation is re-armed` — **the second owner** acted on the
  same exit path in the same tick;
- `06:00:20 STATE running | harken-menu` — the party arrived on the floor's harken page;
- `06:02:50 STATE stopped | harken-menu | nothing changed for 150 s`.

The leave is a goal with no cursor (`src/policy/leave.ts`) — correct. But its only pump,
`World.#leaveStep`, is called from `#execute`'s `run-script` branch (`src/world.ts:3273`),
which runs only when the policy returns `run-script exit`. On `harken-menu` the route returns
`wait` (`src/policy/route.ts:118`), so the leave was never asked again — while its ownership
flag still made the harken branch defer to it (`src/world.ts:1714`: `if (this.#leaving) return;`).
Ownership without a driver. The stall clock then ended the session, which is why the defect read as a
stop condition instead of a missing caller.

The heal (commit `07efd3c`) is the shape that works: an owned episode pumped straight from the
tick, with its own material and its own clock. Three properties are missing from the rest of the loop,
and each is a *class* of defect:

1. **Liveness** — an owner is driven every tick. A flag that says "I own this" is a promise someone
   calls; nothing in the code kept it.
2. **Exclusivity** — one owner at a time. The orientation and the leave both drove the exit path.
3. **Bounds** — an owner is released by its own clock, before the shipped stall stop that would end
   the session and mask the design hole as a "stop condition".

## How this plan runs

Subagent-driven development, in this checkout on `main`. Two implementers run in parallel, in
disjoint file scopes (listed per task); each commits only its own paths. The Lead reviews each lane and
then runs the live three-cycle acceptance.

Rulings recorded at dispatch:

- **Worktree:** the same checkout, `main`. The live harness and the operator's game session live here,
  a second worktree would need a second game session, and the two lanes' file lists are disjoint.
  Git `index.lock` contention is retried once after 2 s.
- **Model:** this harness's `subagent` tool takes no model parameter; both implementers run on the
  session default. The skill's model-selection rule cannot be expressed here; recorded so a reviewer
  does not read it as an oversight.
- **Scope:** the registry governs the three **intent-driven** stages (`exit`, `stage`, `orient`). The
  heal, the rest gate and the chest probe already pump from their own branches every tick and are
  frozen (the heal especially: `07efd3c`). Task 1 does not convert them, and says so in the spec.

## Global Constraints (binding on every task)

1. `src/contracts.ts` mirrors `docs/specs/2026-10-24-contracts.md` declaration for declaration. **No task
   changes `contracts.ts`.** A task that believes it needs a contract change stops with NEEDS_CONTEXT.
2. One command per tick. A command only from a named screen at confidence ≥ 0.5 that has held ≥ 2
   frames. No blind taps. A menu row is tapped at the point the reader **matched**, never a constant.
3. Input only through the focused window (`#press` / `#commands`). Nothing starts, stops or focuses the game.
4. Progress is what the loop **commands**, not what it observes. `stallStopSeconds` (shipped 120 s;
   150 s in run 7's harness setting) and the session limit keep their semantics.
5. A timing constant is module-local and carries the measurement or the reasoning that set it.
6. A warning is logged once per episode (the `#…Warned` pattern), never every tick.
7. **The heal is frozen:** `src/policy/heal-session.ts`, `src/policy/heal-schedule.ts`,
   `src/perception/quick-heal*.ts` are not edited; their tests stay green.
8. Tests use fakes only: no engine, no game, no network, no `sleep`, no wall-clock dependence.
9. `npx tsc --noEmit` after every change. Targeted vitest per task. Task 1 also runs the full suite
   before and after (it changes shared timing/ownership).
10. Commit by explicit path (`git add <paths>`; never `-A`); the message names the command that
    proved it.
11. Files outside a task's list are not edited. Another implementer is in the same tree: a type error
    in a file you do not own is not yours to fix — note it, wait, retry `tsc` once.
12. `testdata/` is fixture: never edited. A new fixture is a new file, with its measurement in a
    comment or a README beside it.

---

## Task 1 — One arbiter for the loop's stages, and the exit's single owner

**Cards:** t-mw8dwvan-wm01ce, t-mw8dwvax-9zqrk4, t-mw8dps1b-ak1nlq.

### Files

- **Create** `src/policy/stage-registry.ts` — the arbiter.
- **Create** `tests/stage-registry.test.ts`.
- **Edit** `src/world.ts` — the single pump point, the claims, the harken fall-through.
- **Edit** `tests/world.test.ts` — the regression tests below; existing tests may need their
  frame sequences adjusted for the new ownership, never their intent.
- **Create** `docs/specs/2026-11-09-stage-ownership-design.md` — the spec (see "The spec" below).
- **Do not edit** anything else. In particular `src/policy/leave.ts`, `src/policy/orient.ts` and
  `src/policy/chest-probe.ts` are **unchanged**: their contracts are right, the driver was missing.
  `tests/chest-probe.test.ts` belongs to another lane: run it if you like, never edit it.

### The arbiter's contract (exact)

```ts
export type StageName = 'orient' | 'exit' | 'stage';

/** One claim: who owns the tick, since when, and when the owner was last given the tick. */
export interface StageClaim {
  readonly name: StageName;
  readonly sinceMs: number;
  readonly pumpedAtMs: number;
  readonly pumps: number;
}

export type StageClaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly heldBy: StageName };

export class StageRegistry {
  /** Claim the loop for `name`. Idempotent for the current owner (it re-stamps the pump).
   *  A different owner is refused with the holder's name and changes nothing. */
  claim(name: StageName, now: number): StageClaimResult;
  /** Release the loop. False when `name` is not the owner — a release is not a takeover. */
  release(name: StageName): boolean;
  /** The owner was given this tick. False when it does not own — a pump of a non-owner changes nothing. */
  pump(name: StageName, now: number): boolean;
  /** The owner has held the loop for at least `deadlineMs`. */
  overdue(now: number, deadlineMs: number): boolean;
  /** The current owner, or null. */
  readonly owner: StageClaim | null;
}
```

Pure of the clock: every method takes `now`. Total: no method throws. The class has no
knowledge of screens, commands or the World.

### World wiring

Per-stage bounds, module-local in `src/world.ts`, each with its reasoning:

- `LEAVE_DEADLINE_MS = 110_000` — **below the shipped `stallStopSeconds` (120 s) with a 10 s margin**
  on purpose: a stuck exit is released, not turned into a session stop. (Corrected at review: the
  shipped default is 120 s, not the 150 s run 7 used, and the stall check runs earlier in the tick, so
  a 120 s deadline would never release at the shipped configuration. An operator who lowers the stop
  below 110 s gets the stop, not the release — the documented trade.)
- `ORIENT_DEADLINE_MS = 180_000` — a climb from another floor is minutes' work; the orientation
  marks progress when it commands, so its own bound is a backstop only.
- `SCRIPT_DEADLINE_MS = 300_000` — a scripted stage walks the whole exit (harken, Dungeon
  Select, world map); its cursor is the step, and this is the bound behind it.

1. **One registry.** `#stages = new StageRegistry()`. `#leaving` and `#orienting` become **derived**
   (private getters over `#stages.owner?.name`); every assignment to them becomes a `claim` or a
   `release`. `#staging` keeps the script id, and its ownership is the `'stage'` claim. Enumerate
   every old assignment site in the report — there are resets in `#startSession`, `#handOffEntry`,
   `#resetCycle`, `#finishCycle`, `#leaveStep` and `#execute` — and prove each maps to a claim or
   a release.
2. **One pump point**, where the current staging pump sits (`src/world.ts:1810`), after the verdict is
   computed and before the route: `if (verdict === 'ok' && !waiting && owner !== null) { pump; return }`.
   Order: `exit` → `#pumpLeave(context)`, `stage` → `#pumpScript(context)`, `orient` →
   `#pumpOrient(context)`. Each pump: called every tick it owns, sends **at most one** command, and
   sends **nothing while `waiting`** (an in-flight command owns the interface); it marks
   `#lastProgressAtMs` only when it commands. Each pump calls `#stages.pump` on entry, whatever it
   decides.
3. **The exit starts once and stays.** In `#execute`'s `run-script` branch, a task with `leave`:
   `claim('exit')`; if refused, log once (`the exit asked for the loop while <holder> owns it`)
   and return; else pump it once. On every later tick the pump point drives it. Release on: `arrived`,
   `stop`, deadline, and the cycle/session resets. `#staging` is **not** set for the leave path.
4. **The harken page falls through to the owner.** `src/world.ts:1711`: when the exit owns, the branch
   neither acts nor returns — it lets the tick reach the pump, where the leave's own rule decides the
   page. Every other screen branch keeps its place: the heal, the rest gate, the chest probe, the
   character page, the inn and the QTE sub-loop all pre-empt the pump, exactly as today.
5. **The border between owners.** The two orientation re-arm sites (`src/world.ts:1502` and `:1872`)
   and the orientation pump (`:1878`) claim and act through the registry: while the exit owns, the
   orientation does not re-arm, does not claim and sends nothing. A refused claim logs **once** per
   episode and does not act.
6. **The scripted stage is pumped by the arbiter**, not by the intent that started it: once claimed it
   advances one step per tick on a non-world screen (keep the `WORLD_SCREENS` exclusion), and a
   `interrupted` script result keeps its claim for the next tick (today's cursor behaviour).
7. **Nothing else changes:** the heal's episode, the rest gate, the chest probe, the QTE sub-loop, the
   escalation, the blank-settle window, the stall clock and the session bounds keep their semantics.

**Trap, do not "fix":** `#lastMapRead.floor` is `MapState.floorTitle` — the **Latin** floor token, which is
`''` on the FFXI colliery floors (`src/world.ts:2080`). The leave's `floorKind('')` is therefore
`'unknown'`, not `'farm'`, and on the harken page it taps **归还**, which is the way out (归还
returns to **Dungeon Select** — `docs/plans/2026-10-31-ffxi-4f-live-ready.md:17`, not to the town;
the leave travels from there). Making the empty floor mean "farm" would make the exit back out of the
page and loop forever. Leave `policy/leave.ts` alone.

### The spec

`docs/specs/2026-11-09-stage-ownership-design.md`, short (one page): the three properties, the
registry contract above, where the pump sits and why, the three deadlines, the ruling that the heal /
rest / chest probe stay outside the registry because they already pump every tick and pre-empt it, and
the live reproduction.

### Acceptance — write these first (TDD: red before the wiring)

In `tests/stage-registry.test.ts`:

- a claim from a second name is refused with `heldBy`, and the first claim is untouched;
- `claim` by the owner is idempotent and re-stamps `pumpedAtMs`;
- `release` by a non-owner returns false and releases nothing;
- `pump` by a non-owner returns false, changes nothing; by the owner it advances `pumps` and
  `pumpedAtMs`;
- `overdue` is false before the deadline and true at it; true only for the owner;
- after a release, any name may claim.

In `tests/world.test.ts` (use the existing harness: `makeWorld`, `started`, `TestClock`,
`ScriptedPerceiver`, `ScriptedActuator`; the nearest models are the exit tests at `tests/world.test.ts:1866`,
`:3358` and `:3472`):

- **The deadlock.** A task with `leave`, chest budget spent, a farm-floor map with no chest icons
  (so the E-check starts), then the map staying up past `CHEST_PROBE_MS` (advance `TestClock`), then
  `dungeon` (the walk), then `harken-menu` with the four measured rows including `归还`.
  Assert: the loop taps the **matched** `归还` point (the row's own `at`) within 5 ticks, and never stops.
  On today's build it stalls — that is the RED evidence.
- **The single owner.** With the exit owning, an off-floor `dungeonmap` frame must not log
  `the orientation is re-armed` / `the orientation takes over again` and must send no orientation
  command; the leave's own command is the only one sent that tick.
- **The bound.** With the exit owning and every frame a `loading` one, advancing `TestClock` past
  `LEAVE_DEADLINE_MS` releases it with **one** `warn` and does not stop the session before the
  stall clock.
- **The pump is every tick.** While a stage owns, `StageRegistry`'s `pumps` grows once per tick (assert via
  the world's own claim if it is reachable, else assert the observable: one decision log per tick).

Run: `npx tsc --noEmit`, then `npx vitest run tests/stage-registry.test.ts tests/world.test.ts tests/heal-session.test.ts tests/heal.test.ts tests/leave.test.ts tests/orient.test.ts`,
then the full suite once (`npx vitest run`) before and after the change, and report both counts.

### Report

`DONE` only when every acceptance above is green. Report the RED evidence for the deadlock test, the
old → new mapping of every ownership flag, the deadline constants with their reasoning, the two suite
counts, and any log line whose wording changed.

---

## Task 2 — The E-check's "asked already" is a floor, not a string

**Card:** pinned with this plan (`the E-check compares floor keys by string`).

### Files

- **Edit** `src/policy/chest-probe.ts`.
- **Edit** `tests/chest-probe.test.ts`.
- **Do not edit** `src/world.ts` (another lane owns it this round), `src/tasks/steps.ts`, or
  `tests/world.test.ts`.

### The defect

`nextChestProbe` remembers the floor it already answered for as a **string**: `state.done` is set
from the map's `titleKey` and compared with `state.done === observation.map.titleKey` (`src/policy/chest-probe.ts:79`).
A title read drifts — measured on this floor at **9 bits** of 128 (`src/tasks/steps.ts:44-54`) — so a
re-read of the same floor is a different string, the probe re-starts, and a floor already asked gets a
second E press every time its map is reopened: a walk the leave did not ask for, 5 s each time.

### What to change

The "already asked" test is the floor identity the rest of the loop uses:
`state.done !== null && isExpectedFloor(state.done, observation.map.titleKey)` → `skip`. Nothing else
changes: the signature, `ChestProbeState`, the timing, the decision kinds and the start conditions stay as
they are. `isExpectedFloor` is already imported by the module.

### Acceptance

In `tests/chest-probe.test.ts`:

- **RED first:** with `done` = the task's farm key `000000007f3ffe007ffeff00220bb600` and the map read
  `600004007f3ffe007ffefe0002032200` (the measured 9-bit drift of the same floor, `src/tasks/steps.ts:49-50`),
  the decision is `skip`, not `start`.
- A **different** floor (`ffxi`'s other colliery floor, 30–31 bits away — use the pair already in the repo's
  notes, or derive one and say so) still returns `start`.
- `done === null` still starts; a malformed `done` key starts (no floor matches) — state the choice.
- Every existing case in the file keeps its verdict.

Run: `npx tsc --noEmit` and `npx vitest run tests/chest-probe.test.ts`. Do not run or fix unrelated failures.

### Report

The RED and GREEN output for the drift case, the two floor keys used with their distance, and the
files changed.

---

## Deferred — pinned, with the reason

- **The ownership net** (a scripted game driving three cycles to `task-complete`) — after the live
  acceptance of Task 1.
- **The chest-opening misname** (`chest-opening` on a HUD-less 3-D view, run 6 at 05:26:19, 05:28:00,
  05:28:30) — the run saved no frames, so the fix would be unmeasured. Next live run captures the frame.
- **The level-up/XP page and the auto-battle settings dialog** — unnamed pages; need a capture.
- **The rest gate's timeout** already counts the cycle unrested and warns (the operator's matrix is then
  silently skipped) — bounded, visible, left as is.
- **The floor gate's tolerance** is 16 bits against a measured 9; no code needed (`src/tasks/steps.ts:44`).
- **The engine/supervisor's single restart, display sleep and foreground loss** — operational; the
  operator's run sheet owns them, not this plan.

## Acceptance of the plan

Task 1 and Task 2 land reviewed; the full suite is green; then the Lead runs the live three cycles
(`scripts/world-run.ts`, `cycles: 3`) and the run's console shows three `cycle N done` lines and the
`task-complete` end.
