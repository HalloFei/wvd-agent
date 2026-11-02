# The active battle member, read off the party panel (2026-11-02, revised 2026-11-03)

The operator's opener rule (contracts §11) filters **the ACTIVE member's name** against a configured
list every battle: on the list, that member's skill is cast; not on it, auto takes over. That read was
the one stub — `BattleMemberReader` answered `null`, so every battle fell through to auto. On
2026-11-02 the operator supplied the party's names, in the panel's own card order, and asked for them
to be filled in so the battle module works.

## The realisation

`src/perception/party.ts`. The command phase draws a 3×2 panel of six member cards under the tab row.
**The card of the member whose turn it is is drawn with a yellow-to-orange frame**; the other five
frames are white/grey, and a card the enemy has marked is tinted red. The operator read it off the
panel himself (2026-11-03): *the active icon is yellow to orange colour, while inactive is white.*

The measure is the mean of `max(r, g) - b` over a 3 px ring just inside the card's edge. Measured on
the three command-phase frames (1920×1080):

| frame | turn card's frame | the other five |
| --- | --- | --- |
| `battle-2026-11-02/alice-command-phase.jpg` (爱丽丝) | **68.8** | 6.0–16.4 |
| `battle-2026-11-02/command-phase.jpg` (DragonSlayer) | **98.9** | 4.3–32.9 |
| `screens/2026-10-25-live/combat-command.jpg` (DragonSlayer) | **63.2** | 3.4–17.4 |
| skill panel open (cards dimmed behind it) | — | no answer |
| highest non-battle frame in the same rects | — | 18.6 (`nav-2026-10-24-ffxi4f/third-floor-glow.jpg`) |

The red-marked card is the highest non-turn score (32.9) and stays under the floor. The face tint
(`min(r, g) - b` over the face, 8 px inside) separates more cleanly still — 33.9–53.7 against ≤ 3.5 —
but the frame is the marker the game itself draws, so the reader follows it.

`PARTY_MEMBERS` = 艾莉赛, 本杰明, 拉纳维尔, DragonSlayer, 爱丽丝, 薇薇安娜DEX6. The reader answers the
roster name of the framed card.

## Why not the name glyph

The ACTIVE band (top left) prints the name too, and the obvious design was a template per member
matched against it — the contract's own wording. It was measured and rejected: the band draws its
name over the portrait's golden plate at a *different size* from the panel (DragonSlayer is 112 px
wide in the band, 94 px in the panel), and normalised cross-correlation of the band against all six
panel templates scored **0.25–0.37 for every candidate** — no discrimination at all. The frame
separates the right card by 2–4×, and the face by 10×+.

The operator's 2026-11-02 note set the priority for this read: *the importance is not the background
or colour, but the character name* — the names are what the pipeline was missing, and they are in the
roster. His 2026-11-03 note says how the card is told apart: *colour*, the frame.

## Guards

`activePartyMember` asks `battleHudUp` first — the evidence `CombatPerceiver` already uses: both
button windows lit, and no screen fact ruling a battle out. Then the framed card must clear
`ACTIVE_FRAME_MIN = 40` and lead the runner-up by `ACTIVE_FRAME_RATIO = 1.5`. Anything else is `null`:
the contract's miss, never an error, and never a tap on a slot for a member the frame did not name.

**The panel is drawn a beat after the battle screen.** Live 2026-11-03 02:07 the read came back
unreadable on the battle's first combat frame; on the saved frame a second later the same panel scores
68.8 on 爱丽丝's frame. The World therefore *retries* the read for `OPENER_READ_WINDOW_MS = 3 s` and
does not press 倍速/自動 while the read is owed — auto would take the command phase the cast needs. An
unreadable window is a miss: auto takes the battle with no cast.

## What it does not do

- **It reads no glyphs.** A party change is a `PARTY_MEMBERS` change: the roster is the operator's
  party, not a template library. A stale roster would name the wrong member — keep it with the party.
- **It never answers on a doubtful frame.** No battle HUD, no framed card, dimmed panel, another screen
  size: all `null`, and the battle falls through to auto after the read window.

## Acceptance

`tests/party.test.ts` pins the roster, all three command-phase frames' answers (爱丽丝 once,
DragonSlayer twice, with the frame numbers), the dimmed and non-battle nulls, and the size gate.
`tests/world.test.ts` pins the opener read window: unreadable → wait, no auto press; readable on the
next frame → cast then auto; the window spent → auto with no cast. The filter's fold (`memberKey` in
`src/actions/battle.ts`) pins the operator's 愛麗絲 → the roster's 爱丽丝.
