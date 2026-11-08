# The loop's stages — one arbiter, one owner, one pump

Status: **design, implemented** (2026-11-09, plan `docs/plans/2026-11-09-loop-ownership.md` Task 1).
The registry lives in `src/policy/stage-registry.ts`; the pump point is in `src/world.ts`.

## 1. The three properties

The heal's owned episode (`07efd3c`) works because it has all three. The rest of the loop had none
of them, and each missing one is a *class* of defect, not a single bug:

1. **Liveness** — an owner is driven **every tick** it owns. A flag that says "I own this" is a
   promise that someone calls it; nothing in the code kept that promise.
2. **Exclusivity** — **one** owner at a time. The orientation and the leave both drove the exit path.
3. **Bounds** — an owner is released by **its own clock**, before the 150 s stall clock (which ends
   the session and masks a design hole as a "stop condition").

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
  stop/escalation is the classifier's.
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

## 5. The three deadlines (module-local in `src/world.ts`)

| Owner | Bound | Why |
|---|---|---|
| `exit` | `LEAVE_DEADLINE_MS = 120_000` | **Below** the 150 s stall clock on purpose: a stuck exit is released, not turned into a session stop. The measured leave is under 40 s, so this is a hang's bound, not a budget. |
| `orient` | `ORIENT_DEADLINE_MS = 180_000` | A climb from another floor is minutes' work. The orientation marks progress when it commands, so the stall clock only fires when it stops commanding; this bound is the backstop for an episode that keeps commanding and never arrives. |
| `stage` | `SCRIPT_DEADLINE_MS = 300_000` | A scripted stage walks the whole exit (harken, Dungeon Select, world map), one step a tick; its cursor is the step and this is the bound behind the cursor. The measured exit script took 48.7 s (2026-11-05) and a stage yields to battles and chests. |

Caveat, recorded rather than hidden: 120 s is **not** below the 150 s stall clock when the session
runs at the shipped default of 120 s (the stall check is earlier in the tick). The constant follows
the plan; the test pins the operator's 150 s setting, where the release demonstrably happens first.

## 6. What stays outside the registry

The **heal** episode, the **rest gate** and the **chest probe** already pump from their own branches
on every tick, and those branches pre-empt the pump point (they return before it). Converting them
would re-open the heal's freshly verified episode (`07efd3c`) for no defect: they have liveness by
construction, and no second owner contends for them. The same is true of the message box, the
character page, the inn and the QTE sub-loop. The registry governs the **intent-driven** stages only.

## 7. Acceptance

`tests/stage-registry.test.ts` pins the contract (refusal, idempotence, release, pump, overdue,
re-use after release). `tests/world.test.ts` (`the exit goal`) pins the four loop-level properties:
the harken deadlock taps the matched 归还 within five ticks and never stops; an off-floor map while
the exit owns logs no orientation re-arm and sends no orientation command; the deadline releases the
exit with one warning before the stall clock; and the owner is pumped once per tick (one matched tap
per tick on a page that stays).
