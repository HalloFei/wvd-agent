# Farm tasks as data — design

A JSON task file per location, wvd-style: the steps that get the party there, the floor to farm,
and the way out. The World keeps its loop, its policy and its contracts; the file only says *what*
to farm and *where*.

Status: design, v2 after builder review; the entry script is now detection-driven —
[`2026-10-24-worldmap-entry-design.md`](2026-10-24-worldmap-entry-design.md) supersedes §7.2 and
the two fixed world-map taps. The rest stands. Binding declarations go into
[`2026-10-24-contracts.md`](2026-10-24-contracts.md) §3 and §10 and `src/contracts.ts` in the same
commit.

---

## 1. Why

Today the World is one hardcoded route: `src/policy/route.ts` assumes the party already stands on
the farm floor, and `docs/status.md` records the entry as out of scope. Two costs follow.

- A second location is a code change: floor title, chest budget and exit command are literals.
- A session can only be started by a human who has already driven the game to the floor; the
  "complete loop" has never been run end to end.

The upstream autoscript solved this with `resources/quest/quest.json`: one object per location,
each listing `_EOT` (entry), a target list and tips. This design takes its one good idea — a
location is data — without its weakness: wvd's file also encodes *how* to farm. Here the file
carries the route and its gates; the farm decisions stay in the policy.

## 2. Goals

- One JSON file per location, committed under `tasks/`.
- The file declares: an entry script, the floor to verify, and an exit script.
- Loaded and validated at session start. A bad file is a typed failure, never a throw or a crash.
- Scripts execute through the existing `Actuator`, `Perceiver` and `FrameSource` contracts only.
- The per-tick farm decisions remain the existing route policy; the task decorates it, it does not
  replace it.
- A live proof on FFXI 4F: from town, enter, climb, farm, leave.

## 3. Non-goals

- New screen recognisers. `town`, `worldmap` and the dungeon-select list stay unnameable
  (see §7.2 for what that costs and why it is accepted).
- Image-template matching. The wvd templates are mobile 900×1600 crops and untrustworthy here.
- A scripting language: no variables, loops or conditionals. An ordered list of steps.
- A task-level chest budget (§7.6).
- The chest/QTE work already on the board — separate tasks.
- Taking the foreground. The engine cannot steal it (§8 risk); this design does not add it.

## 4. Anti-goals

- **The file must not encode farm decisions.** The moment a step says "if willpower < 60, reroll",
  approach A has returned and we have two policies.
- **The World must not read JSON or know a step's name.** Its whole knowledge of a task is: run
  `enter` before the first tick, run a named script when the policy asks, stop when it says so.
- **No silent fallback.** A step whose expectation is not met fails and stops the session. A guessed
  click can move the party to another floor; the fix is a better file, not a retry.

## 5. Constraints

- `src/contracts.ts` mirrors the contracts spec declaration for declaration.
- Failure is a value (§0.6): every new function returns a typed result.
- Coordinates are client device pixels of the 1920×1080 window; the engine converts once.
- Input reaches the game only while it is foreground; a refused press is `rejected` and is never
  retried by the runner.
- A session must remain stoppable at every moment, including while a script runs (§7.8).

## 6. Approaches

**A. Literal wvd port — the whole route as primitive steps, one interpreter.**
*Rejected.* It cannot express "walk to the nearest chest shown on the map" or "fight what is in the
way", so it either duplicates the policy or gives up the reactivity the perception work bought.

**B. Declarative spec only — floor, targets, exit.**
*Rejected.* It cannot express the world-map → dungeon-select → stairs chain at all; that chain is
fixed UI, not a decision, and forcing it into the policy puts coordinates into policy code.

**C. Split by ownership — chosen.**
`entry`/`exit` are *scripts* (a fixed UI path, exactly where wvd's `_EOT` lived); the farm loop
stays the policy; the runner executes scripts; the World runs the loop and knows only that a task
exists. Decided by the operator on 2026-10-24: "do c, remember modular and interface contracts".

## 7. The design

### 7.1 Prerequisite: a floor identity the perceiver can produce

**Measured 2026-10-24.** `readMap` on a live FFXI 4F frame (`第四区-城内2F深处-`) returns `null`.
Instrumenting the gates showed it passes size, uniformity, the X/Y readout (`X:11 Y:23`), the title
bar, the map ink, and fails only at R27 — the title reader matches three fixed Latin slots (`B 1
F`) and the visible half of the bar is a 400×40 string of Chinese glyphs. So on this floor the World cannot even
name `dungeonmap`, and no task can farm it.

The fix is a floor *fingerprint*, not an OCR:

- `MapState` gains `titleKey: string` — a 32-hex fingerprint of the title region: 32×4 cells over
  (800, 40, 400, 40), luma > 170 counts as ink, each cell binarised against the region's mean.
- `floorTitle` keeps its meaning: the Latin token, or `''` when the slots do not match.
- `readTitle` keeps the ink gate (≥ 400 lit px) — that is what keeps a HUD frame out — and, when the
  slots fail, returns `{ text: '', titleKey }` instead of `null`, capping confidence at 0.85.
- Measured keys: FFXI 4F `000000007f3ffe007f7efe00220ba600` (identical on four frames), B1F
  fixture `0001c00003e6c00003efe00003874000`, HUD all zeros (and refused at the ink gate anyway).

Evidence to commit: `testdata/nav-2026-10-24-ffxi4f/map.jpg` (one captured frame) and its expected
key in `tests/map.test.ts`. This is the only perception change in the design, and the task file
depends on it.

### 7.2 Entry is blind, and that is accepted

`town` and `worldmap` are not nameable: `main.ts` registers only the chest, map and HUD perceivers.
A gated "expect town" would time out on every session.

So an entry script is executed *blind* — waits between taps — and the **floor gate is the only
permission to farm**. It is enforced by the loop, not by the script: the map is the only surface
that prints the floor and the loop is what opens it, so `createTaskPolicy` checks every map read
against `floor.titleKey` (8-bit tolerance, R27b) and stops the session before the move it would
authorize. The script proves the route up to the stair; the loop waits out the game-driven walk the
last step started (its own arrival rule) and takes the gate from there. If the run lands anywhere
but the expected floor, the gate fails and the session stops; it never sends a farm input. The
accepted risk is a mis-tap on the way in (the 2026-10-24 miss-click landed on 诺森霍洛村 and was
recoverable). Two mitigations: `dryRun` (config) logs every step without sending input, and the
console shows the step index as it runs.

This is deliberately *not* "add a town recogniser" — that is a perceiver task with its own fixtures,
and pretending otherwise would stall the task-file work behind it.

### 7.3 Modules

| Path | Owns | Depends on |
| --- | --- | --- |
| `tasks/ffxi-4f.json` | the data | — |
| `src/tasks/schema.ts` | types, `parseTask(unknown): TaskLoad` | `contracts.ts` types only |
| `src/tasks/steps.ts` | `runSteps(script, env): Promise<ScriptResult>`; one function per op | `Actuator`, `Perceiver`, `FrameSource`, sleep |
| `src/tasks/runner.ts` | builds a `ScriptEnv` from a session: `enter()`, `byName()` | `steps.ts`, `schema.ts` |
| `src/tasks/policy.ts` | `createTaskPolicy(task, inner): FarmPolicy` | `schema.ts`, `contracts.ts` |

`steps.ts` never sees a `TaskDefinition` (it takes a `TaskScript`); `policy.ts` never sees a step;
`schema.ts` imports nothing but types.

### 7.4 The file

```json
{
  "id": "ffxi-4f",
  "label": "[Chest] FFXI 4F",
  "floor": { "titleKey": "000000007f3ffe007f7efe00220ba600" },
  "entry": {
    "timeoutMs": 120000,
    "steps": [
      { "op": "tap", "at": [1200, 1030] },
      { "op": "wait", "ms": 2500 },
      { "op": "tap", "at": [1051, 388] },
      { "op": "wait", "ms": 4000 },
      { "op": "tap", "at": [1082, 520] },
      { "op": "wait", "ms": 15000 },
      { "op": "expect", "screen": "dungeon", "timeoutMs": 45000 },
      { "op": "tap", "at": [1849, 110] },
      { "op": "expect", "screen": "dungeonmap", "timeoutMs": 8000 },
      { "op": "expectFloor", "timeoutMs": 5000 }
    ]
  },
  "exit": {
    "timeoutMs": 60000,
    "steps": [
      { "op": "tap", "at": [1849, 110] },
      { "op": "expect", "screen": "dungeonmap", "timeoutMs": 8000 },
      { "op": "key", "key": "r" },
      { "op": "tap", "at": [1073, 270] }
    ]
  }
}
```

Parser rules: `id` and `label` non-empty; `floor.titleKey` is 32 lowercase hex; every `at` is two
integers in `0..16383`; `count` is 1 or 2; `op` is one of the five below; **unknown keys and
unknown ops are rejected, not ignored** (a typo is otherwise a silent no-op); timeouts are `> 0`;
`exit` is optional.

There is no `farm` section: the World already owns *when* to leave (its own chest count from the
map), and the file owns *how*. A task-level budget would require a `RouteState`/World change and is
deferred until a location needs it.

### 7.5 Step ops

| op | Fields | Semantics |
| --- | --- | --- |
| `tap` | `at`, `count?` | `actuator.tap`; a `rejected` press ends the script with `rejected` |
| `key` | `key`, `holdMs?` | named game key → scan code in one table; `holdMs` clamped to `MAX_PRESS_HOLD_MS` |
| `wait` | `ms` | sleeps, abortable |
| `expect` | `screen`, `timeoutMs?` | captures and observes every 100 ms until the screen matches |
| `expectFloor` | `timeoutMs?`, `titleKey?` | same loop, matching a `dungeonmap` observation whose `titleKey` equals `floor.titleKey` by default, or the step's `titleKey` (32 hex) when it names one — so one script can gate 第三区 and 第四区 |

`key` names in v1: `g`, `l`, `q`, `f`, `r`, `tab`, `esc`, `space`. The table sits beside `SCAN` in
`actions/automove.ts`; a test asserts the two agree for G/L/F/Q.

### 7.6 Contracts (§3 and §10, mirrored in `src/contracts.ts`)

```ts
// §3, added
export interface MapState {
  readonly floorTitle: string;   // the Latin token, '' when the title is not Latin
  readonly titleKey: string;     // 32 hex: the floor's title fingerprint
  readonly player: Point;
  readonly icons: readonly MapIcon[];
}

// §10, new
export type ScriptId = 'enter' | 'exit';

export interface TaskStep {
  readonly op: 'tap' | 'key' | 'wait' | 'expect' | 'expectFloor';
  readonly at?: readonly [number, number];
  readonly count?: 1 | 2;
  readonly key?: 'g' | 'l' | 'q' | 'f' | 'r' | 'tab' | 'esc' | 'space';
  readonly ms?: number;
  readonly screen?: ScreenId;
  /** `expectFloor` only: gate this floor instead of the task's own key. */
  readonly titleKey?: string;
  readonly timeoutMs?: number;
}

export interface TaskScript { readonly timeoutMs: number; readonly steps: readonly TaskStep[] }

export interface TaskDefinition {
  readonly id: string;
  readonly label: string;
  readonly floor: { readonly titleKey: string };
  readonly entry: TaskScript;
  readonly exit?: TaskScript;
}

export type TaskLoad =
  | { readonly ok: true; readonly task: TaskDefinition }
  | { readonly ok: false; readonly reason: TaskFileProblem; readonly detail?: string };

export type TaskFileProblem =
  | 'not-json' | 'not-an-object' | 'missing-field' | 'unknown-field' | 'unknown-op'
  | 'bad-coordinate' | 'bad-timeout' | 'bad-title-key';

export type ScriptResult =
  | { readonly ok: true; readonly steps: number; readonly ms: number }
  | { readonly ok: false; readonly step: number;
      readonly reason: ActionFailure | 'expect-timeout' | 'floor-mismatch' | 'script-timeout'
        | 'cancelled' | 'capture-unavailable';
      readonly detail?: string };

export interface ScriptEnv {
  readonly actuator: Actuator;
  readonly capture: () => Promise<Frame>;
  readonly observe: (frame: Frame) => Promise<Observation>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly abort: AbortSignal;
  readonly log: (line: string) => void;
}

/** What the loop needs from a task: two calls, both returning a typed result. */
export interface SessionTask {
  enter(): Promise<ScriptResult>;
  runScript(name: ScriptId): Promise<ScriptResult>;
}

export type SessionOpen =
  | { readonly ok: true; readonly session: WvdSession; readonly task?: SessionTask }
  | { readonly ok: false; readonly reason: 'no-engine' | 'task-file-invalid'; readonly detail?: string };
```

`Intent` gains `{ kind: 'run-script'; name: ScriptId }`; `RouteCommands` gains
`runScript(name: ScriptId): Promise<ActionResult>`.

### 7.7 The runner

- `enter()` requires no starting screen: it runs when the session starts (blind, §7.2).
- The exit script requires the 3D view: if the current observation is `dungeonmap`, the runner
  presses `esc` once and waits up to 2 s for `dungeon` first (the policy can return `exit` with the
  map still open — that is the zero-chest case). If neither screen appears, `exit` fails with
  `expect-timeout` and the session stops.
- Capture failures are retried three times inside a step's timeout; then `capture-unavailable`.
- Every step checks `env.abort` first; `wait` wakes on abort. A cancelled script returns
  `cancelled` and sends nothing further.

### 7.8 The World's whole knowledge of a task

- `openSession()` returns `SessionOpen`; the composition root loads the file per session (so an
  edited file is picked up) and builds the runner from that session's `FrameSource`.
- `startSession`: set `#running` (stoppable), then `task.enter()`. Failure → `endSession` with
  `task-entry-failed` (or `task-file-invalid`), one `wvd.stopped`, and a console line naming the
  failed step and op. No tick runs.
- `#execute({ kind: 'run-script' })` → `task.runScript(name)`. Success on `exit` ends the session
  at once with `task-complete` — no further tick, so the post-exit screen (town, nameable by
  nothing) never reaches the classifier. Failure → `task-exit-failed`.
- `endSession` aborts the script's signal and waits for the in-flight step (bounded by the press
  ceiling), so a stop never leaves keys down.
- On an entry/exit failure the console line and the last observation are the operator's evidence.
  No image is attached to `wvd.stopped`: an escalation after the session ended would be a question
  nobody can answer. `wvd_look` still captures the current screen on request.

**Superseded in part, 2026-11-02 — the goal form.** A task may instead carry a `goal` and no
`entry`: `startSession` then does not run a script at all, it sets the orientation phase and the
tick loop drives the party to the task's floor from any screen (contracts §10, and
`2026-11-02-orient-goal-design.md`). A task carries exactly one of `entry` / `goal`. Everything
else here still holds; `enter` is the scripted task's path, and `climb` joins `enter`/`exit` as a
script a task may name.

### 7.9 The decorated policy

`createTaskPolicy(task, inner = routePolicy)`:

1. **Floor gate** — if the observation is a `dungeonmap` whose `titleKey` is not the task's (8-bit
   tolerance), return `{ kind: 'stop', reason }` naming both keys. This runs on the frame the loop
   would steer from, before `inner.next` can yield a `move`.
2. `inner.next(state)` — unchanged, so every existing test keeps its meaning.
3. If the intent is `exit` and the task has an exit script → `{ kind: 'run-script', name: 'exit' }`.
4. Otherwise pass the intent through.

No other rule; the session ends when the exit script returns. The gate is not in `enter` because a
blind script cannot wait out a game-driven walk, a fight or the 打开 prompt, and the map it would
have to read is opened by the loop afterwards (see §7.2).

### 7.10 Config

`worlds.wvd.taskFile: string`, default `''` (today's behaviour). A non-empty value resolves against
the package root; an absolute path is taken as-is. Read per session, not at construction.

### 7.11 Failure policy

| Where | Failure | Result |
| --- | --- | --- |
| load | bad JSON / schema | session refuses to start: `task-file-invalid`, the reason in the console |
| enter | any step | session ends: `task-entry-failed`, one `wvd.stopped`, step index in the log |
| tick | policy stops | unchanged from today |
| tick | `run-script` fails | session ends: `task-exit-failed` |
| any | stop hotkey / console stop | aborts the script, `cancelled`, session ends `stopped-by-operator` |
| any | capture failing three times | step fails `capture-unavailable` |

### 7.12 Tests

- `tests/map.test.ts` (extend) — the FFXI frame yields `titleKey` and `floorTitle: ''`; the B1F
  fixture keeps `floorTitle: 'B1F'` and gains a key; the HUD still refuses; two frames of one floor
  share a key, two floors do not.
- `tests/task-schema.test.ts` — valid file; every `TaskFileProblem`; unknown op and unknown field
  both fail; coordinate range; `exit` optional.
- `tests/task-steps.test.ts` — fakes for actuator/capture/observe: order preserved; `rejected` ends
  the script; `expect` timeout → `expect-timeout`; `expectFloor` matches the task key only; key
  table agrees with `automove.ts`; `holdMs` clamped; abort → `cancelled` and no further input.
- `tests/task-policy.test.ts` — exact delegation for every screen; `exit` → `run-script`; no exit
  script passes `exit` through.
- `tests/task-runner.test.ts` — exit from `dungeonmap` presses `esc` then continues; exit from
  `town` fails `expect-timeout`; capture retried three times then `capture-unavailable`.
- `tests/world.test.ts` (extend) — `enter` runs before the first capture; a failing `enter` pushes
  exactly one `wvd.stopped` and no tick; a successful exit ends the session `task-complete` without
  another tick; a stop during `enter` aborts it; the entry's walk holds the loop's first command
  until the scene stands still for `automoveStillSeconds` (`#handOffEntry`).
- `tests/task-run.test.ts` (extend) — the decorator stops on a map that is not the task floor and
  names both keys, accepts the task floor within the 8-bit tolerance, and passes everything else
  through unchanged.

### 7.13 Live proof (acceptance)

Recorded as §4.6 of the live guide when it passes: town → world map → 北穿幽靈城 → 第三区 →
3D view → map → stairs → 第四区 title → farm one chest → harken → 归还 → `task-complete`.

Measured coordinates (1920×1080, client pixels, 2026-10-24):

| Element | Point |
| --- | --- |
| world-map button (town) | (1200, 1030) |
| 北穿幽靈城 icon, map opened from the village | (1051, 388) |
| Dungeon Select rows, x ≈ 1082 | 入口 348, 第一区 407, 第二区 465, 第三区 520, 第四区 580, 打开世界地图 645 |
| dungeon map via minimap click | (1849, 110) |
| 自动移动 popup after a pointer-mode tile click | (1073, 270) |
| altar modal dismissal 什么也不做 | (950, 925) |

## 8. Risks

- **The window cannot be stolen.** `SetForegroundWindow` is refused while another app owns the
  input queue; minimize+restore works but is disruptive. A `focus` engine op is a separate task
  (board). Unattended runs need the game left focused.
- **The world map opens at a pan that depends on the party's position.** From the capital the FFXI
  icon sits at the top edge and the tap lands on 诺森霍洛村 (the old wvd bug). The file assumes the
  map opens from the village hub, or that (1051, 388) is the icon; making it deterministic is the
  board's "entry reliable" task.
- **The altar modal is a trap.** It looks like stairs and lists zones; a script must never click it
  blindly. 什么也不做 at (950, 925) is the only dismissal.
- **The stair transition is unverified.** On 2026-10-24 the party entered 第四区 directly, `L` was
  inert and the party ended in the harken room. The first live run may stop at `expectFloor`.

## 9. Left to the builder

- The exact entry/exit step sequence and coordinates for the stair transition and the chest step —
  measure, do not guess.
- Whether `key: "l"` works after the climb; if not, the file uses pointer mode and the popup, and
  no new op is needed.
- The console line's exact text for a failed step.
- Whether `Intent.run-script` later needs an argument (a script per farm phase) — not now.
