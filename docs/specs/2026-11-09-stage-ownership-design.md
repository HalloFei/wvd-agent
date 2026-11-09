# The loop's stages — one arbiter, one owner, one pump

Status: **design, implemented** (2026-11-09, plan `docs/plans/2026-11-09-loop-ownership.md` Task 1).
The registry lives in `src/policy/stage-registry.ts`; the pump point is in `src/world.ts`.

## 1. The three properties

The heal's owned episode (`07efd3c`) works because it has all three. The rest of the loop had none
of them, and each missing one is a *class* of defect, not a single bug:

1. **Liveness** — an owner is driven **every tick** it owns. A flag that says "I own this" is a
   promise that someone calls it; nothing in the code kept that promise.
2. **Exclusivity** — **one** owner at a time. The orientation and the leave both drove the exit path.
3. **Bounds** — an owner is released by **its own clock**. Only the exit's sits below the shipped
   `stallStopSeconds` stall clock (120 s; run 7's harness ran 150 s, which is history, not the
   default): the orientation's (180 s) and a scripted stage's (300 s) are backstops **above** it,
   because their work is minutes long. The stall clock ends the session and would mask a design hole
   as a "stop condition".

## 2. The live reproduction

Live run 7 (`.tmp/runs/2026-11-09-3-cycles-7/console.log`):

- `06:00:02 leaving: walking to this floor exit with F` — the leave pressed F;
- `06:00:02 off the task floor; the orientation is re-armed` — a **second owner** acted on the same
  exit path in the same tick;
- `06:00:20 STATE running | harken-menu` — the party arrived on the floor's harken page;
- `06:02:50 STATE stopped | harken-menu | nothing changed for 150 s`.

The leave was correct (a goal with no cursor, `policy/leave.ts`), but its only pump sat inside the
policy's `run-script` intent, and on `harken-menu` the route returns `wait`
(`policy/route.ts`). The harken branch deferred to the leave's flag and returned, so the tick never
reached any pump: ownership without a driver.

## 3. The registry contract

```ts
export type StageName = 'orient' | 'exit' | 'stage';

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
  claim(name: StageName, now: number): StageClaimResult;   // idempotent for the owner (re-stamps the pump)
  release(name: StageName): boolean;                        // false when not the owner
  pump(name: StageName, now: number): boolean;              // false when not the owner
  overdue(now: number, deadlineMs: number): boolean;        // the owner has *held* the loop that long
  readonly owner: StageClaim | null;
}
```

Pure of the clock (every method takes `now`), total (no method throws), and it knows no screen, no
command and no World. `sinceMs` is the **claim's**, not the last pump's: a deadline measures the
episode, so an owner that keeps pumping is still bounded.

## 4. Where the pump sits, and why

One pump point in `#step`, where the scripted stage's pump always was: after the verdict and the
loop's own screen branches, before the route. Order: `exit` → `#pumpLeave`, `stage` →
`#pumpScript`, `orient` → `#pumpOrient`.

- It runs only when `verdict === 'ok' && !waiting`: an in-flight command owns the interface, and a
  stop/escalation is the classifier's — including the **stall promotion**, which is computed *above*
  the pump point (a quarter of the stall stop, 30 s at the defaults). A stalled owner must not
  suppress the question by spending the tick it stalled on: that ordering is the base build's, and
  the final review restored it.
- It skips `WORLD_SCREENS` (a battle, a chest, the loot card, a page, the inn, a message): those are
  the loop's own, and the route finishes them — an owner must never starve the battle panel the way
  the orientation once did (2026-11-07 22:13).
- Each pump calls `#stages.pump` on entry whatever it decides, sends **at most one** command, sends
  **nothing while waiting**, and marks `#lastProgressAtMs` only when it commands. A pump that
  **yields** (`yield` from the leave or the orientation) hands the tick back to the route instead of
  spending it.
- The harken page **falls through** to the pump when the exit owns: the branch no longer returns, so
  the leave's own rule decides the page (`policy/leave.ts` taps the **matched** 归还 row).
- The exit starts once, in `#execute`'s `run-script` branch: `claim('exit')`; refused → one line,
  nothing acts, the next tick tries again. Released on `arrived`, `stop`, the deadline, and the
  cycle/session resets. `#staging` is never set on the leave path (it has no cursor).
- `#leaving` and `#orienting` are **derived** getters over `#stages.owner` — there is no second
  place for an owner to live.
- **Trap, deliberately not "fixed":** `#lastMapRead.floor` is `MapState.floorTitle`, the Latin floor
  token, which is `''` on the FFXI colliery floors; `floorKind('')` is therefore `'unknown'`, not
  `'farm'`, and the leave correctly taps **归还** on the harken page (归还 returns to **Dungeon
  Select**, not to the town — the leave travels from there). Making the empty floor mean "farm" would
  make the exit back out of the page and loop forever. `policy/leave.ts` is unchanged.

## 5. The three deadlines (in `src/world.ts`)

| Owner | Bound | Why |
|---|---|---|
| `exit` | `LEAVE_DEADLINE_MS = 110_000` | **Below the shipped `stallStopSeconds` (120 s) with a 10 s margin**, on purpose: the release runs *after* the stall check in the tick, so a bound at or above the stop never fires at the default. A stuck exit is released, not turned into a session stop. It is a hang's bound, not a budget: run 10 measured a **working** exit at **~112 s** (the world-map panning dominates it), so this bound fired on a working exit. The value and the mechanism are card `t-mw8k2hjp-3bh4ld`. |
| `orient` | `ORIENT_DEADLINE_MS = 180_000` | A climb from another floor is minutes' work. The orientation marks progress when it commands, so the stall clock only fires when it stops commanding; this bound is the backstop for an episode that keeps commanding and never arrives. Run 10 measured a **working** re-entry at **~179 s** (world-map panning again), released one second later — also card `t-mw8k2hjp-3bh4ld`. |
| `stage` | `SCRIPT_DEADLINE_MS = 300_000` | A scripted stage walks the whole exit (harken, Dungeon Select, world map), one step a tick; its cursor is the step and this is the bound behind the cursor. The measured exit script took 48.7 s (2026-11-05) and a stage yields to battles and chests. |

The deadline is measured against the **shipped** `stallStopSeconds` (120 s), not against a live run
sheet's 150 s. The tick checks the stall clock first and releases an overdue owner afterwards, so the
bound must be strictly below the stop at the configuration the package actually ships — hence 110 s,
with a 10 s margin. An operator who lowers `stallStopSeconds` below the deadline gets the stop
instead of the release: that is the documented trade. `tests/world.test.ts` pins the relationship
(`LEAVE_DEADLINE_MS < WVD_DEFAULTS.stallStopSeconds * 1000`, a property rather than a second magic
number) and the release itself at the shipped default.

**What a release can achieve.** It hands the loop back to the route, and the route (or a World
branch) re-claims the work only from a screen it acts on — `dungeon`, `dungeonmap`, `town`, and the
harken page the World's own branch owns. On `worldmap`, `dungeon-select` and `loading` nothing
re-claims it, so the stall clock still ends the session; `tests/world.test.ts` pins that sequence
(the release, then the shipped stop). A release is a second chance, not a guarantee.

The bound is applied on the tick that **reaches the pump point**. `#releaseOverdueStage` sits below
the loop's own early returns — the settle window, a stop, death, the revive QTE, a ui-menu, the rest
gate, the heal, the character page, the inn/message and the blank hold — so a screen those branches
hold never reaches it: a never-closing character page is still the stall clock's stop, not a release.
The bound promises nothing about ticks that never get there.

`LEAVE_DEADLINE_MS` is exported only so the test can pin that relationship by name; it is not part of
the World's contract.

## 6. What stays outside the registry

The **heal** episode and the **rest gate** already pump from their own branches on every tick, and
those branches pre-empt the pump point (they return before it). Converting them would re-open the
heal's freshly verified episode (`07efd3c`) for no defect: they have liveness by construction, and
no second owner contends for them. The same is true of the message box, the character page, the inn
and the QTE sub-loop. The registry governs the **intent-driven** stages only.

The **chest probe** is outside the registry for a different reason, and the earlier draft got it
wrong: it does **not** return before the pump point. Its "no chest" resolution is a tick-level
check (`#step`) that falls through, its start is inside `#leaveStep` — i.e. inside the exit's own
pump — and an in-flight probe spends the tick inside that pump too. It is not registered because it
has **no competing owner**: it is the exit's own work, sequenced by the exit's pump and answered by
the tick's probe check, so a second claim would only be a second way to say who acts.

## 7. Acceptance

`tests/stage-registry.test.ts` pins the contract (refusal, idempotence, release, pump, overdue,
re-use after release). `tests/world.test.ts` (`the exit goal`) pins the four loop-level properties:
the harken deadlock taps the matched 归还 within five ticks and never stops; an off-floor map while
the exit owns logs no orientation re-arm and sends no orientation command; the deadline releases the
exit with one warning before the shipped stall clock; and the owner is pumped once per tick (one
matched tap per tick on a page that stays). `the stage bounds` pins the other two releases — the
orientation's and a scripted stage's: owned, no command, one warning, and the session still running
afterwards. `the orientation` adds the mark's placement: a command
the owner declines to send marks no progress, so the run ends on the stall clock at the shipped stop
and not on the owner's own 180 s bound.
