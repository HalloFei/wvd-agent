# The heal workflow — an owned episode, verified by its own material

Status: **design, for approval** (revised 2026-11-09 after the operator's three questions: the result
box may say 不需要恢复, the machine must be a general shape, and legacy never had this defect).
No code changes in this document.

## 1. The observable

A heal is an **episode**: it begins when the party is owed one and the world is settled, it **owns the
interface** until it ends, and it ends when the character page is gone again. Only then is the debt
paid.

The property legacy had and we lost:

> The heal owned the interface for its whole duration, verified every action against **its own
> template**, waited for that template with a bounded retry, and was interrupted only by a
> battle/chest event — never by "the frame has no name".

## 2. What the live runs showed (this design's evidence)

Run 6, 05:22–05:29 (`.tmp/runs/2026-11-09-3-cycles-6/console.log`):

- the loot was claimed, but the game still drew `道具详情` and a HUD-less camera the reader names
  `chest-opening`, alternating with `dungeon` for ~20 s;
- the heal started on the first `dungeon` frame of that aftermath, opened the page, and was
  **abandoned** by the next `chest-opening` frame (real or false), orphaning the page;
- the loop's page-close branch then tapped into the animation, the page stayed, the debt re-armed,
  and the session restarted into the same window: four sessions, one give-up with 恢复 owed;
- the 恢复 dialog was never perceived at all — "sent" was mistaken for "landed".

## 3. The material (facts) — and how each is collected

| # | Fact | Collector | How | What prevents it |
|---|---|---|---|---|
| **F0** | **Settled farm view**: HUD `dungeon`, mode `dungeon`, stable >= 2, no loot/item-detail/chest/XP page pending | World + the loot flow's completion | the screen set, the mode memory, and a named `settled` predicate | the loot aftermath's item-detail page and HUD-less camera (no such fact today) |
| **F1** | A heal is owed | `policy/heal-schedule.ts` | completed battle/chest, entry, rest | armed while the loot flow still runs (today) |
| **F2** | The character page, **and its X 关闭 point** | `perception/character-page.ts` | X-tile template match; the **matched point** is the close target | matches late under the XP overlay; the fixed (699,1012) ignores it |
| **F3** | The **sparkle** (一键恢复) located | *missing* | template for the page's rightmost round button | the tap is a fixed (1220,574) |
| **F4** | The **一键恢复 dialog** up | *missing* (`quick-heal` unperceived) | a reader over the dialog's title / 恢复 / 关闭 | nothing verifies the sparkle press today |
| **F5** | **恢复 was processed** — *no text is read* | F4's reader + the World's `message` branch | the dialog is **no longer the thing on top**: either the page is back (dialog gone) or a **result box** appeared — and | 已恢复。 | 不需要恢复 | are the **same shape** and are simply advanced (one tap / one message step). Full HP is not an error: it is the game's answer. | a box that is neither (a new page) — then the result is "unverified", not "restored" |
| **F6** | The page is gone | F2's reader | no X-tile match, stable >= 2 | the close is swallowed under an animation |
| **F7** | The game owns the frame (suspend) | combat/chest/death readers | existing | a **false** `chest-opening` on the loot camera |

## 4. The state machine, collapsed

Retries are not states. The machine is **four steps + a shell**:

```
SHELL: IDLE ──(F1)──▶ OWED ──(F0)──▶ ACTIVE ──(F6)──▶ DONE   (debt paid)
OWED ──(not F0)──▶ wait (debt keeps, no press)
ACTIVE: the four steps, cursor only
  1 CARD     needs F0        send card        advance on F2       retry: 2 (F0 again, no page)
  2 SPARKLE  needs F2        send sparkle     advance on F4       retry: 2 (F2 stable, no dialog)
  3 RESTORE  needs F4        send 恢复        advance on F5       no retry: the result decides
  4 CLOSE    needs F2/F5     send close (or Esc)   advance on F6  retry: 1 Esc, then fail
SUSPENDED: F7 took the frame (battle/QTE/death) — the cursor is kept; resume on F0.
FAILED: a step's budget or the episode's hard bound is spent — the debt policy decides (re-arm once).
```

Timers only bound budgets and the whole episode; they never advance a step and never mean "the page
is gone". The close uses **Esc** as its primary key (legacy's `PressReturn`), verified by F6; the X
tile is the fallback, both at F2's matched point.

## 5. Is it too complex, and is it abstractable?

Two families already exist in the repo:

| Family | Shape | Modules | Needs |
|---|---|---|---|
| **Cursor episode** | a step cursor, one command per step, verified by a fact, suspend on foreign screens, budgets | battle sequence, task scripts, **heal** | the same shell |
| **Pure reducer** | one frame in, one decision out, no memory | route, leave, mode, recovery, QTE planner | nothing shared with the above |

So the heal machine is **not special**: it is the second real consumer of the cursor-episode family.
The abstraction to introduce is small and belongs in `policy/episode.ts`:

```ts
interface EpisodeStep<F> {
  readonly name: string;
  /** The fact that must hold before the step's command may be sent. */
  readonly needs: (facts: F) => boolean;
  /** One command. The caller sends it and reports the actuator's answer. */
  readonly send: () => Promise<ActionResult>;
  /** The fact that proves the step landed; until it holds, the step is owed. */
  readonly advanceOn: (facts: F) => boolean | 'unverified';
  readonly retries?: number;
}

type EpisodeDecision<F> =
  | { kind: 'wait' } | { kind: 'send'; step: string }
  | { kind: 'suspend' } | { kind: 'done' } | { kind: 'failed'; step: string; why: string };

class Episode<F> { next(facts: F, now: number): EpisodeDecision<F>; }
```

The heal implements the four steps above; the battle's sequence becomes the second implementation
(its steps already are "send speed, send opener, send auto" verified by toggle facts). The shell
(owner, suspend, budgets, single-owner rule) is the shared part. **Do not force the reducers into it**
— route/leave/mode are already clean and are the reason the loop stays one-decision-per-frame.

What is dropped from the first draft: the 8 states (retry states were noise), and the global screen
name as a gate — the steps' facts are **local templates**, not "the composite said character-page".

## 6. What legacy did that we lost (the better method)

Legacy never had this defect because of four structural properties, all of which we can have inside
the per-tick model:

1. **Ownership.** Its heal was a blocking procedure: while it ran, nothing else pressed. Our loop
   interleaves a per-tick dispatcher with every other branch, so the page-close branch and the heal
   fight over the same frame. *Fix: the episode owns the interface; the loop yields to it and only
   the game's modal screens suspend it.*
2. **Local verification.** It acted only after `CheckIf("trait")` (the page's own element) and
   `CheckIf("recover")` (the dialog), and found the controls by template with a fallback point. It
   never asked a global classifier "what screen is this?". *Fix: F2/F3/F4 are local templates; the
   global screen only decides suspend/done.*
3. **Wait for the element, retry the card.** `FindCoordsOrElseExecuteFallbackAndWait(["recover",
   "combatActive"], …)` waits for the template, and the card is retried up to 30 times across three
   columns. It aborts only on `combatActive` / `chestFlag` / `combatClose`. *Fix: a bounded
   wait-and-retry per step, and suspend only on the game's own events.*
4. **Leave with a key.** After 恢复 it pressed return five times; the page always leaves with Esc,
   while a click on a fixed X can be swallowed by an animation. *Fix: Esc as the primary close,
   verified by F6.*

The better method in one sentence: **an exclusive episode whose every step is gated and verified by
its own local template, waiting for that template with a bounded retry, suspended only by the game's
modal events** — legacy's ownership and local verification, without legacy's blocking.

## 7. Build order (each slice testable on its own)

1. **`quick-heal` reader** (F4) — a captured dialog fixture, the reader, the two buttons; the result
   box (`message`) is the same shape whether it says 已恢复 or 不需要恢复.
2. **Sparkle located** (F3) — a crop from the page fixture; the tap at the match.
3. **Close at F2's matched point**, with Esc first (the X tile as fallback).
4. **F0 `settled` predicate** shared with the loot flow; the heal's trigger moves onto it.
5. **`policy/episode.ts` + the heal's four-step episode**; the battle sequence refactored to it as
   the second consumer (or a later slice if the battle's facts need work first).
6. **`chest-opening` false-positive fix**, with run 6's frames as the negative fixture.
7. **Acceptance**: one battle-heal and one chest-heal captured frame-per-state; then the 3-cycle run.

## 8. Open questions (defaults proposed)

- Result of 恢复: **no text is read**; a result box is advanced once, then the page closes. (Operator's
  simplification, accepted: "once a dialog pops out after clicking 恢复".)
- Full HP (不需要恢复): success — the game answered; the episode closes the page as usual.
- Close key: Esc first, X tile as fallback (legacy's PressReturn).
- Card/sparkle retries: 2 each; episode hard bound 60 s of wall clock; suspend does not count.
