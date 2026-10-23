# AGENTS.md — the WVD agent

This repository is the LLM-powered agent for Wizardry Variants Daphne, Steam build. Its repository
root **is** the Cortico World package: `package.json`, `src/` and `tests/` are the extension
Coopanion loads. The upstream autoscript that taught us the game lives in the sibling checkout
`../wvd`, kept as study material; nothing here imports it.

## 1. Philosophy: contracts between modules

The system is a chain of modules, each replaceable without touching its neighbours. Every boundary
is an explicit contract — a type, a value, a timing — and a module may only know what its contract
promises.

- **Upstream and downstream are named.** A module publishes what it accepts and what it returns;
  it never reaches into a neighbour's internals or shared mutable state.
- **Realisation is free.** Any implementation that honours the contract is legal: a template
  perceiver, a model perceiver, a recorded replay. Swapping one must not change the caller.
- **Timing is data.** Every observation carries the monotonic time it was taken. Nothing infers
  latency from the wall clock after the fact.
- **Failure is a value.** A module returns a typed failure; it does not throw into the control loop.
- **The model is an escalation, not a layer.** The fast loop never waits on a network round trip.

When a new behaviour seems to need a new contract, extend the contract at the seam that owns the
fact, not the module that happens to use it.

## 2. Decisions

- The farmer owns the machine. Input reaches the game only through a focused window; a background
  click is ignored (measured 2026-10-23). Parallel use would need a second Windows session and is
  out of scope.
- Local policy, model on escalation. Routine decisions run at 10 Hz inside the World; the model is
  asked only when perception is unsure or a judgment is due.
- Coopanion is consumed as an unmodified checkout. This package is linked into its extension
  directory, never vendored into `Coopanion/`.

## 3. Layout

| Path | Contents |
| --- | --- |
| `src/` | Contracts, loop, policy, Win32 capture and input |
| `tests/` | Unit tests and fixture-driven tests |
| `scripts/` | Replay harness and one-off tools |
| `docs/specs/` | Design and decision records; `2026-10-24-contracts.md` is binding |
| `docs/plans/` | The implementation plan being executed |
| `docs/guides/` | The operating guidebook: live clicks, keys, coordinates and open blockers |
| `testdata/` | Recorded frames and route logs used as fixtures |

This repository is the submodule `wvd-agent` of the umbrella workspace `DeepSeek_Coopanion/`, which
also pins `Coopanion/` and `wvd/`. Install into the app with `pnpm add` from Coopanion's extension
directory; the source of truth stays here.

## 4. Rules

- Do not start or stop the game, and do not send input, without an explicit request from the
  operator. Default state: idle, hands off.
- Never let the agent act while the operator is using the machine without announcing the session
  first; the World takes the foreground and must say so.
- Operating the game by hand or by probe starts with
  [`docs/guides/2026-10-24-live-control-guide.md`](docs/guides/2026-10-24-live-control-guide.md):
  its safety section is binding too, and it records which steps are verified and which are open.
- UU accelerator runs elevated and cannot be driven by this tool (Windows UIPI); leave it to the
  operator.
- Specs live in `docs/specs/` as `YYYY-MM-DD-<topic>-design.md`.
- `src/contracts.ts` mirrors `docs/specs/2026-10-24-contracts.md` declaration for declaration; a
  change to one is a change to the other in the same commit.
- Commit at every milestone, staged by explicit path.
