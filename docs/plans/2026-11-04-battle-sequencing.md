# The Battle Operation Sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution — the
> operator approved the design with "yes, do it"). Steps use checkbox (`- [ ]`) syntax.

**Goal:** every press the loop sends during a battle is one operation, in order, on a settled frame,
at least `battleStepMs` apart measured from the previous tap's return — speed → opener slot → opener
confirm → auto — with the timings configurable (contracts §8.5).

**Architecture:** a new pure policy module `src/policy/battle-sequence.ts` owns the steps and their
clocks; the World's fight branch asks it for one step per tick, sends at most one tap, and reports the
tap's return. The shared `Pacer` (`src/policy/pacing.ts`) is untouched.

**Tech Stack:** TypeScript (Node ≥22, ESM, `.ts` imports), vitest, pnpm, Windows live input.

**Spec:** [`docs/specs/2026-11-04-battle-sequencing-design.md`](../specs/2026-11-04-battle-sequencing-design.md)

## Global Constraints

- `src/contracts.ts` mirrors `docs/specs/2026-10-24-contracts.md` declaration for declaration; the
  config table (§8.5) moves with `src/config.ts` in the same commit. No TS contract declaration changes.
- The step pace is **configurable** (`battleStepMs`, default 1000, schema minimum 700 — the pacing
  primitive's floor). Never hard-code a battle timing in the module or the World.
- One tap per tick; the World awaits it. No timers, no parallel sleeps: the clock is the World's
  injected `now()`, the same one the pacer uses.
- The battle's order is fixed: settle → 倍速 → opener slot → opener confirm → 自動 → hold.
- Commit at every task, staged by explicit path; branch `feat/battle-sequencing`, fast-forward to
  `main` at the end. Verify with
  `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "<command>"`.

## Review Focus

1. **A frame without the toggles** (`speedOn`/`autoOn` absent — an observation a caller built, a
   non-1920 frame): must be a wait, never a blind press. Pinned in Task 1.
2. **An operator-started auto battle** (`autoOn` true, no command phase): 倍速 must still be pressed
   and no cast must be attempted. Pinned in Task 1 and Task 4.
3. **A refused tap** (game window not foreground): must be paced, must not spend an attempt, and must
   not advance the sequence. Pinned in Task 1.
4. **A battle that ends mid-sequence**: the next battle must start from settle with fresh counts.
   Pinned in Task 4.
5. **The read window expiring**: falls through to 自動 with no slot tap and one warning. Pinned in
   Task 1 and Task 4.

---

### Task 1: The sequence module

**Files:**
- Create: `src/policy/battle-sequence.ts`
- Test: `tests/battle-sequence.test.ts`

**Interfaces:**
- Consumes: `BattleOpener` from `src/contracts.ts` (type only).
- Produces:
  ```ts
  export interface BattlePhase { readonly speedOn: boolean | null; readonly autoOn: boolean | null; readonly activeMember: string | null }
  export type BattleWait = 'settle' | 'paced' | 'unreadable' | 'no-evidence' | 'speed-capped' | 'auto-capped';
  export type BattleStep =
    | { readonly kind: 'wait'; readonly why: BattleWait }
    | { readonly kind: 'speed' | 'auto' | 'done' }
    | { readonly kind: 'slot' | 'confirm'; readonly opener: BattleOpener };
  export interface BattleSequenceOptions { settleMs: number; stepMs: number; readWindowMs: number; toggleAttempts: number; openers: readonly BattleOpener[] }
  export class BattleSequence {
    constructor(options: BattleSequenceOptions);
    enter(nowMs: number): void;
    needsMemberRead(): boolean;
    next(phase: BattlePhase, nowMs: number): BattleStep;
    completed(nowMs: number): void;
    refused(nowMs: number): void;
  }
  ```

- [ ] **Step 1: Create the branch**

```bash
cd wvd-agent && git checkout -b feat/battle-sequencing
```

- [ ] **Step 2: Write the failing test**

`tests/battle-sequence.test.ts` — the cases and assertions:

```ts
import { describe, expect, it } from 'vitest';
import type { BattleOpener } from '../src/contracts.ts';
import { BattleSequence, type BattlePhase } from '../src/policy/battle-sequence.ts';

const alice: BattleOpener = { name: '爱丽丝', slot: '左下', target: 'enemy' };
const off: BattlePhase = { speedOn: false, autoOn: false, activeMember: null };
const on: BattlePhase = { speedOn: true, autoOn: false, activeMember: '爱丽丝' };

function make(): BattleSequence {
  return new BattleSequence({
    settleMs: 1_000, stepMs: 1_000, readWindowMs: 3_000, toggleAttempts: 3,
    resolveOpener: (name) => (name === alice.name ? alice : null),
  });
}

it('presses nothing before the settle window', () => {
  const s = make(); s.enter(0);
  expect(s.next(off, 999)).toEqual({ kind: 'wait', why: 'settle' });
  expect(s.next(on, 1_000)).toEqual({ kind: 'speed' });
});

it('runs speed -> slot -> confirm -> auto, one per pace', () => {
  const s = make(); s.enter(0);
  expect(s.next(on, 1_000)).toEqual({ kind: 'speed' });      // speedOn false
  s.completed(1_000);
  expect(s.next({ ...on, speedOn: true }, 1_999)).toEqual({ kind: 'wait', why: 'paced' });
  expect(s.next({ ...on, speedOn: true }, 2_000)).toEqual({ kind: 'slot', opener: alice });
  s.completed(2_000);
  expect(s.next({ ...on, speedOn: true }, 3_000)).toEqual({ kind: 'confirm', opener: alice });
  s.completed(3_000);
  expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 4_000)).toEqual({ kind: 'auto' });
  s.completed(4_000);
  expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 5_000)).toEqual({ kind: 'done' });
});

it('measures the pace from the tap's return, not its start', () => {
  const s = make(); s.enter(0);
  expect(s.next(on, 1_000)).toEqual({ kind: 'speed' });
  s.completed(1_700);                                        // the tap took 700 ms
  expect(s.next(on, 2_400)).toEqual({ kind: 'wait', why: 'paced' });
  expect(s.next(on, 2_700)).toEqual({ kind: 'slot', opener: alice });
});

it('waits for a readable turn card, then gives the cast up at the window', () => {
  const s = make(); s.enter(0);
  expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 1_000)).toEqual({ kind: 'wait', why: 'unreadable' });
  expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 3_999)).toEqual({ kind: 'wait', why: 'unreadable' });
  expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 4_000)).toEqual({ kind: 'auto' });
});

it('does not cast a member that is not on the list', () => {
  const s = make(); s.enter(0);
  expect(s.next({ speedOn: true, autoOn: false, activeMember: '本杰明' }, 1_000)).toEqual({ kind: 'auto' });
});

it('a battle already on auto gets 倍速 only', () => {
  const s = make(); s.enter(0);
  expect(s.next({ speedOn: false, autoOn: true, activeMember: null }, 1_000)).toEqual({ kind: 'speed' });
  s.completed(1_000);
  expect(s.next({ speedOn: true, autoOn: true, activeMember: null }, 2_000)).toEqual({ kind: 'done' });
});

it('an unreadable toggle is a wait, not a press', () => {
  const s = make(); s.enter(0);
  expect(s.next({ speedOn: null, autoOn: null, activeMember: null }, 1_000)).toEqual({ kind: 'wait', why: 'no-evidence' });
});

it('a refused tap is paced and does not spend an attempt', () => {
  const s = make(); s.enter(0);
  expect(s.next(off, 1_000)).toEqual({ kind: 'speed' });
  s.refused(1_000);
  expect(s.next(off, 1_500)).toEqual({ kind: 'wait', why: 'paced' });
  expect(s.next(off, 2_000)).toEqual({ kind: 'speed' });     // still owed, count not spent
});

it('stops at the configured attempts with one cap wait', () => {
  const s = make(); s.enter(0);
  for (let n = 0; n < 3; n += 1) {
    expect(s.next(off, 1_000 + n * 1_000)).toEqual({ kind: 'speed' });
    s.completed(1_000 + n * 1_000);
  }
  expect(s.next(off, 4_000)).toEqual({ kind: 'wait', why: 'speed-capped' });
  expect(s.next(off, 5_000)).toEqual({ kind: 'wait', why: 'speed-capped' });
});

it('a new battle starts from the settle', () => {
  const s = make(); s.enter(0);
  expect(s.next(on, 1_000)).toEqual({ kind: 'speed' }); s.completed(1_000);
  s.enter(9_000);
  expect(s.next(on, 9_001)).toEqual({ kind: 'wait', why: 'settle' });
});

it('does not read the panel when no opener is configured', () => {
  const s = new BattleSequence({ settleMs: 0, stepMs: 1_000, readWindowMs: 3_000, toggleAttempts: 3, resolveOpener: () => null });
  s.enter(0);
  expect(s.needsMemberRead()).toBe(false);
  expect(s.next({ speedOn: true, autoOn: false, activeMember: null }, 0)).toEqual({ kind: 'auto' });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "pnpm vitest run tests/battle-sequence.test.ts"`
Expected: FAIL — `Cannot find module '../src/policy/battle-sequence.ts'` (or the export).

- [ ] **Step 4: Implement `src/policy/battle-sequence.ts`**

State: `#enteredAtMs`, `#lastTapAtMs`, `#opener: BattleOpener | null | undefined` (undefined =
undecided), `#readSinceMs`, `#slotSent`, `#confirmSent`, `#speedTries`, `#autoTries`, `#sent`
(the step the last `next` returned, for the attempt count).

`next`, in this order:
1. not entered, or `now - enteredAt < settleMs` → `wait('settle')`.
2. `autoOn === true` and the opener is undecided → decide `#opener = null` (no command phase to cast
   into) — unless the sequence was entered with no resolvable opener case.
3. `lastTap !== null && now - lastTap < stepMs` → `wait('paced')`.
4. `speedOn === null` → `wait('no-evidence')`; `speedOn === false` → `speedTries >= toggleAttempts`
   ? `wait('speed-capped')` : `speed`.
5. opener undecided: `activeMember !== null` → `#opener = resolveOpener(activeMember)`; else
   `#readSinceMs ??= now`, and `now - readSinceMs >= readWindowMs` → `#opener = null`; otherwise
   `wait('unreadable')`.
6. `#opener !== null`: `!#slotSent` → `slot`; `!#confirmSent` → `confirm`.
7. `autoOn === null` → `wait('no-evidence')`; `autoOn === false` → `autoTries >= toggleAttempts`
   ? `wait('auto-capped')` : `auto`.
8. `done`.

`completed(now)`: stamp `#lastTapAtMs`; count the remembered `#sent` (speed/auto), or mark
`#slotSent` / `#confirmSent`; clear `#sent`.
`refused(now)`: stamp `#lastTapAtMs`; clear `#sent`; change nothing else (the step stays owed).
`needsMemberRead()`: `#opener === undefined && #enteredAtMs !== null` (an undecided opener with no
configurable resolver is impossible: the constructor has one).
`enter(now)`: set `#enteredAtMs = now` unless already set; never re-enter the same battle.

Header comment: cite the design doc, the operator's rule (turn-based; one operation at a time; 1 s,
≥700 ms; configurable), and the live 02:07 evidence. Keep it as long as the other policy modules'.

- [ ] **Step 5: Run the test and the typecheck**

Run: `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "pnpm vitest run tests/battle-sequence.test.ts"`
then `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "pnpm typecheck"`. Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/policy/battle-sequence.ts tests/battle-sequence.test.ts
git commit -m "feat(policy): the battle's operations are an ordered, paced sequence"
```

---

### Task 2: The configurable timings

**Files:**
- Modify: `src/config.ts` (interface ~line 43, defaults ~line 83, schema ~line 197)
- Modify: `docs/specs/2026-10-24-contracts.md` §8.5 table
- Test: `tests/definition.test.ts:101-142`

**Interfaces:**
- Produces: `WvdConfigSection.battleStepMs: number`, `.battleSettleMs: number`,
  `.battleReadWindowMs: number`; defaults 1000 / 1000 / 3000; schema
  `{ type: 'integer', minimum: 700, maximum: 5000 }` / `{ minimum: 0, maximum: 10000 }` /
  `{ minimum: 500, maximum: 10000 }`, each with a Chinese title/description in the console group.

- [ ] **Step 1: Write the failing test** — in `tests/definition.test.ts`, change the count test to
  "declares all thirty-nine contracts §8 keys": `36 → 39` twice, add to the `toMatchObject` defaults
  `battleStepMs: 1000, battleSettleMs: 1000, battleReadWindowMs: 3000`, and assert
  `properties['worlds.wvd.battleStepMs']` matches `{ type: 'integer', minimum: 700, maximum: 5000 }`.
- [ ] **Step 2: Run it** — FAIL: 36 keys, missing properties.
- [ ] **Step 3: Add the three keys** to `src/config.ts` (interface, `WVD_DEFAULTS`, the console
  schema with `title`/`description` in the file's own voice), and the three rows to the §8.5 table in
  `docs/specs/2026-10-24-contracts.md`.
- [ ] **Step 4: Run** `tests/definition.test.ts` and `pnpm typecheck`. PASS.
- [ ] **Step 5: Commit** — `feat(config): the battle sequence's timings are field knobs`.

---

### Task 3: The cast's two taps, split

**Files:**
- Modify: `src/actions/battle.ts:89-98`
- Test: `tests/battle-opener.test.ts`

**Interfaces:**
- Produces: `tapOpenerSlot(actuator, opener): Promise<ActionResult>` (the slot centre),
  `tapOpenerConfirm(actuator, opener): Promise<ActionResult>` (the configured `confirm`, else the
  target side). `castBattleOpener` keeps its behaviour (slot → settle → confirm) for scripts.

- [ ] **Step 1: Write the failing test** — two cases in the existing `describe('the battle opener cast')`:
  the slot alone taps `BATTLE_SLOTS['左下']` and nothing else; the confirm alone taps
  `opener.confirm` when set, `ENEMY_TARGET_AT` otherwise, and the refused slot still returns before
  any confirm.
- [ ] **Step 2: Run** `tests/battle-opener.test.ts` — FAIL: the exports do not exist.
- [ ] **Step 3: Implement the two functions**; rewrite `castBattleOpener` to call them in order with
  `OPENER_SETTLE_MS` between (keeping its early return on a refused slot).
- [ ] **Step 4: Run** the file and `pnpm typecheck`. PASS.
- [ ] **Step 5: Commit** — `refactor(battle): the cast is two taps the caller paces`.

---

### Task 4: The World runs the sequence

**Files:**
- Modify: `src/world.ts` (`WvdCommands` ~line 135-143; the reset sites ~991, ~1361-1373, ~1911-1915;
  the fight branch ~2208-2288; drop `#castOpener` ~2452-2477)
- Modify: `src/main.ts:235-260` (wire `battleSlot`/`battleConfirm`; keep the `WVD_CAPTURE_CAST`
  snapshot after the slot tap)
- Test: `tests/world.test.ts` (the battle block, ~947-1118; add the 02:07 replay)

**Interfaces:**
- Consumes: `BattleSequence`, `BattlePhase`, `tapOpenerSlot`, `tapOpenerConfirm`, the three config keys.
- Produces: the World's fight branch sends exactly one tap per tick and never two.

- [ ] **Step 1: Write the failing tests** in `tests/world.test.ts`:
  - the 02:07 replay: `combat` with a reader that answers null on the first frame and 爱丽丝 on the
    next; with `battleSettleMs: 1000, battleStepMs: 1000` — no press at t+0, none at t+999, 倍速 at
    t+1000, no press for another second, slot, confirm, 自動, each exactly `battleStepMs` after the
    previous tap returned;
  - a frozen frame (the same observation, clock advancing) never re-presses inside the pace;
  - the auto fallback: the frame keeps saying `autoOn: false`; exactly `autoBattleEnableAttempts`
    presses, one warning;
  - a battle that leaves and returns re-arms: settle again, counts from zero;
  - `autoOn: true` from the start: 倍速 pressed once, no slot/confirm, done.
  Use `cfg: { battleSettleMs: 1_000, battleStepMs: 1_000 }` explicitly; the existing tests' clock
  advances (800 ms etc.) must move to the new pace.
- [ ] **Step 2: Run** `tests/world.test.ts` — FAIL (the old branch presses at the wrong times).
- [ ] **Step 3: Implement**:
  - replace the five battle fields with `#battleSequence: BattleSequence | null`; build it in
    `#track` on the first `combat` frame (`settleMs: cfg.battleSettleMs, stepMs: cfg.battleStepMs,
    readWindowMs: cfg.battleReadWindowMs, toggleAttempts: cfg.autoBattleEnableAttempts,
    resolveOpener: (name) => openerFor(name, this.#cfg.dryRun ? [] : (this.#battle?.openers ?? []))`),
    `enter(now)`, and null it when the screen leaves `combat`;
  - the fight branch: `const phase = { speedOn: seen?.speedOn ?? null, autoOn: seen?.autoOn ?? null,
    activeMember: seq.needsMemberRead() && this.#battle !== undefined
      ? await this.#battle.reader.readActiveMember(context.frame) : null }`;
    `const step = seq.next(phase, now)`; for `speed`/`auto` call the command; for `slot`/`confirm`
    call the two commands; then `step.ok ? seq.completed(this.#now()) : seq.refused(this.#now())`;
    log the waits once (`unreadable`, `speed-capped`, `auto-capped`) with the existing lines;
  - delete `#castOpener` and the old `pressToggle`/`AUTO_PRESS_RETRY_MS`/`OPENER_READ_WINDOW_MS`
    uses; keep `AUTO_PRESS_RETRY_MS` only if something else reads it (nothing will — remove it).
- [ ] **Step 4: Run** `tests/world.test.ts`, `tests/battle-opener.test.ts`, `pnpm typecheck`. PASS.
- [ ] **Step 5: Commit** — `feat(world): the battle order is a sequence, one operation per pace`.

---

### Task 5: The record, and the green tree

**Files:**
- Modify: `docs/specs/2026-10-24-contracts.md` §11 prose ("paced 1.5 s apart" → the sequence)
- Modify: `docs/status.md` (a new dated section: the sequence, the measurements that did not change,
  the live verification still owed)
- Modify: `docs/specs/2026-11-04-battle-sequencing-design.md` (the final constants, if any moved)

- [ ] **Step 1: Update the documents** — contract prose, status record, the design doc's numbers.
- [ ] **Step 2: Full suite** —
  `node ~/.dsh/tools/check-digest.mjs --timeout 600 -- "pnpm test"` and `pnpm typecheck`. PASS.
- [ ] **Step 3: Commit** — `docs(battle): the operation sequence, measured and owed live`.
- [ ] **Step 4: Fast-forward to main** —

```bash
git checkout main && git merge --ff-only feat/battle-sequencing
```

The live acceptance (one battle, window untouched, the log's presses `battleStepMs` apart) is
**not** part of this plan: it spends the operator's machine and is asked for separately.
