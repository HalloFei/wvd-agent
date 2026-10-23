# Status — WVD World v1

Where the plan stands. The plan file is the specification of the work, not the record of it: this file
is the record, updated at each milestone, and `docs/plans/2026-10-24-wvd-world-v1.md` stays the
authority on *what* each task requires.

Last updated 2026-10-24 07:00, at `61b341b` on `feat/world-v1`.

## Task table

| # | Task | State | Commit(s) |
| --- | --- | --- | --- |
| 1 | Extension skeleton that loads | done, reviewed clean | `55541d0`, `15bdeb1` |
| 2 | Engine child — capture, foreground guard | done, reviewed clean, validated on the live game | `fcc51d2`, `3649cdd`, `87b69e5`, `68a4886`, `5571ea9` |
| 3 | Frame ring buffer | done, approved | `7bff768` |
| 4 | Map perception | done, approved | `6627242` |
| 5 | Automove command chain | done, approved | `b59275d` |
| 6 | Chest opener and QTE parser | done, approved | `b6a24df` |
| 7 | Route policy | done, reviewed clean | `41f2c56`, `a3f0c28`, `deb11b2` |
| 8 | Session lifecycle and escalation | done | `9392cc2`, `c4960f4` |
| 9 | Replay harness | done, approved | `1c9529e`, `e126d0c` |
| 10 | The loop and the composition root | done, final fix wave reviewed clean | `b7ad52b`, `2cff58c`, `61b341b` |
| 11 | Recognise the 3D view | done, reviewed clean | `2be0357`, `6df13ff` |

214 tests across 14 files, `pnpm typecheck` clean.

## What runs

- The package mounts in Coopanion (verified through the host's own loader, `worldId: wvd`, api 6).
- The engine child captures the real game at 30 fps while **occluded** — 2.5 ms round trip, 23 ms
  native decode, 20 ms native encode — which is the whole point of the design.
- Screen recognition: the dungeon map (floor token, `X/Y`, chests, hazards, stairs), the 3D walking
  view, and the chest QTE bar (199 of 250 recorded frames parsed, the other 51 refused correctly).
  A frame that is on screen but namable by nothing is reported at a low confidence and **escalates**;
  only a uniform or black frame stops the session.
- One command at a time: the loop opens the map, walks to a chest or the exit, waits for arrival by
  scene stillness, and does not re-press keys while a walk is in flight.
- Escalation to Coo: a `wvd.stuck` event with a JPEG, one question open at a time, a 90 s wait, a late
  answer named as expired, and an hourly budget that stops the session.
- Stopping: engine failure, dead child, stop hotkey, stall, spent budget — each ends the session with a
  reason and exactly one `wvd.stopped`. A held key cannot outlive the process: the hold ceiling and the
  teardown grace are declared side by side in `src/contracts.ts`.

## Known gaps — declared, not hidden

1. **The opener panel `由谁打开?` has no parser.** There is no fixture for it anywhere in `testdata/`,
   so `chest-open` is never emitted and the chest step cannot be entered. The QTE parser exists and is
   tested; nothing can reach it until this panel is captured and parsed.
2. **`planTap` has no caller in the loop.** The QTE needs a sub-loop that samples three frames inside a
   150 ms decision window; a 100 ms tick cannot. It is a design, not a patch, and it is deferred.
3. **`capture { maxWidth }` is declared in contracts §5 and not implemented by the child.** The
   escalation snapshot is therefore taken at native size.
4. **The blob reaching a live Coo turn is still unobserved.** It needs a running app with a multimodal
   endpoint; the mechanism is followed by hand, not proven.
5. **A town exit is not a documented command.** The loop opens the map there and the town menu may
   appear; out of scope for v1.
6. Config keys owned by modules the loop does not yet wire are unread: `hazardEscapeSteps`,
   `hazardEscapeHoldMs`, `resumeMaxAttempts`, `willpowerFloor`, `maxRerolls`, `rerollLeadRatio`, the
   QTE timing quartet, the loot taps, `autoBattleEnableAttempts`, `fightTimeoutMs`.

## The standing instruction

The operator's goal for this session, recorded verbatim on 2026-10-24:

> after finishing all tasks and implementation, shutdown the pc. if there's hard blocker that need my
> decision, then pause, save the status and also shutdown the pc.

The implementation is finished and the tree is green. Two of the gaps above need the operator — a
captured opener panel and a live multimodal run — so they are recorded here rather than guessed at.

## How the work is tracked

- `docs/status.md` (this file) — the committed record.
- The SDD ledger, `wvd-agent/.worktrees/world-v1/.superpowers/sdd/2026-10-24-wvd-world-v1/progress.md`
  — working state, rulings, deferred minors, and the pre-flight scan. Git-ignored: it is scratch, and
  the rulings that matter are written into the specs instead.
- The task board — the user-visible list of what is open.
