# The active battle member, read off the party panel (2026-11-02)

The operator's opener rule (contracts §11) filters **the ACTIVE member's name** against a configured
list every battle: on the list, that member's skill is cast; not on it, auto takes over. That read was
the one stub — `BattleMemberReader` answered `null`, so every battle fell through to auto. On
2026-11-02 the operator supplied the party's names, in the panel's own card order, and asked for them
to be filled in so the battle module works.

## The realisation

`src/perception/party.ts`. The command phase draws a 3×2 panel of six member cards under the tab
row. **The card of the member whose turn it is is tinted gold across its whole face**; the others stay
the panel's neutral dark, and a card the enemy has marked is tinted red — never gold, because a red
face scores `min(r, g) - b` at 2.3 against the turn card's 53.7.

The measure is the mean of `min(r, g) - b` over the card's face, sampled 8 px inside the card so the
border and its glow are not counted. The roster is the operator's six names in panel order.

| measure | value |
| --- | --- |
| card faces | 192×114 on a 194 px pitch (`PARTY_CARDS`) |
| turn card, `battle-2026-11-02/command-phase.jpg` | **53.7** |
| the other five, same frame | ≤ 3.5 |
| turn card, `screens/2026-10-25-live/combat-command.jpg` | **33.9** |
| the other five, same frame | ≤ 3.3 |
| skill panel open (cards dimmed behind it) | ≤ 5.5 → no answer |
| highest non-battle frame in the same rects | 18.6 (`nav-2026-10-24-ffxi4f/third-floor-glow.jpg`) |
| world map's faces | 49.8 against 42.8 — uniformly gold, no lead |

`PARTY_MEMBERS` = 艾莉赛, 本杰明, 拉纳维尔, DragonSlayer, 爱丽丝, 薇薇安娜DEX6. The reader answers the
roster name of the gold card.

## Why not the name glyph

The ACTIVE band (top left) prints the name too, and the obvious design was a template per member
matched against it — the contract's own wording. It was measured and rejected: the band draws its
name over the portrait's golden plate at a *different size* from the panel (DragonSlayer is 112 px
wide in the band, 94 px in the panel), and normalised cross-correlation of the band against all six
panel templates scored **0.25–0.37 for every candidate** — no discrimination at all. The card tint
separates the right card by 15×, so that is what the reader keys on.

The operator's 2026-11-02 note set the priority for this read: *the importance is not the background
or colour, but the character name* — the names are what the pipeline was missing, and they are in the
roster.

## Guards

`activePartyMember` asks `battleHudUp` first — the evidence `CombatPerceiver` already uses: both
button windows lit, and no screen fact ruling a battle out. Then the gold card must clear
`ACTIVE_GOLD_MIN = 20` and lead the runner-up by `ACTIVE_GOLD_RATIO = 2.5`. Anything else is `null`:
the contract's miss, never an error, and never a tap on a slot for a member the frame did not name.

The reader answers while the command phase is up. The World reads at the first `combat` tick, before
it taps 倍速/自動, so the panel is clear; the skill panel's dimming is the one battle state that
answers nothing.

## What it does not do

- **It reads no glyphs.** A party change is a `PARTY_MEMBERS` change: the roster is the operator's
  party, not a template library. A stale roster would name the wrong member — keep it with the party.
- **It never answers on a doubtful frame.** No battle HUD, no gold card, dimmed panel, another screen
  size: all `null`, and the battle falls through to auto.

## Acceptance

`tests/party.test.ts` pins the roster, the two battle frames' answer (DragonSlayer), the dimmed and
non-battle nulls, and the size gate. The filter's fold (`memberKey` in `src/actions/battle.ts`) pins
the operator's 愛麗絲 → the roster's 爱丽丝.
