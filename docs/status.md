# Status — WVD World v1

Where the plan stands. The plan file is the specification of the work, not the record of it: this file
is the record, updated at each milestone, and `docs/plans/2026-10-24-wvd-world-v1.md` stays the
authority on *what* each task requires.

Last updated 2026-10-24 05:00, at commit `bc5b605` on `feat/world-v1`.

## Task table

| # | Task | State | Commit(s) | What is left |
| --- | --- | --- | --- | --- |
| 1 | Extension skeleton that loads | **done**, reviewed clean | `55541d0`, `15bdeb1` | — |
| 2 | Engine child — capture, foreground guard | **done**, reviewed clean, validated against the live game | `fcc51d2`, `3649cdd`, `87b69e5`, `68a4886`, `5571ea9` | — |
| 3 | Frame ring buffer | **done**, approved | `7bff768` | — |
| 4 | Map perception | **implemented**, review under way | `6627242` | reviewer verdict; five disclosed concerns are its own (7 of 10 digit glyphs, one-sample stairs and title) |
| 5 | Automove command chain | **blocked** | — | a recorded successful automove gesture: the live build contradicts navigation §3a (see §3c) |
| 6 | Chest opener and QTE parser | **not started** | — | implement from `research-qte-parser.md` (199/250 frames parsed, constants corrected in `5be0054`) |
| 7 | Route policy | **implemented**, fix round under way | `41f2c56` | missing `FarmPolicy` binding, no confidence gate, stop threshold below the usable opener floor |
| 8 | Session lifecycle and escalation | **not started** | — | — |
| 9 | Replay harness | **not started** | — | — |
| 10 | The loop and the composition root | **not started** | — | brief enriched with `research-escalation-design.md`; also owes the `capture { maxWidth }` engine half |

## What exists and runs

- The package mounts in Coopanion (verified through the host's own loader, `worldId: wvd`, api 6).
- The engine child captures the real game at 1920×1080 — 2.5 ms round trip, 30 fps cadence, 23 ms
  native decode, 20 ms native encode — while the window is **occluded**, which is the whole point.
- Input is foreground-guarded, gestures always release, and a dead stop hotkey is visible.
- The map reader returns `B1F`, `X:20 Y:14`, three chests and a hazard from the recorded frame, and
  `null` from a HUD frame.
- The route state machine picks the next intent from an observation, purely.

## What does not exist yet

No loop, no chest opener, no QTE timing, no session verdicts, no escalation to Coo. The agent cannot
play the game end to end: it can see, and it can decide, but nothing turns a decision into a walk yet,
because Task 5's activation gesture is unknown.

## Open decisions and blockers

- **The automove gesture (blocks Task 5).** A tile click only opens 自动移动 after `R` (pointer mode),
  the element appears top-left rather than beside the tile, and it did not activate by single click,
  engine double-click, fast native double-click, or Enter. One recorded success settles it.
- **Zero willpower versus the 60 floor.** The route stops only at 0, while no member below 60 can open
  a chest. Between them the route keeps asking and the chest module keeps refusing; Task 10 must bound
  the retries and Task 8 must classify the stall.
- **The blob-to-Coo turn is still unobserved.** Only `deepseek-flash` sees images, and only when the
  endpoint is multimodal. Task 10 proves it or the escalation path stays theoretical.
- **`qteDecelPxPerS2` is provisional** at 3000; the recorded stop implies 2740–3100. It firms up from
  taps the agent times itself.

## The standing instruction

The operator's goal for this session, recorded verbatim on 2026-10-24:

> after finishing all tasks and implementation, shutdown the pc. if there's hard blocker that need my
> decision, then pause, save the status and also shutdown the pc.

Read as: finish the remaining tasks (11, 6, 8, 9, 10, and 5 if it unblocks), then power the machine
down; if something can only be settled by the operator, stop there, leave this file accurate, and power
down anyway rather than idling.

**What counts as a hard blocker right now:** Task 5's automove gesture — the live build falsified §3a
and the activation is unknown, so it needs one recorded success or explicit authorisation to drive.
That blocks *completion*, not progress: everything else on the list can be built without the game.

## How the work is tracked

- `docs/status.md` (this file) — the committed record.
- The SDD ledger, `wvd-agent/.worktrees/world-v1/.superpowers/sdd/2026-10-24-wvd-world-v1/progress.md`
  — working state, rulings, deferred minors, and the preflight scan. Git-ignored: it is scratch, and
  the rulings that matter are written into the specs instead.
- The task board — the user-visible list of what is open.
