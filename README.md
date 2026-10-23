# wvd-agent

The agent for Wizardry Variants Daphne (Steam): a Cortico World that runs unattended, sees the game
window as its world, and clears a dungeon floor.

Its repository root is the World package — `package.json`, `src/`, `tests/` — which Coopanion loads
from its extension directory. Coopanion itself is a sibling checkout, consumed unmodified.

## Status

The v1 implementation is complete: the engine child captures the game at 30 fps while occluded,
recognises the dungeon map, the 3D view and the chest QTE bar, walks the party with the game's own
automove, escalates to Coo with a screenshot when it cannot decide, and stops on every path it should.
[`docs/status.md`](docs/status.md) is the record of what runs and what is deliberately not built — read
it before the specs. Binding declarations live in
[`docs/specs/2026-10-24-contracts.md`](docs/specs/2026-10-24-contracts.md); the work is sequenced in
[`docs/plans/2026-10-24-wvd-world-v1.md`](docs/plans/2026-10-24-wvd-world-v1.md).

| Document | Settles |
| --- | --- |
| [world design](docs/specs/2026-10-23-wvd-world-design.md) | Architecture, the 10 Hz loop, escalation, the stop control, v1 scope |
| [contracts](docs/specs/2026-10-24-contracts.md) | **Binding.** Types, engine protocol, configuration, ownership |
| [chest policy](docs/specs/2026-10-24-chest-policy-design.md) | The QTE, willpower economy, reroll, timing model |
| [navigation](docs/specs/2026-10-24-navigation-design.md) | The map command chain and its stop states |
| [live control guide](docs/guides/2026-10-24-live-control-guide.md) | How to drive the game with this tool: the verified clicks, keys and coordinates, the engine API, and the open automove blocker |

## Operating it live

The [live control guide](docs/guides/2026-10-24-live-control-guide.md) is the operator's and the
agent's procedure: starting the game, the world map, 北穿幽冥城, the target floor, the dungeon map,
the key legend, and what is still unverified. Read its safety section first — input reaches the game
only on an explicit request, and UU accelerator must not be driven from here (it runs elevated).


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
