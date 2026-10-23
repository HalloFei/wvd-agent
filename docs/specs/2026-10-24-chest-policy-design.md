# Chest policy — design

Status: accepted; open: `qteDecelPxPerS2` provisional (contracts §8.4, chest §3), trap-fear UI unobserved
Owner: the repository root
Sources: [宝箱开锁攻略](https://wizdaphne.huijiwiki.com/wiki/%E5%AE%9D%E7%AE%B1%E5%BC%80%E9%94%81%E6%94%BB%E7%95%A5) (wiki, untrusted reference), two recorded chests, and the operator's corrections.

## 1. Scope

Everything between "the game shows a chest" and "the loot is gone": choosing an opener, the two
judgements, the QTE, what a failure costs, mimics, and getting back to the route.

Not here: how the route finds chests, or what to do with the loot.

## 2. The flow, as the game actually runs it

1. **Choose an opener** — 由谁打开? lists every character with 陷阱发现 and 陷阱解除.
2. **No trap?** The chest opens immediately. Nothing else happens.
3. **陷阱发现 judgement.** Character's detection against the chest's level. Success → the QTE.
   Failure → the trap fires: no QTE at all, **willpower −5**, and the loot is still granted.
4. **The QTE.** Character's 陷阱解除 sets the **width of the yellow zones**; the chest's level sets
   the difficulty. Stop the marker in a zone to open. Each failed stop: **willpower −1** and one
   attempt spent. When attempts run out the trap fires: **willpower −5**.
5. **Attempts** are class-based: a thief gets 3 (4 at level 63), everyone else 2. The count is
   visible under the bar.
6. **陷阱恐惧.** Below 60 willpower a triggered trap may inflict it; near-certain below 20. A feared
   character can no longer be assigned to open chests. It clears on leaving the dungeon, from a
   thief's level-54 skill, or with 寻宝烈酒.

**Consequence for the policy:** a failed QTE is not a lost chest. The cost is willpower and a spare
attempt. The real cost is the trap-fear threshold, which removes a character from the roster for the
rest of the dungeon.

## 3. The QTE timing model

Measured on two chests; the second recorded at 30 fps (`testdata/chest/`).

- The marker's speed is **fixed per chest**, decided when the QTE starts, and constant in flight.
  488 px/s on one chest, 610 on the next.
- Zones are **random per chest**: ~694–922 and 997–1223 on both samples, which is two samples, not a
  guarantee.
- The marker **bounces** at the bar's ends and eases near them, so a prediction that crosses a
  reversal is invalid.
- The marker **brakes after the tap**: about 44 px of travel over ~300 ms in the recorded stop.

The tap condition:

```python
lead      = v * L + v * v / (2 * a)     # inertia + sliding distance
tap when  x_now + lead == zone_centre    # i.e. x_now == zone_centre - lead
```

`L` is 48.7–67.2 ms, measured on this machine. `a` is not yet fitted: the recorded stop gives
44–84 px of slide depending on which frame the operator's click landed on. It must be fitted from
taps the agent time-stamps itself.

The provisional value shipped in `qteDecelPxPerS2` is **3000 px/s²**, chosen so that the 44–84 px
slide at ~600 px/s comes out in the right range (v²/2a = 60 px). It is a placeholder with a known
error of a factor of two in either direction, not a measurement. Every tap the agent stamps refines
it; until then, `planTap` must keep its refusal threshold (`qteMinWindowMs`) ahead of the error this
constant can introduce.

At 500 px/s the lead is ~80 px; at 1200 px/s it is ~330 px, wider than a zone. Fast chests are
tapped **before the marker reaches the zone**, which is why the decision must be made within the
first 150 ms of the bar: two frames fix `v`, then one scheduled press, no corrections.

## 4. The speed reroll, and why it matters

The wiki states the cursor's speed is **not** affected by any stat, and that for chests on the floor
you can leave the QTE and re-enter to change the speed.

So speed is a variable the policy can **choose**, not just measure: when the measured `v` gives a
lead wider than half a zone, cancel the QTE and re-select the opener to reroll it. Cancelling costs
**no attempt** (confirmed by the operator), so the reroll is free and is the default answer to a bad
speed. Cancelling a **dropped** chest destroys it, so this is only for chests on the floor.

This turns the hardest case — a fast bar with a long lead — into a retry instead of a gamble.

## 5. Choosing the opener

- 陷阱解除 sets the zone width: higher is better, and the widest zone is worth more than a square
  metre of precision.
- 陷阱发现 decides whether the QTE happens at all; failing it costs willpower but keeps the loot.
- The class sets the attempts.
- A character with 陷阱恐惧 cannot be chosen; one close to 60 willpower should not be, unless
  nothing better is left.

Rank by disarm first, then attempts, then willpower headroom.

## 6. Failure semantics the policy relies on

| Outcome | Willpower | Attempts | Loot |
|---|---|---|---|
| No trap | — | — | granted |
| Discovery fails | −5 | — | granted |
| QTE miss | −1 | −1 | still open |
| Attempts exhausted | −5 | 0 | granted |
| Trap fires with willpower < 60 | −5, may add 陷阱恐惧 | — | granted |

The operator confirmed loot is granted even when discovery fails. The same is assumed for a QTE
trap and is the first thing to verify against the game, because it decides whether a risky chest is
worth attempting at all.

## 7. Mimics

A 宝箱怪 opens into a battle instead of a QTE. The policy detects this as **a state change from the
chest screen to the combat screen** — no bar appears, and combat markers do — and hands control to
the battle policy rather than reporting a parse failure.

## 8. After the open

There is nothing special: tap through the loot lines until no new loot info appears, then return to
the route. The chest is consumed.

## 8a. Detector constants learned the hard way

Each of these cost a live attempt to discover, so they are recorded rather than rediscovered:

- The cursor's white run is only **10–16 px tall**, not the 40 px the bar suggests. A threshold of
  18 px finds nothing.
- Several **static** white runs sit on the bar (borders, segment edges). Eliminate runs present in
  both frames before matching; the survivor is the cursor.
- The bar is **centred on the screen**, about 960 ± 280 px, across all three chests seen. Searching
  wider picks up the lit wall as a "zone".
- Each zone is **150–300 px wide** and the hazard gap **50–120 px**; a pair outside those bounds is
  scenery, not the bar.
- The **解除 button** sits at the bar's centre x, at y 630–690 — not 553, where the chest's own gold
  highlight fools a colour search. Its white hand glyph is the reliable anchor.
- The slide term carries the **sign of motion**: `lead = v·L + sign(v)·v²/(2a)`.
- When no zone is reachable in the current pass, **wait for the next pass**; the marker bounces
  forever and passes are free until an attempt is spent.

## 9. What the implementation must do, in order

1. Read the opener panel: names, 陷阱发现, 陷阱解除, willpower; exclude feared characters.
2. Choose the opener and click it.
3. Wait for either the QTE bar, combat (mimic), or the loot screen (no trap), with a bounded timeout.
4. If the bar: parse zones, marker, attempts counter and the 解除 button; sample twice for `v`;
   decide between reroll (ground chest, lead too wide) and tap.
5. If tap: schedule the press, then read the resting position and log `(v, tap_x, rest_x)` to fit `a`.
6. If combat: hand off.
7. Tap through loot until it stops changing.

## 10. Resolved by the operator

1. Cancelling a floor chest's QTE costs **no attempt**. The reroll is free, so a lead wider than the
   zone is always rerolled rather than gambled.
2. A QTE trap still **grants the loot**. Failure costs willpower and a spare attempt, nothing else.
   This makes the chest policy a willpower-budget problem, not a loot-risk problem.
3. A character whose willpower has dropped refuses to open chests outright — the panel may still
   offer them, but choosing one fails. The policy must recognise a refusal and fall through to the
   next best opener instead of retrying the same character.

Still unobserved: how the refusal presents in the panel, and the exact willpower threshold at which
it begins. The policy treats anything under 60 as unusable and logs the refusal when it happens.
