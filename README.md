# wvd-agent

The agent for Wizardry Variants Daphne (Steam): a Cortico World that runs unattended, sees the game
window as its world, and clears a dungeon floor.

Its repository root is the World package — `package.json`, `src/`, `tests/` — which Coopanion loads
from its extension directory. Coopanion itself is a sibling checkout, consumed unmodified.

## Status

Design complete, implementation not started. Binding declarations live in
[`docs/specs/2026-10-24-contracts.md`](docs/specs/2026-10-24-contracts.md); the work is sequenced in
[`docs/plans/2026-10-24-wvd-world-v1.md`](docs/plans/2026-10-24-wvd-world-v1.md).

| Document | Settles |
| --- | --- |
| [world design](docs/specs/2026-10-23-wvd-world-design.md) | Architecture, the 10 Hz loop, escalation, the stop control, v1 scope |
| [contracts](docs/specs/2026-10-24-contracts.md) | **Binding.** Types, engine protocol, configuration, ownership |
| [chest policy](docs/specs/2026-10-24-chest-policy-design.md) | The QTE, willpower economy, reroll, timing model |
| [navigation](docs/specs/2026-10-24-navigation-design.md) | The map command chain and its stop states |

## How it reaches the app

```
Coopanion/build/data/extensions$ pnpm add <path to this repository>
```

then restart Coopanion. The link is an artifact of the app, not of this repository: the source of
truth stays here, and the app's tree is never edited.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Contracts, loop, policy, Win32 capture and input |
| `tests/` | Unit and fixture tests |
| `scripts/` | Replay harness and one-off tools |
| `docs/` | Specs and plans |
| `testdata/` | Recorded frames and route logs |

`testdata/` is 296 MB on disk; the raw screen recordings are git-ignored and the fixtures derived
from them are committed.
