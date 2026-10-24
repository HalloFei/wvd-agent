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
  reversal is invalid. Its core centre reverses at **656.5 and 1261.5** — roughly 40 px outside each
  zone, off the bar's end caps — not at the zone edges. A clamp at 694/1224 is wrong by one zone's
  margin and would refuse reachable passes.
- The marker's white core is **6–9 px wide**; the 13–17 px run around it is the hole it punches in the
  zone's fill. Any run-length floor above 9 finds nothing.
- The marker **brakes after the tap**: from the last full-speed frame it travels **68 px over ~500 ms**
  to rest. An earlier reading of 44 px started from a frame already easing.

The tap condition:

```python
lead      = v * L + v * v / (2 * a)     # inertia + sliding distance
tap when  x_now + lead == zone_centre    # i.e. x_now == zone_centre - lead
```

`L` is 48.7–67.2 ms, measured on this machine. `a` is not fitted per chest: the recorded stop implies
**2740–3100 px/s²**, and it must be refined from taps the agent time-stamps itself. Speed itself needs
**three frames spanning at least 66 ms** — two consecutive 30 fps frames carry a 20 px step and a
5.8 % worst-case velocity error, and duplicate frames in a recording turn a naive pair into 0 then
1215 px/s.

`qteDecelPxPerS2` ships as **3000 px/s²**, which the recorded stop now supports to within 10 % (the
fitted range is 2740–3100). The 44 px reading would have implied 4228, so the constant was right for
the wrong reason. Every tap the agent stamps refines it; until then, `planTap` must keep its refusal
threshold (`qteMinWindowMs`) ahead of the error this constant can introduce.

At 500 px/s the lead is ~80 px; at 1200 px/s it is ~330 px, wider than a zone. Fast chests are
tapped **before the marker reaches the zone**, which is why the decision must be made within the
first 150 ms of the bar: two frames fix `v`, then one scheduled press, no corrections.

## 3a. A chest is not always trapped

Recorded 2026-10-24 on a live chest: the 由谁打开? panel was answered, the chest opened, and **no
disarm bar appeared at all** — some chests are simply untrapped (operator). The same panel is therefore
followed by one of two things:

- a QTE, when the chest is trapped, or
- loot, when it is not.

So `chest-open` is a fork, not a step: the screen after the panel decides which branch the run is on,
and a loop that waits for a QTE bar that never comes will stall on every untrapped chest. The two
outcomes are also distinguishable without reading a bar: the QTE screen is the bar at the top of the
frame, and loot is the reward list.

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

- The bar occupies **rows 36–82** of a 1920×1080 frame, identical across 199 recorded frames and both
  chests. It is a fixed HUD anchor: do not search for it vertically.
- The marker's white core is **6–9 px wide**. A width floor of 18 px finds nothing.
- Clip to **x 645–1275 before any run logic**. Without the window the lit wall yields 126–148 px runs,
  which sit inside the zone-width tolerance and pass every shape test — the window is what stops it,
  not the width rule.
- Several **static** white runs sit on the bar (borders, segment edges). Eliminate runs present in
  both frames before matching; the survivor is the marker.
- Each zone is **150–300 px wide** and the hazard gap **50–120 px**; a pair outside those bounds is
  scenery, not the bar.
- The **解除 button** sits at the bar's centre x — the midpoint between the two zones — at
  **y = round(0.613·H)**, which is 662 at 1080. Not 553: the chest's own gold highlight is 109 px
  above it, and a colour search there is the measured failure. Its white hand glyph is the anchor.
- The button has an **enabled and a dimmed state**, readable as glyph-box contrast: 66–73 live, 20–32
  after the tap. Scheduling a tap only while it is enabled separates "the QTE is live" from "the QTE
  is resolved" without waiting for the screen to change.
- The attempt count is a 10×16 px red numeral that has only ever been seen as 3. **Return `null`** and
  use `qteAttemptsFallback`; an unvalidated OCR is worse than an admitted gap.
- The slide term carries the **sign of motion**: `lead = v·L + sign(v)·v²/(2a)`.
- When no zone is reachable in the current pass, **wait for the next pass**; the marker bounces
  forever and passes are free until an attempt is spent.
- Slice **before** thresholding. A whole-frame pass costs ~85 ms; the band and the button window
  together cost 0.8 ms. A TypeScript port that iterates 2 073 600 pixels breaks the half-tick rule on
  its own.

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
