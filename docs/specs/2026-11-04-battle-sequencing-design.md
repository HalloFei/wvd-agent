# 2026-11-04 — The battle's operations are a sequence, not a reflex

The operator's rule (2026-11-04): **a battle is turn-based, not real time.** One decision can be made
slowly. So the loop must not rush presses: it waits for a frame that has stopped moving, does its
operations **in order but never at the same time**, and paces them in units of **1 s, at least
700 ms**. The timings are **configurable from the start** — they are field knobs, not constants.

## Why

The World's fight branch (`src/world.ts`, `case 'fight'`) is an if-chain evaluated on every
100 ms tick, paced by `src/policy/pacing.ts`:

- the pacer's stability key is `observation.screen` (`world.ts:1103`). Inside a battle that key is
  `combat` for the whole fight, so "two stable frames" is satisfied ~200 ms after the battle appears —
  while the party panel is still drawing. Live 02:07: the first combat frame read no gold card; the
  saved next frame reads 爱丽丝 at 68.8.
- the pace is stamped at an operation's **start** (`world.ts:2241`, `:2268`, with the frame's clock).
  The opener is two taps with a blind `OPENER_SETTLE_MS = 700` between them
  (`src/actions/battle.ts:78,94-97`). When the cast returns, the pace is already spent, so 自動 can
  be pressed on the very next tick — **~100 ms after 確認**, inside the skill's resolution. That is the
  swallowed press the retry fallback (`t-mvzckmbm`) exists to paper over.

`23498b9` fixed the read window (a readable panel is retried, auto is not pressed while the read is
owed); it did not sequence the presses. `f20a89d` fixed the order; the clock is still the frame's.

## The sequence

New module `src/policy/battle-sequence.ts`: the battle's operations as ordered **steps**, each one
tap, each with its own clock.

| # | step | precondition (from the frame) |
|---|---|---|
| 0 | settle | the battle's first named `combat` frame + `battleSettleMs` |
| 1 | 倍速 | the frame says it is **off** (contracts §2 `speedOn`) |
| 2 | 自動 off | the cast is still owed **and** the frame says 自動 is **on**: the battle plays itself, so it draws no command phase — 自動 is turned off to reach one |
| 3 | opener slot | the ACTIVE card is readable and the member is on the opener list (contracts §11) |
| 4 | opener confirm | the slot tap was sent; the panel is up |
| 5 | 自動 | the frame says it is **off** (`autoOn`) — the step that hands the battle back to auto |
| 6 | hold | both on and the opener decided; the mode owns the battle until it ends |

Invariants, each pinned by a test:

- **one operation at a time**: one step per tick, one tap per step, the World awaits the tap before the
  next tick. The sequence never issues two taps in one call.
- **ordered**: a step runs only after every earlier step is finished.
- **paced**: after a tap returns, the next step waits `battleStepMs` on the same monotonic clock.
  The cast's internal 700 ms settle disappears: the slot and the confirm are separate steps paced like
  everything else.
- **settled**: no press before `battleSettleMs` since the battle's first frame. The opener's slot is
  sent only when the ACTIVE member is **confirmed**: the caller hands the name over only after it has
  been the same on consecutive frames (`BATTLE_STABLE_READS = 2`), and a null or unconfirmed read is
  a **wait**, never a slot tap. The whole waiting is bounded by `battleOpenerTimeoutMs` — not by a
  short window from the first miss.
- **无 rush on a toggle**: a toggle step is sent only when the frame says its toggle is off; a press
  that does not take is retried on a later step's turn, capped by `autoBattleEnableAttempts`
  (the existing fallback, kept).
- **自動 already on, and the cast still owed**: the sequence turns 自動 **off**, casts the opener once,
  then turns 自動 back **on** — enter → off → cast → on (operator rule, later on 2026-11-04: *when
  starting a new farm task, at the first cycle when entering a battle, turn off auto battle if on, use
  the opener skill once, then turn on auto battle*). The rule belongs to the **first battle of the
  first cycle of a farm task**: the World hands the sequence an opener list only for that battle
  (`#cyclesDone === 0 && #battlesEntered === 0`). Every later battle gets an **empty** list, so the
  sequence only keeps 自動 **on** — it presses it when the frame says it is off — and never casts or
  reads a turn card. A battle with no configured opener is left alone the same way: nothing to cast, so
  自動 is never touched. If 自動 will not come off within `autoBattleEnableAttempts` tries, the cast is
  given up and the battle continues on auto.
- **re-arm**: the sequence lives as long as the battle **mode** does — an unnamed frame inside a
  battle (a skill's resolution, a fade) keeps it, so the opener cannot be cast twice; leaving the mode
  drops it and the next battle starts from settle.

The turn-card gate applies to the **slot** step (the opener's own precondition). The toggle steps are
gated by their own state, so 倍速 can still be pressed in an operator-started auto battle, where no
turn card exists. This is the builder's reading of the operator's "stable frame": the settle window
plus each step's own evidence, not a pixel-stillness measure — a battle's still threshold is
unmeasured, and a stillness gate would need a capture first.

## Config (contracts §8.5 + `src/config.ts`)

| key | type | default | range | meaning |
|---|---|---|---|---|
| `battleStepMs` | integer | `1000` | 700–5000 | between two battle operations, measured from the last tap's **return** |
| `battleSettleMs` | integer | `1000` | 0–10000 | after the battle's first frame before the first press |
| `battleOpenerTimeoutMs` | integer | `10000` | 1000–60000 | how long the opener may wait for a confirmed turn card before the cast is given up |

`battleStepMs` replaces the hard-coded `OPENER_SETTLE_MS` between the slot and the confirm, and
`battleOpenerTimeoutMs` replaces the `OPENER_READ_WINDOW_MS` constant and the old fixed 3 s window:
the loop keeps checking every frame until the state is confirmed, with this timeout as the backstop.
The pacing primitive's 700 ms
floor (`OPERATION_PACE_MS`) stays a constant: it is the schema's minimum, and the World also clamps a
hand-written config at it, so a value under the floor cannot outpace the primitive. The console group
(`WVD_CONFIG_GROUP`) renders all three and refuses the value at the point it is written.

## Goals / non-goals

Goals: every battle press lands on a frame the game has finished drawing; the order and the pacing are
stated, tested and tunable; the 02:07 replay no longer presses into the panel's first frames.

Non-goals: playing the revive QTE (`t-mvy6dvsw`); the heal's own four taps (`t-mvy13m0r`); a pixel
stillness gate; changing the shared `Pacer` (option B, rejected — it governs six other call sites and
conflates "may I act" with "what next"); the after-battle drop (`t-mvzjtxzb`).

## Radius

| File | Why |
|---|---|
| `src/policy/battle-sequence.ts` | new: the steps, the clocks, the settle and the opener timeout |
| `src/world.ts` | the fight branch delegates; the cast splits into two commands; `#track` re-arms; the `WvdCommands` seam grows two taps |
| `src/actions/battle.ts` | `tapOpenerSlot` / `tapOpenerConfirm`; `castBattleOpener` stays for scripts |
| `src/main.ts` | wires the two taps |
| `src/config.ts` | the three keys: interface, defaults, console schema |
| `docs/specs/2026-10-24-contracts.md` | §8.5 table; §11 prose ("paced 1.5 s apart") |
| `docs/status.md` | the measured record |
| `tests/battle-sequence.test.ts` | new: order, one-per-tick, pace from the return, settle, opener timeout |
| `tests/world.test.ts` | the 02:07 replay; the battle tests' clocks |
| `tests/battle-opener.test.ts` | the split's two taps |

No `src/contracts.ts` declaration changes: `Observation.speedOn/autoOn` and `BattleMemberReader`
already exist, and config keys live in `config.ts` with their table in contracts §8.5.

## Verification

- `tests/battle-sequence.test.ts`: the five invariants above.
- `tests/world.test.ts`: 02:07 replayed (unreadable first frame → no press; readable → slot; a slow
  frame → nothing sent); the auto fallback still capped; the next battle re-arms.
- `pnpm typecheck`; the full suite before and after (timing change, AGENTS.md §5).
- Live acceptance (one battle, window untouched): the log's presses are `battleStepMs` apart and the
  battle reaches auto without a stall. The live session spends the operator's machine and is asked
  for, not assumed.

## What is left to the builder

The World command names, the exact step-state fields, and the test names. Nothing in the shape above
is open: the operator picked A and made the timings configurable; the two defaults the proposal left
open (turn-card gate; skip the opener when auto is on) are recorded above as calls.

## Amendment 2026-11-07: the owed confirm is dispatched from the mode, not from the frame

Live 2026-11-07 22:00:11, the first acceptance run that started in town: the slot tap was sent, the
detail panel for 拉巴迪奥斯的秘术 (取消 / 確定, MP 161 ▸ 136) came up over the battle, and the screen
read `unknown` for 48 s until the stall clock stopped the run. The confirm was never pressed.

The sequence was not the failure. `next` already answers the panel's frame with
`{kind:'confirm'}` — the 01:05 defect, fixed and tested — and this run proves it was never asked.
The failure sat one layer above: `#execute`'s fight branch was written to own the whole battle
*including* unnamed frames, but that branch is only reached when the **decision** says `fight`, and
`src/policy/route.ts` answers an unnamed screen (`unknown`, or below its 0.5 floor) with
`{kind:'wait'}` — *a screen we did not identify is a wait, never a click*. So no tick ever asked the
sequence, and the cast's second half starved.

The rule that resolves it: **an operation the sequence already owes needs no evidence from the
frame**, so it must not be gated by a decision whose purpose is to keep blind clicks off unknown
screens. Two narrow changes:

- `BattleSequence.pendingConfirm()` — the opener whose panel is up, or null, stated without a frame,
  so a caller that only acts on named screens can still ask. `next` reads the same method.
- `src/world.ts` `#decide`: a route `wait` becomes the battle branch's `fight` when the mode is
  `battle` and the sequence owes that confirm. Every other unnamed frame still waits, and the fight
  branch's own gate still refuses a **named** non-combat screen, so the exception can never become a
  click into an unknown page.

The confirm now logs (*pressed the skill panel's 確定 …*): its silence was indistinguishable from a
missing step in the 22:00 log. Proved by `tests/battle-sequence.test.ts` (the owed fact) and
`tests/world.test.ts` (the unnamed frame presses it; an unnamed frame with nothing owed presses
nothing).
