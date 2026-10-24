# QTE timing loop — a cheap sample, then a sub-loop — design

Status: proposed (awaiting the operator's approval)
Owner: the repository root
Sources: `2026-10-24-contracts.md` §1, §5, §7; `2026-10-24-chest-policy-design.md` §3, §8a;
`.superpowers/sdd/2026-10-24-wvd-world-v1/research-qte-parser.md` §4, §8; the measurements in
`docs/status.md` (capture round trip 2.5 ms, native decode 23.4 ms, cadence ~33 ms).

## 1. Intent and the why

`planTap` is tested and has no caller (task #3). The loop cannot give it one, because the loop's
granularity is the tick: at 610 px/s a 100 ms tick is 61 px of marker travel, 27 % of the 224 px
zone the QTE is aiming at. Timing a bar needs a sub-loop that reads the bar on its own cadence and
sleeps to the instant it planned.

A sub-loop was assumed to need more frames, hence the question of raising the game to 60 fps.
Measurement says otherwise: the World pays a **full-frame JPEG decode** (23.4 ms, native GDI+) for
every sample, so three samples cost ~100 ms whatever the game's frame rate is, and at 60 fps the
decode — not the game — becomes the sampling cadence. The game already renders faster than the
agent can look: the child's measured cadence is ~33 ms, i.e. one frame per rendered frame.

So the order is: **make one sample cheap, then build the sub-loop on it.** Concretely, ask the
child for the QTE's own rectangle instead of a 1080p frame: that rectangle is 21.3 % of the pixels,
so the decode it costs is a fifth of today's, and three samples fit inside one bar pass with room
for the pipe.

## 2. Goals, non-goals, anti-goals

Goals:
1. A cropped capture through contracts §5 whose decode is ≈1/4 of a full frame's, with the crop
   applied in the child before encoding (the JPEG *is* the transport; cropping after decode spends
   the decode).
2. The QTE sub-loop: sample the bar at the game's own cadence, measure `v`, `planTap`, press once.
3. Log every press as `(v, tapX, restX)` — the sample `qteDecelPxPerS2` (#18) is waiting for.

Non-goals: the phase/oscillator model that predicts a pass instead of measuring it; the reroll
(needs a cancel gesture no contract owns); the attempts numeral's OCR.

Anti-goals: a second bar parser inside the child; a band capture that changes what `parseQte`
certifies (same refusals, same numbers); a press on a sample whose age is unknown.

## 3. Constraints

- Contracts §5 is binding, and its `ageMs` stays the authority for what a sample shows.
- `qteMinWindowMs` stays **150 ms** until #18 has measured the distribution of
  (planned instant → `SendInput` completed). The floor is a guard band over the measured legs —
  frame age, 23.4 ms decode, 2.5 ms round trip, 48.7–67.2 ms click-to-visible — not a physics
  constant, and shrinking it without that measurement is guessing.
- §0 rule 7: one `capture`/`observe` inside half a tick (50 ms).
- §0 rule 5: dimensions come from the frame; the crop rectangle is in device pixels of the
  window's client area.

## 4. Approaches considered

**A. Crop in the encoder worker, parse the crop (chosen).** Add `crop` to `capture`; the encoder
worker — which already holds the frame's BGRA before it encodes — copies the rectangle and encodes
that. Mirror of the existing `maxWidth` snapshot path, so the directive/queue/timeout plumbing and
its tests already exist. The crop is 21.3 % of a frame, so the World's decode drops from 23.4 ms to
~5 ms and a sample lands in ~8–9 ms. Cost: contract §5, one pure module, one parser entry point.

**B. Time the QTE inside the child.** The child owns the BGRA at the game's frame rate, so it could
scan the band and press on its own clock with no pipe in the path — strictly the cheapest option.
Rejected for v1: it puts perception inside the transport, and the band scan would exist twice (mjs
and TS) or the child would have to run the TypeScript parser. Named here as the upgrade if the pipe
ever becomes the limit.

**C. Raise the game to 60 fps.** Does nothing on its own: the sub-loop is limited by the decode
until A lands. It also invalidates the model that was measured at 30 fps (per-frame easing near a
bounce, the ~5-frame eased zone), and it is a graphics setting on the operator's machine. Kept as a
*measurement experiment* after A: at 60 fps the marker's per-frame step halves (20.4 → ~10.2 px), so
3 samples over 33 ms would be noisier than 3 over 66 ms; the win, if any, is the ~35 ms earlier
first velocity estimate, and that needs measuring, not assuming.

**D. Pipeline two full-frame decodes.** No contract change, halves the decode wall clock, keeps the
26 ms sample and burns a core. Rejected as a stopgap that hides the cost.

## 5. The change, as decided

1. **§5 `PixelRect` and `capture { crop }`.** `{ x, y, width, height }` in client device pixels.
   Served exactly like `maxWidth`: a directive names the rectangle for the next frame, the encoder
   copies and encodes it, and the reply carries the rectangle back so the World can put the crop's
   coordinates into the frame's. A reply whose echoed rectangle is absent is the full frame.
2. **The rectangle's owner is the perceiver.** `perception/chest.ts` exports `qteWindow(frame)`:
   x 645…1275, y 36…734 — the bar's band (rows 36–82) *plus* the 解除 annulus at
   `y = round(0.613·H) ± 72`. One rectangle, not two: the crop therefore contains every field
   `parseQte` reads, so the band parse is the same parser with the same refusals (`no-bar`,
   `no-marker`, `no-button`) and the same absolute coordinates. A band-only crop (0.4 ms) would
   leave `no-button` unanswerable; it is the optimisation to take only if the pipe ever dominates.
3. **`parseQte(frame, previousMarkerX?, origin?)`.** `origin` is the crop's top-left in the full
   frame; `scanBand` and `readButton` add it back, so `QteState.zones`, `markerX` and `button`
   stay in full-frame device pixels and no caller changes.
4. **`FrameSource.captureBand?(rect)`** (§1, optional so every existing realizer still conforms),
   implemented by `Win32Capture` as `capture { crop }`. A source without it keeps working: the
   sub-loop falls back to a full-frame `capture()`.
5. **`#timeQte` in `world.ts`**, entered from `#step` when the observation is `chest-qte` and
   before the policy switch: sample the band until three samples span ≥ 66 ms, `qteVelocity`,
   `planTap`; refuse when the plan is shorter than `qteMinWindowMs` and wait for the next pass;
   otherwise sleep to `atMs`, `holdKey(SPACE, pressHoldMs)`, then take one full frame and record
   the resting marker position with the plan that produced it. The sub-loop returns when the bar
   resolves (a sample refuses) or a bounded pass count is spent, and the tick resumes as today.

## 6. What is left to the builder

- Where exactly `#timeQte` sits relative to `#advanceInFlight` and the failure sets, and whether a
  refused plan may re-plan inside the same sub-loop (it should — passes are free) or must yield to
  the tick.
- The one-press-per-bar rule: a second press only after the button reads `enabled: false` *and*
  the bar returns, which is a state the live game has to confirm.
- Whether the rest-position read uses a band sample or a full frame; the band is cheaper and the
  bar outlives the tap for ~3 s in the recording.
- Names, the telemetry line's shape, and the exact acceptance numbers to write into `status.md`.

## 7. Acceptance

1. `contracts.ts` and contracts §5 change in the same commit, and §1 for `captureBand`.
2. **Same numbers from a crop**: the six stills and the 250-frame recording give byte-identical
   `QteState` (zones, `markerX`, `button`) whether parsed from the full frame or from its crop —
   199 parsed, 51 refused, the same refusals by name.
3. **The win is measured, not asserted**: cropped decode+parse ≤ 1/4 of the full frame's on this
   machine, recorded in `status.md` beside the 23.4 ms figure it replaces.
4. A world-level test with a fake source and actuator: three samples produce exactly one press at
   the planned instant; a plan under the floor produces none and re-plans; a resolved bar ends the
   sub-loop.
5. A replay check that the sub-loop, fed the recording's frames at their own timestamps, plans
   presses that land inside the recorded zones.
6. Full suite green, `pnpm typecheck` clean.
