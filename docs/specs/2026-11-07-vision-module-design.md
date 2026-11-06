# 2026-11-07 — The vision module: frames over shared memory, no encoder in the loop

The World's capture pipeline is one child process that captures the window, **encodes every frame to
JPEG**, and ships the JPEG over a line-delimited JSON pipe. The World decodes it back to pixels on
every tick. Tonight it ended three runs, and the measured costs say the shape is wrong, not the
constants.

## Why

**The failure.** The child's encoder is GDI+ over koffi (`src/engine/gdiplus.mjs`): BGRA →
`GdipCreateBitmapFromScan0` → `CreateStreamOnHGlobal` → `GdipSaveImageToStream` → **the stream's COM
vtable is read by hand and slot 5 (`Seek`) called through koffi** to learn the length. That call
takes a **napi fatal error** at the end of long runs. The worker dies, no new JPEG arrives, and the
World sees only `stale-frame`:

```
2026-11-07 03:10:46  capture failed (1/3) … "capture timeout: stale-frame"
2026-11-07 03:11:15  exit script stopped at step 6 (expect-timeout: screen stayed dungeon)
                     run stats: 0 cycles; chests 0; battles 0        (frameAgeMs 7878)
```

The same crash ended the 01:11 and 02:44 runs. It is not the game, and it is not our JavaScript: it is
the hand-wired FFI call in the hot path.

**The costs, measured 2026-11-07 on this machine.**

| | per 1920×1080 frame |
| --- | --- |
| JPEG at q75 (what travels today) | **197 KB** |
| base64 + JSON framing of that frame | ~0.5 ms (fine) |
| base64 + JSON framing of **raw** BGRA | **~55 ms** and 11.1 MB — the line protocol cannot carry raw |
| a raw BGRA copy | **2 ms** |
| GDI+ encode (native) | ~20 ms |
| jpeg-js encode | **174 ms** at 1920, 78 at 960, 61 at 480 |
| World decode (native / jpeg-js fallback) | 10–20 ms / **179–359 ms** |

So: the encode is what crashes, the decode is what the World pays per tick, and the pipe framing is
what stops raw frames travelling. Downscaling does not rescue it (jpeg-js still costs 61 ms at
480×270) and it would cost a second perception profile.

## What the industry does

1. **Capture and consumer share memory, not a pipe.** OBS, ROS and GStreamer all publish the newest
   frame into a ring buffer and let the consumer take the latest slot; pipes carry commands only.
2. **Encode only at the boundary.** The hot loop moves pixels; JPEG exists for artefacts that leave
   the machine (escalation snapshots), not for every tick.
3. **Let the fragile part crash — under a supervisor.** A native boundary lives in its own process
   and is restarted on death with a health channel (Erlang, Chrome, OBS), instead of being trusted.
4. **Two-tier capture for text**: a cheap low-resolution pass for "which screen is this", a
   full-resolution **crop** for the numbers. The ROI crop is the exception, not the rule.

## The new module

`src/engine/vision/` replaces the JPEG path. Four units, each with one job:

- **`frame-channel.ts`** — the shared-memory frame channel. A named file mapping with a header and
  `N` frame slots. Writer (`publish`) and reader (`latest`) with a seqlock: the reader is never handed
  a torn frame; a frame it cannot take in one read is retried once and then refused (a value, never a
  throw). Pure layout logic is testable on a plain Buffer; the koffi mapping layer is a thin
  `open/create` around it.
- **`capture-host.ts`** — the supervisor. Spawns the child, watches its liveness and the channel's
  heartbeat, restarts it on death or a stale heartbeat with backoff and a per-session cap, and reports
  `engineProblem: capture-restarted` / `capture-unavailable`. The session keeps running.
- **`frame-source.ts`** — the World's `FrameSource`. `capture()` returns a `Frame` whose `toRgba()` is a
  **copy of the newest slot** (2 ms); `captureBand(rect)` copies a rectangle (the QTE sampler);
  `snapshot({maxWidth})` encodes a JPEG **in the World** with jpeg-js, on demand, for the escalation
  path only.
- **`child.mjs`** (changed, not new) — the child captures and publishes to the channel; its encoder
  worker and the protocol's JPEG payload are **deleted**. Commands (tap/key/drag/focus/foreground/
  stop) are unchanged.

The `Frame` contract does not change: `{ atMs, width, height, toRgba() }`. What changes is where the
pixels come from — a mapped slot instead of a base64 JPEG — and where they are encoded (the World,
only for snapshots).

## Contracts

- `docs/specs/2026-10-24-contracts.md` §5 (the engine protocol) and `src/contracts.ts`: the `capture`
  reply stops carrying `jpeg` and carries `{ seq, capturedAt, width, height }`; the channel is the
  frame's transport. The mirror rule applies — one commit for both.
- The channel layout is a contract too, versioned by a `version` word; an older child and a newer
  World must refuse each other rather than misread a slot.
- The child's input commands are **not** changed by this module.

## Layout

```
header:  magic u32 · version u32 · slotCount u32 · width u32 · height u32 · stride u32
         heartbeatMs u64 · demandMs u64 · latestSeq u64
slot i:  seq u64 · capturedAtMs u64 · width u32 · height u32 · state u32 · pad
         payload: width*height*4 BGRA
```

Two slots (2 × 8.3 MB ≈ 17 MB). Publish: write the payload into the free slot, then advance `seq` with
a release fence; the reader reads `seq` before and after the payload copy and accepts the frame only
when it is unchanged (seqlock). `latestSeq` names the newest published slot. A stale heartbeat
(`now - heartbeatMs > 1 s`) is the supervisor's signal, not the World's.

## Non-goals

- No change to perception: the loop still gets full 1920×1080 frames, and every perceiver's measured
  rects and templates stay untouched.
- No downscaled loop tier yet (the `maxWidth` path stays available for snapshots and is the hook for a
  later low-resolution tier).
- No new capture backend (Windows Graphics Capture/DXGI) in this module; GDI `PrintWindow` stays
  behind the channel. It is the next candidate if the capture itself proves flaky.
- No model in the loop: the OCR escalation (2026-11-07) and the escalation snapshots keep their
  on-demand paths.

## Acceptance

1. A three-cycle farm runs with **no encoder in the loop**: the child publishes raw frames, the World
   reads them, and `engineProblem` reports nothing for the encoder.
2. Killing the child mid-run (task 6's test, and once live) restarts it; the session continues and the
   run's report names the restart. No session is ended by a capture failure alone.
3. The QTE band is read from the channel (**no decode**), and the QTE log line's timing shows the
   sampling cost fell.
4. The full suite is green, `tsc --noEmit` is clean, and `src/engine/jpeg-worker.mjs`,
   `gdiplus.mjs`'s encoder and the protocol's JPEG payload are deleted.
