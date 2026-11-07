# The page lifecycle: one machine for "which page, what did we open, is it gone yet"

Status: proposed 2026-11-07 (operator's question after the heal-after-chest stalls). Not implemented.

## Why

The loop has four partial machines and a pile of per-screen counters, and the gap between them is where
tonight's stalls lived:

- `policy/mode.ts` — the coarse mode (dungeon / battle / chest / travel), with hysteresis. It answers
  "are we just out of a battle", not "is this page still up".
- `policy/pacing.ts` (`STABLE_FRAMES = 2`, `OPERATION_PACE_MS = 700`) — frame stability, but it gates
  **presses**, not the decision to move on.
- `#advanceInFlight` — a command still settling; its `waiting` flag returns the tick early.
- `policy/battle-sequence.ts` — a real state machine, for a battle only.
- the World's counters: `#pageCloseTries`, `#lootTaps`, `#qteTries`, `#healDue`, `#innRested`,
  `#staging`, `#orienting`, `#restGate` — each knows one screen and nothing of the others.

The observed failure class (runs 15, 17, 18): the heal opens the character page, the close is pressed
into the page's arrival animation, the next frames read `unknown` while it animates, and the loop has no
notion of "I just closed a page — hold the next step until the frame is stable and not the page". So the
close budget reset on the flicker, the `Esc` cap was never reached, and the run ended on an unnamed
frame (48 s, 45 s, 176 s across three runs).

## The machine

`src/policy/page-lifecycle.ts`, pure, frame in / decision out:

```ts
type PageState = 'none' | 'entering' | 'open' | 'closing' | 'left';

interface PageMemory {
  readonly state: PageState;
  readonly page: ScreenId | null;   // which page we opened (or found open)
  readonly sinceMs: number;         // when the state began
  readonly closes: number;          // presses spent in this episode
  readonly stable: number;          // consecutive frames the screen named the same page
}

nextPageState(memory, observation, nowMs): { memory, command }
  command: 'press-close' | 'press-esc' | 'nothing'
```

Rules (each one a test):

1. `none → entering` on the first frame that names a page; `entering → open` after `STABLE_FRAMES`
   frames of the same page (the pacer's own rule, reused, not reinvented).
2. A frame that names **another screen** ends the episode: `→ left`, then `→ none` on the next frame.
   `unknown`/`loading` are the same episode `while state ≠ open` **and** for `GRACE_MS` after a close
   press was sent (the animation window), which is the measured fix for tonight's reset bug.
3. `open` and no close sent in this state → `press-close`, bounded by `CLOSE_TRIES` (3).
4. `closing` for more than `GRACE_MS` (2 s, measured) without the page leaving → `press-esc`, once.
5. Nothing is dispatched to the next step (map, walk, chest) from `entering`/`open`/`closing`; only
   `left`/`none` allow the route to act. That is the "wait for a stable frame after the close" the
   operator asked for, stated once instead of in every consumer.

## Radius

`src/policy/page-lifecycle.ts` (new), `tests/page-lifecycle.test.ts` (new), `src/world.ts` (the
character-page block and `#track`'s page counter retire into it), `src/contracts.ts` §6 only if the
World exposes the state on its status line. Mode, pacer, in-flight and the battle sequence are
untouched: the machine consumes their facts, it does not replace them.

## Acceptance

- Unit: every rule above, with a frame script (page → unknown×n → page → dungeon) and no pacer, no
  in-flight gate, no escalation — the three things that made seven attempts at this line untestable.
- Live: a three-cycle run where a heal's page is closed and the loop continues to the map within
  `GRACE_MS`, with `page: closed after 1 press` in the log, and no escalation.

## Why not a hierarchy of states, or a per-state action vector

(The operator's question, 2026-11-08: *dungeon is the outer, highest level; inside it you can open pages,
fight, open a chest, heal — plus a normal state with no page open. But I don't really see the benefit of
levels of states, or a vector of which actions are available in each.*)

Agreed, and tonight's failures are the evidence — each was **one-dimensional**:

- a page was named as the scene: the status page read `dungeon` 0.80, so the route pressed `open-map` from
  a page frame and the loop alternated page → dungeon → page for 20 s at a time (run 22; the same on
  `12977d2`, so it is not a regression — it needs a level-up page, which needs a fight);
- a counter was reset by a one-frame misread (runs 17/18);
- two owners pressed in the same tick (the heal and the route, run 21).

None of them needed a lattice. They needed **one owner, a stable frame, and a rule-out between pages**.

A state × action matrix would duplicate what the commands already check (two sources of truth), and each
cell is another test to keep in sync. Three facts do the work:

1. **scene** — dungeon / town / worldmap / battle / chest (the existing `mode`, with hysteresis);
2. **overlay** — which page is on top or none, with its lifecycle; outer and inner are two *fields*, not
   two levels: closing a page means the same whatever is underneath, and a scene's commands are suspended
   while an overlay owns the tick;
3. **owner** — the sequence, chest step or page that owns the tick, or none. Exactly one.

Each command then declares its preconditions as data, and a test reads them: `open-map` requires
`overlay === none && stable === 2`; `close-page` requires `overlay === that page`; `press-confirm`
requires the owed panel and nothing else. Recognition carries the mutual exclusion — a frame that shows
the page's tile is not the scene — which is the one new table worth writing, tested as: for every page, a
frame of every other page must not name it.
