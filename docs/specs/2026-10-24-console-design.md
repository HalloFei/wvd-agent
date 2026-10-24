# WVD console — design

Status: draft for review
Owner: the repository root, `src/webui/`

## 1. Why

The agent runs unattended. Today the operator can change its settings in Coopanion's console and can
stop it with `Ctrl+Alt+W`, but cannot **see** it: no session state, no position, no escalation count,
no last stop reason. The design already asked for an informational console panel (§7.2a); this is that
panel, and the place where start/stop live so the operator is not editing `enabled` in a config field
to begin.

Two jobs, in this order:

1. **Watch it work** — answer "what is it doing, where, and is anything wrong" in one glance.
2. **Steer it** — start a session, stop one, cancel a question, without hunting for a hotkey.

## 2. Non-goals

- **It is not the emergency stop.** The global hotkey stays the last resort and must keep working when
  the app is closed, the page is not open, or the renderer has crashed. A stop control that depends on
  a web page is not an emergency stop.
- **It does not make gameplay decisions.** No "move to this tile", no "open this chest". The policy
  decides; the operator watches and can stop. A UI that can steer the party is a second driver, and two
  drivers is how a run gets blamed on the wrong one.
- **It is not a key injector.** No free-text "send keys" box. Every action is a named method with a
  typed payload.
- **It carries no secrets.** No API keys, no provider config — those belong to Coopanion.

## 3. States

The World already has a session lifecycle; the panel renders exactly one state at a time, and derives
the state from the World, never from its own guess:

| State | Meaning | What the panel shows |
| --- | --- | --- |
| `offline` | not enabled, or no engine | why, and what to fix |
| `idle` | enabled, no session | the last stop reason, if any, and Start |
| `running` | a tick loop is live | screen, floor + `X/Y`, chests left, last intent, tick health |
| `escalating` | a question is open with Coo | the question, when it was asked, and the time left |
| `stopped` | ended with a reason | the reason, the last frame, and Start again |
| `error` | the engine or a module failed | the failure, and that the session ends rather than retries |

`escalating` is a sub-state of `running`: the loop is paused, not stopped, and Stop must work from it.

## 4. What it can do

| Method | Effect | Guardrails |
| --- | --- | --- |
| `start` | start a session | refused when `running`; refused when there is no game window, with the reason; never spawns the game |
| `stop` | end the session | always allowed, including during `escalating` (the open question is cancelled first); idempotent |
| `cancel-escalation` | close the open question and resume the fallback | only in `escalating` |
| `status` | the state snapshot | read-only, safe to poll, also the first `stream` frame |
| `log` | the recent event log | bounded, e.g. the last 50 entries |

Every method returns `{ ok: true, value }` or `{ ok: false, error, detail? }`; the panel renders the
failure rather than a toast that disappears.

## 5. Mechanism — verified against the host

- A World declares its UI in `webUi(language)` (`WorldWebUiDecl`): `lamps`, `badges`, `panels`,
  `invoke(panel, method, args)`, `stream(panel, socket)`, plus the `config` group it already declares.
- A panel is `{ id, title, description?, getMethods? }`; the page's buttons call `invoke`.
- Panel **content** is ours: the package ships a client bundle, declared as
  `package.json → "cortico": { "webUiClient": "dist/webui.js", "webUiStyle": "dist/webui.css" }`, built
  from `src/webui/client.ts` + `src/webui/style.css` by a small esbuild script — the pattern
  `cortico-world-desktop-pet` uses (`scripts/build-webui.mjs`, `src/webui/client.ts`).
- `stream` is a `WorldStreamSocket` per connection; the World must broadcast to every open connection
  itself.

Consequence: this adds a **build step** to a repository that has none. That is the main cost, and it is
why the panel is a task of its own rather than a patch.

## 6. What the panel shows, concretely

- **Header:** lamp (`online` / `loading` / `error` / `offline`) and the session state word.
- **Live strip** (from `stream`, once per tick or coalesced to ~2 Hz): screen, floor token and `X/Y`,
  chests left, intent, escalation count `used/cap`, frame age.
- **Question card** while `escalating`: the question text, its age, the time left, and Cancel.
- **Controls:** Start, Stop. Stop is always enabled; Start is disabled while running with the reason
  shown.
- **Log:** the last N transitions — started, escalated, answered, timed out, stopped — with times and
  the stop reason. This is what makes a failed night diagnosable in the morning.

## 7. Failure modes the panel must survive

- The page is closed or the socket drops: the session continues; the panel reconnects and re-reads
  `status` before trusting any push.
- `invoke` arrives during a stop: both are idempotent, and the later state wins.
- The engine dies while the page is open: the panel shows `error` with the reason and does not pretend
  the session is still alive.
- The host has no WebUI for this World (older build): everything still works through config, the tools
  and the hotkey. The panel is an addition, never a dependency.

## 8. Safety

- Stop cancels an open escalation **before** ending the session, so a question can never outlive the
  run it was asked about.
- The panel never receives the frame JPEGs it does not need: log lines and state only, so a stray
  screenshot cannot leak through the console.
- No credentials, no provider endpoints, no file paths outside the package.

## 9. Open questions

1. Does the host re-render a panel on `stream`, or does the client own the DOM? (Read
   `cortico-world-desktop-pet/src/webui/client.ts` before implementing; the answer decides how much of
   the panel is server-pushed.)
2. `getMethods` exists for GET; is Start/Stop over GET acceptable, or must they be POST-only with a
   token? (Default: POST-only, since they change state.)
3. How much of the log survives a World restart? In memory only, or a bounded `storage` part?

## 10. Acceptance

- With the app open and the World enabled, the panel shows `idle` before a session and `running` during
  one, with the position and escalation count updating without a manual refresh.
- Stop from the panel ends a running session and from `escalating` within one tick, and the session
  ends with the same `wvd.stopped` event and reason the loop would have pushed anyway.
- With the page closed, `Ctrl+Alt+W` still stops the session — verified by running the session without
  ever opening the panel.
