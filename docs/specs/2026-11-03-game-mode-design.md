# The game's mode: which pipeline owns the screen (2026-11-03)

Operator rule: *"there really needs to be a state machine to store in game states. like in battle or in
dungeon, and so we can trigger different module or pipeline specific for that state."* Then: *"also a
state chest open."*

## Why

The loop perceived **screens** (`ScreenId`) and nothing else, so anything the game does that is not one
of the named screens fell into `unknown` — and an `unknown` frame is a question: a 5 s settle, a 90 s
escalation, then a fallback that may be wrong. A battle is not one screen: the command phase, the
targeting panel, a skill's resolution, a fade and — measured on
`testdata/battle-2026-11-02/revive-qte.jpg` (`unknown` 0.80) — a **revive QTE** after a member dies. A
chest is not one screen either: prompt, card panel, QTE bar, lid, loot banner. Every one of those
unnamed frames used to be the session's problem. They are the *mode's*.

## The modes

| mode | what it owns | the pipeline |
| --- | --- | --- |
| `battle` | command phase, targeting, skill resolution, **revive QTE**, battle fades | opener → auto → revive QTE |
| `chest` | open prompt, opener card panel, **QTE bar**, lid, loot card + banner | claim → panel → ring timing → loot |
| `dungeon` | the 3-D view and the dungeon map | route, orientation |
| `travel` | the world map and Dungeon Select | atlas |
| `town` | the rest town | rest, heal, exit |
| `unknown` | nothing named yet | the only mode where an unnamed frame is the loop's own question |

## The memory and its transitions

`src/policy/mode.ts`:

- `modeOf(observation)` reads the *named* screens into modes; an `unknown` or `loading` frame is no
  evidence either way (null).
- `advanceMode(memory, observation)` **holds** the mode through a null frame, enters a mode on its
  first named frame, and leaves a **modal** mode (`battle`, `chest`) only after
  `MODE_EXIT_FRAMES = 2` consecutive named frames of another mode — a battle's own fade cannot end the
  battle, and a chest's bar may vanish between passes.

`RouteState.mode` carries it (contracts §6); the World dispatches by it and the console status reports
it (`mode battle`).

## What it changes in the loop

- An unnamed frame inside `battle` or `chest` **does not escalate**: the pipeline that owns the mode
  carries on (the battle waits for its next named frame, the chest keeps its bar timing). Only
  `unknown` mode asks about a frame nothing named.
- The stall escalation is untouched: a battle that truly hangs still asks.
- A new session starts with no mode; the first named frame sets it.

## What it does not do yet

- The revive QTE is *held* — its ring timing is `t-mvy6dvsw`'s work, and it can now be built inside the
  battle mode without touching the escalation policy.
- The facts that would make *entering* a mode robust on an unnamed battle frame (the member nameplate +
  HP bar, a real minimap detector — the corner fact is gold ink) are `t-mvzic22j`'s follow-ups.
- The operator's *"if not possible, stop"* for unnamed frames is not landed: with modes the remaining
  unnamed frames are genuinely unknown, so the rule can now be applied — a decision on `t-mvzi5neu`.

## Acceptance

`tests/mode.test.ts` pins the transitions (six modes, hold through unnamed, two frames to leave a
modal mode, first-frame entry). `tests/world.test.ts` pins that a battle and a chest hold through
unnamed frames with no question asked, that an unnamed frame outside any mode is still a question, and
that the console status carries the mode.
