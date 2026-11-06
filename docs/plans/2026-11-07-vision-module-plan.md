# The Vision Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** replace the JPEG path between the capture child and the World with a shared-memory frame
channel: the child captures raw BGRA and publishes it, the World reads the newest frame as pixels, and
JPEG is encoded only for escalation snapshots — with a supervisor that restarts a dead child so a
capture failure never ends a session.

**Architecture:** a new `src/engine/vision/` module: a versioned shared-memory frame channel with a
seqlock, a capture host (supervisor), and a World-side frame source. The child keeps its input
commands and loses its encoder worker; the World keeps its `Frame` contract and loses its decoder.

**Tech Stack:** TypeScript (Node ≥22, ESM, `.ts` imports), the child is ESM `.mjs`, koffi for Win32 and
the file mapping, jpeg-js (World-side, snapshots only), vitest, pnpm, Windows live.

**Spec:** [`docs/specs/2026-11-07-vision-module-design.md`](../specs/2026-11-07-vision-module-design.md)

**Branch:** `feat/vision-module` — this spans modules and a contract (`contracts.ts` §5 mirror), so it
is a branch, fast-forwarded to `main` at the end. Commit at every task, staged by explicit path.

## Global Constraints

- `src/contracts.ts` mirrors `docs/specs/2026-10-24-contracts.md` declaration for declaration: the
  `capture` reply change moves with `src/contracts.ts` and the spec in **one** commit (Task 3).
- Perception is untouched: frames stay 1920×1080 and every perceiver's measured rects and templates
  stay as they are. No second perception profile in this plan.
- The channel is **versioned**: an older child and a newer World must refuse each other. A refusal is a
  value (`capture-unavailable`), never a throw into the loop.
- The reader must never be handed a torn frame. A slot that changes under the copy is retried **once**
  and then refused (`stale-frame`) — the seqlock is the contract, not an optimisation.
- The supervisor restarts at most once per session by default and always reports it; a session is
  never ended by a capture failure alone (that is the point of the module).
- Every command runs through `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "<command>"`; the
  full suite at the end of the plan and before the fast-forward.

## File Structure

| file | responsibility |
| --- | --- |
| `src/engine/vision/frame-channel.ts` | the layout, the seqlock, `publish`/`latest`, staleness; pure over a `Buffer` |
| `src/engine/vision/channel-mapping.ts` | koffi `CreateFileMapping`/`MapViewOfFile`; open-or-create the named mapping |
| `src/engine/vision/capture-host.ts` | spawn/stop/restart the child; health; `engineProblem` reports |
| `src/engine/vision/frame-source.ts` | the World's `FrameSource`: `capture`, `captureBand`, `snapshot` |
| `src/engine/child.mjs` (changed) | capture and publish; delete the encoder worker and the JPEG payload |
| `src/engine/win32.ts` (changed) | the `Win32FrameSource`'s decode path and `captureBand` hand over to the channel |
| `src/main.ts` (changed) | build the capture host and frame source; wire the restarts' report |
| `tests/vision-frame-channel.test.ts` | layout, publish/latest, torn read, staleness |
| `tests/vision-channel-mapping.test.ts` | the real mapping on Windows; skip elsewhere |
| `tests/vision-frame-source.test.ts` | Frames from a channel, the band, the snapshot |
| `tests/vision-capture-host.test.ts` | spawn, kill, restart, cap, report |

## Decisions the plan fixes

- **Two slots.** One is being written while the other is read; 2 × 8.3 MB ≈ 17 MB.
- **`toRgba()` copies (2 ms).** Zero-copy views would let the writer overwrite a frame a perceiver is
  still reading; the copy is the safety, and it is cheap.
- **`snapshot` encodes in the World with jpeg-js.** Snapshots are rare (escalations, the QTE record
  path); 174 ms is fine there, and the native encoder disappears with the crash.
- **The child keeps input.** The restart only costs frames, not the ability to send commands.
- **Rollback is the branch.** No dual backend: the JPEG path is deleted only after the live acceptance
  (Task 8), and the branch can be dropped before then.

## Review Focus

1. **The seqlock** — a slot mutated during the copy must be refused, and the test must force it
   (write `seq`, mutate the payload, assert the refuse). A frame a perceiver reads is never torn.
2. **The startup race** — the World may open the channel before the child creates it; the host must
   open-or-create and treat "no publisher yet" as `no-frame`, not an error.
3. **A dead child's mapping** — after a restart the mapping is reused; a stale slot must age out by
   `capturedAt`, and the host must not hand the World the dead child's last frame twice.
4. **Input during a restart** — a command in flight when the child dies must fail as a value and be
   retried by the World's normal loop, not wedge the protocol.
5. **Snapshot parity** — the escalation snapshot must keep the same size/format the escalation path
   reads today (the World re-encodes from the frame it already holds).

## Tasks

> **Status 2026-11-07:** Tasks 1 and 2 are done on `feat/vision-module` (`f14b376`, the mapping
> commit) with the TDD loop: each test was watched red (missing module) before the module was written.
> The channel now runs over a byte adapter (`ChannelMemory`), so the same logic is proven on a Buffer
> and on the real Win32 mapping.

### Task 1 — The channel's layout and seqlock (pure)

- [x] Write `tests/vision-frame-channel.test.ts`: a `Buffer`-backed channel; publish two frames, take
      the latest, assert the payload; force a torn read (advance `seq` between the reader's two reads)
      and assert the refuse; advance `capturedAt` and assert the staleness refusal past
      `CHANNEL_STALE_MS = 300`; a version mismatch refuses.
- [x] Implement `src/engine/vision/frame-channel.ts`: `layoutChannel({ width, height, slots })`,
      `createChannel(buffer)`, `publish(channel, bgra, { capturedAtMs })`, `latest(channel, { nowMs })`,
      constants for the header/slot offsets. Pure; no I/O.
- [ ] `vitest run tests/vision-frame-channel.test.ts`; `tsc --noEmit`.
- [ ] Commit: `feat(vision): the frame channel's layout and seqlock`.

### Task 2 — The named mapping over koffi

- [x] `tests/vision-channel-mapping.test.ts` (Windows-only, `skipIf`): create a mapping, write a frame
      from one handle, read it from a second handle to the same name, assert the payload and the
      version; a wrong size refuses.
- [x] Implement `src/engine/vision/channel-mapping.ts`: `openMapping(name, bytes)` via
      `CreateFileMapping`/`MapViewOfFile` (koffi), returning the `Buffer` over the mapped view; a
      `close()`.
- [ ] Commit: `feat(vision): the shared-memory mapping`.

### Task 3 — The child publishes; the contract's capture reply loses its JPEG

- [x] Change `src/contracts.ts` + `docs/specs/2026-10-24-contracts.md` §5: the `capture` reply carries
      `{ seq, capturedAt, width, height }` and no `jpeg`; the channel carries the pixels.
- [x] `src/engine/child.mjs`: the capture worker writes each frame to the mapping (opened from the
      channel name in its argv, created by the host) and the protocol replies the metadata; delete the
      encoder worker and the JPEG payload. Input commands unchanged.
- [x] Update `tests/engine-child-snapshot.test.ts` and the warm-up test to the new reply; the fake
      Win32 loader keeps producing its 192×108 frame, which the test reads from the channel.
- [x] Commit: `feat(vision): the child publishes frames, not JPEGs`.

### Task 4 — The World's FrameSource over the channel

- [x] `tests/vision-frame-source.test.ts`: a channel-backed source returns a `Frame` whose
      `toRgba()` matches the written BGRA; `captureBand(rect)` matches the rectangle; a stale slot
      refuses as `stale-frame`.
- [x] Implement the FrameSource over the channel in `src/engine/win32.ts` (`Win32Capture`, the file
      the task's brief names); point `main.ts` at it. `win32.ts`'s decode path and `decodeJpeg`
      fallback are removed from this path.
- [x] Commit: `feat(vision): the World reads frames from the channel`.

### Task 5 — Snapshots encoded in the World

- [x] `tests/vision-frame-source.test.ts` (`snapshot`): a JPEG is produced at `maxWidth`, decodable by
      jpeg-js, and its size/format match the escalation path's expectations.
- [x] Implement `captureJpeg(source, channel, maxWidth?, quality?)` in `win32.ts` with jpeg-js
      (scaleBgra downscale + encode); the escalation call sites read it unchanged.
- [x] Commit: `feat(vision): snapshots are encoded on demand, in the World`.

### Task 6 — The capture host and its supervisor

- [ ] `tests/vision-capture-host.test.ts`: spawn a scripted child, kill it, assert the restart and the
      `engineProblem` report; a second death past the cap reports `capture-unavailable` and the
      session keeps running; a heartbeat that stops restarts.
- [ ] Implement `src/engine/vision/capture-host.ts`; wire it in `main.ts`; the World's loop no longer
      ends a session on `stale-frame` alone.
- [ ] Commit: `feat(vision): a supervisor for the capture child`.

### Task 7 — The QTE band read without a decoder

- [x] Extend `actions/qte.ts`'s sampler to `captureBand` from the channel; the test drives the
      sampler with a channel-backed fake and asserts the band pixels are the cropped BGRA.
- [x] Commit: `feat(vision): the QTE band is a raw rectangle`.

### Task 8 — Delete the old path, prove it live

- [ ] Delete `src/engine/jpeg-worker.mjs`, the encoder in `gdiplus.mjs`, and every remaining JPEG reply
      in the child and the client.
- [ ] Update `docs/status.md`, the contracts spec, and the guides.
- [ ] Full suite; `tsc --noEmit`; a three-cycle farm run (the acceptance in the spec); one live kill of
      the child mid-run with the restart observed.
- [ ] Commit: `feat(vision): the encoder leaves the loop`; fast-forward `feat/vision-module` to `main`.

## Acceptance (the plan is done when)

1. The three-cycle farm runs with no encoder in the loop and `engineProblem` silent for the capture.
2. A killed child is restarted live, the run continues, and the report names it.
3. The QTE band is raw; the QTE log line's sampling cost is lower than the JPEG-era line.
4. Full suite green, `tsc` clean, the encoder code deleted, the contract and its spec mirrored.
