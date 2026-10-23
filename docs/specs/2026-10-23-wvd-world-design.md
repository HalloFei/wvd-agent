# WVD World — design

Status: approved 2026-10-24; the stop control changed in §7.2a
Owner: the repository root
Consumes: Coopanion's extension API (`cortico-world-*`), wvd's state machine and game data as study material

## 1. Intent

Coo plays one route of the Steam build of Wizardry Variants Daphne unattended: enter the dungeon,
walk its chest waypoints, fight what blocks it, open the chests, return, rest, repeat.

The point is not a faster script. wvd already clears this content faster than a model can think.
The point is an agent that recovers when the screen stops matching a template — a changed dialog,
a different enemy pack, a stuck teleport — and that can be told what to farm in words.

## 2. Decisions already made

| Decision | Choice | Why |
| --- | --- | --- |
| Parallel use | **A. The farmer owns the machine** | A background click cannot reach this game: `PostMessage` is ignored, only a focused `SendInput` click opens a menu. Measured 2026-10-23. |
| Decision layer | **2. Local policy, model on escalation** | A cloud round trip is 1–3 s; a chest QTE needs a tap inside ~200 ms. Routine decisions stay local, judgment goes to the model. |
| First milestone | **One route end to end**, FFXI 4F (北穿幽灵城) | Proves the loop, the contracts, and the recovery path before generalizing. Confirmed reachable on this account. |
| Death | **Stop and report.** No revive in v1 | The operator decides whether to spend 再起之火. A wipe ends the session; the World pushes the frame and the last intents. |
| Movement | Map search then automove | Matches wvd: open the map, pan/zoom, match the floor or chest icon, tap it, tap automove, detect arrival. Chests are found per run. |
| Chest miss | **Costly** — record real opens before tapping | A mistimed tap risks the chest or a trap, so the model is learned from full-screen recordings of actual chest opens, never from trial taps. |

## 3. Constraints, measured on this machine

- Game window: `WizardryVariantsDaphne`, 1920×1080, Unity, titled exactly that; Steam install at
  `C:\Program Files (x86)\Steam\steamapps\common\Wizardry Variants Daphne`.
- Capture: `PrintWindow(hwnd, hdc, 2)` returns a full frame with the window occluded. A display
  `BitBlt` returns whatever is on top instead, so it is unusable while Coo's own UI overlaps.
  Measured 2026-10-23: **41.7 ms** median for one 1920×1080 frame including `GetDIBits`, over five
  consecutive captures. That is the floor of every tick and a large part of the QTE budget.
- Input: clicks only work on the focused window; the click itself activates it. Focus must be
  taken with the `AttachThreadInput` + `SetForegroundWindow` sequence.
- A press must be held for at least one rendered frame. Down and up in the same instant is
  dropped by a 30 fps game: every such click in the latency probe did nothing.
- Measured click-to-visible-change: 48.7, 49.2 and 67.2 ms over three trials where the window
  was verifiably foreground. A trial is only valid while the game holds focus; any interaction
  with another window invalidates it, which is decision A stated as a measurement hazard.
- Steam's own Game Recording is configured on this machine (BackgroundRecordMode 2, Ctrl+R,
  1080p60 into Videos) and writes fragmented MP4 under Steam\userdata\<id>\gamerecordings.
  It is not the recorder: clips are hotkey-made, there is no API, and a frame cannot be tied to the
  input that caused it.
- The game renders at 30 fps (its own overlay reports it), so a 41.7 ms capture loop samples
  within one rendered frame.
- The pet window hides itself whenever a fullscreen window covers its display
  (`FULLSCREEN_EVERY_MS`, 200 ms), so the overlay stays out of the way in play.
- wvd's template library is portrait 900×1600 mobile UI. The Steam build is 1920×1080 landscape.
  Templates must be recaptured; only the state machine, quest data and game knowledge transfer.
- Coopanion's model turn is capped at 20 rounds soft / 40 hard per delivered message, and every
  image in the current turn is re-sent on every request. The farm loop cannot live inside a turn.

## 4. Goals

1. Complete the v1 route without human input, from a known starting screen back to it.
2. Recover from an unrecognized screen by asking the model, then resume the route.
3. Every module replaceable without touching its neighbours: capture, perception, policy, tactics,
   actuation are separate contracts.
4. Reaction time bounded and measured, not assumed.

## 5. Non-goals

- Driving the mobile/emulator rig, or any ADB path.
- Parallel use while the operator works (needs a second session; rejected for v1).
- General game support: one title, one route.
- Replacing wvd's combat math wholesale in v1.

## 6. Anti-goals

- Acting on a hardcoded coordinate without a perception check — the route must fail visibly rather
  than click blindly.
- Hiding the input focus steal from the operator: taking the foreground is announced in the UI.
- Unbounded model calls. Every escalation is counted and capped per hour.

## 7. Architecture

Five modules, one way each. The arrows are contracts; a module may be swapped for another
implementation without the others noticing.

```
        ┌──────────────┐   Frame    ┌─────────────┐  Observation  ┌──────────────┐
        │ FrameSource  │───────────▶│  Perceiver  │──────────────▶│  WorldState  │
        │  (capture)   │            │ (template/  │               │   (derive)   │
        └──────────────┘            │   VLM)      │               └──────┬───────┘
                                       ▲                                 │
                                       │ Frame (on escalation)           ▼
                                ┌──────┴───────┐                   ┌─────────────┐
                                │  Supervisor  │◀── stuck/slow ────│ FarmPolicy  │
                                │   (model)    │                   └──────┬──────┘
                                └──────────────┘                          │ Intent
                                                                          ▼
        ┌──────────────┐   Action   ┌─────────────┐   ┌──────────────┐ ┌──────────────┐
        │   Actuator   │◀───────────│ BattlePlanner│◀──│  QteController│ │   (all)      │
        │  (win32)     │            │  (threats)  │   │  (timing)    │ └──────────────┘
        └──────────────┘            └─────────────┘   └──────────────┘
```

### 7.1 Contracts

Every boundary is declared in [2026-10-24-contracts.md](2026-10-24-contracts.md) and mirrored in
`src/contracts.ts`. That file is binding: a module may rely only on what it
declares, and the two change in the same commit. The modules are `FrameSource` (capture),
`Perceiver` (screen recognition), `FarmPolicy` (route decisions), `Actuator` (input), and the child
engine protocol between them.

### 7.2 Loop

One tick every 100 ms while a session runs: capture → observe → policy → act. Perception is cheap
(one template pass over a downscaled frame, target ≤ 20 ms). The model is never in this loop.

Escalation path: when `FarmPolicy` returns `escalate`, the World pauses the loop, pushes a
`wvd.stuck` event carrying the frame and a one-line question, and Coo wakes. Coo answers through
tools (`wvd_look`, `wvd_act`, `wvd_resume`); the World applies the action and continues. If no
answer arrives within `escalateTimeoutMs`, the policy falls back to its own recovery (leave
dungeon, restart route).

### 7.2a Stopping a session

The pet hides under a fullscreen game, so the stop control cannot be a bubble. A World also cannot
add a tray item or a global shortcut: the tray belongs to the app (`app/main.cjs`), and `WorldHost`
exposes events, tools and console panels but no shortcut registration.

So the stop control is ours: the engine child registers a global hotkey natively
(`RegisterHotKey`) and reports it to the World, which stops the loop and says so through Coo. A
console panel shows the session state for anyone who opens the console, but it is not the emergency
stop — the hotkey is, precisely because it works with the game focused and the console closed.

### 7.3 Where the code lives

This repository's root is the npm package: it declares `cortico-world`, and is linked into
Coopanion's extensions directory with `pnpm add <path>`. It is not vendored into
`Coopanion/packages`; Coopanion stays an unmodified checkout.

Native calls run in a child process, as desktop-pet's engine does, so a Win32 fault cannot take
the bot down. Frames are encoded in that child before they cross the boundary: JPEG for the
loop, and for the recorder JPEGs into a memory ring buffer. A successful parse writes nothing to
disk: the fit is reduced to numbers and kept. The frames are dumped only for the first three
chests, and after that only when the marker or the zone cannot be parsed — a wrong parse that
nobody can look at costs chests, which is the one thing we cannot spend. Raw BGRA never crosses IPC — 8 MB a frame at 24 Hz would be 192 MB/s. The pet's
overlay stream is the precedent for the other direction: deflate level 1 in the producer and a
4 MB cap on what may queue, dropping frames when the consumer falls behind.

## 8. v1 scope — the smallest verifiable product

Ships:

1. `PrintWindowSource` capturing the game window at 1920×1080.
2. `TemplatePerceiver` recognising seven screens: town, world map, dungeon map, combat, chest
   dialog, rise-again, loading/transition. Templates recaptured at 1080p.
3. `RoutePolicy` running FFXI 4F: enter from the event map, open the dungeon map, search the floor
   icon, tap it, automove, repeat per floor, open each chest found, then the harken and the rest.
   Waypoints are searched on the map, not recorded as coordinates.
   Opening a chest is its own sequence: choose the opener with the highest 陷阱解除, then the bar.
4. `AutoBattlePlanner`: enables the in-game auto-battle toggle and does nothing else. A death stops
   the session and reports; it never spends a revival.
5. `PredictiveQte`: locates the bar and its zones in the frame, estimates the marker's speed
   from consecutive frames, and taps with the pipeline's measured lead. Nothing about the bar
   is configured (see §9).
6. `SendInputActuator`: focus, tap, swipe, key.
7. `CooSupervisor`: the stuck event and its tools.
8. A dry-run mode: the actuator logs instead of clicking, so the route can be validated without
   touching the game.

Does not ship: threat ranking, adaptive QTE, multi-route scheduling, party management, inventory.

## 9. Chest QTE

Detailed in [2026-10-24-chest-policy-design.md](2026-10-24-chest-policy-design.md). In short: the
marker's speed is fixed per chest and random across them, the zones are random and set by 陷阱解除,
the marker brakes after the tap, and the lead is `v · L + v² / (2a)`. Two frames fix `v`, then one
scheduled press. Fast chests are tapped before the marker reaches the zone, and a floor chest whose
lead is too wide is rerolled by leaving and re-entering the QTE.

## 10. Battle

v1 delegates combat to the game's auto-battle: enable the toggle, verify the fight ends, verify the
party survived, continue. Every enemy that touches the party is fought — automove does not avoid
them — so the route's viability is "can the party win what it meets".

Auto-battle's action picks are known to be poor. That is accepted for v1 and is the reason a
calibrated battle module is planned as the first post-v1 addition, not as part of this milestone.
The `BattlePlanner` contract stays in the tree so the module can be added without touching the
loop: recognised enemies with a threat score, and a kill order produced by policy rather than by
the game.

## 11. Testing

- Perception: a fixture set of recorded frames per screen, asserted by `screen` and confidence;
  captured with the dry run, stored under `testdata/frames/`.
- Contracts: each module tested against its interface with fakes for its neighbours.
- Route: dry run asserts the intent sequence for a recorded session.
- Live: one supervised run, the operator present. No unattended run until the route completes
  twice with the dry run and once live.

## 12. Risks

- **Game updates** move UI. Templates and zones are data, so the fix is recapture, not code.
- **Focus stealing** makes the machine unusable while farming. Accepted under decision A; the
  World announces the session and stops on the operator's input.
- **Input errors** can waste in-game resources. The policy never spends currency or items in v1.
- **Account risk.** Automation of a live service game can violate its terms. This is the
  operator's decision, not a design mitigation.
- **Model cost** is bounded by an hourly cap on escalations, and each escalation sends one frame.

## 13. Resolved by the operator

1. FFXI 4F is reachable on this account now; the route stands as the v1 target.
2. Movement uses the dungeon map and the game's automove; chests are found per run.
3. A death ends the session and reports. No revival, no automatic retry.
4. A mistimed chest tap is expensive, so the timing model is learned from full-screen recordings of
   real chest opens, and a frame it cannot parse is reported instead of tapped.
5. Dry run means replaying recorded frames through the real loop, not a log-only actuator.
