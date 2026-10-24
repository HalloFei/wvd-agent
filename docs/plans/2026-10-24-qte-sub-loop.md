# QTE timing loop — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one QTE bar sample cheap (a cropped capture through contracts §5) and give `planTap` its caller (a sub-loop that times one press on the bar).

**Architecture:** The crop is applied in the engine child's encoder thread, before encoding, because the JPEG is the transport and cropping after the decode spends the decode. The rectangle is owned by the chest perceiver (`qteWindow`), which also learns to read its own crop, so `parseQte` keeps one set of refusals and one coordinate space. A new `src/actions/qte.ts` drives the sub-loop over `FrameSource` + `parseQte` + an injected press, and `world.ts` hands it control whenever the screen is `chest-qte`.

**Tech Stack:** TypeScript (World), plain ESM `.mjs` (engine child, its workers, the wire codec), vitest, Koffi/native GDI+ for decode and encode.

**Spec:** [`docs/specs/2026-10-24-qte-sub-loop-design.md`](../specs/2026-10-24-qte-sub-loop-design.md) — read it with this plan.

## Global Constraints

- Contracts §5 is binding. `src/contracts.ts` and `docs/specs/2026-10-24-contracts.md` change in the same commit, declaration for declaration.
- §0 rule 7: one `capture()` or `observe()` finishes inside half a tick — 50 ms at the default 100 ms.
- §0 rule 5: dimensions come from the frame. The crop rectangle is in device pixels of the window's client area.
- §0 rule 6: failure is a value. No module throws across a boundary.
- `qteMinWindowMs` stays **150**; `qteDecelPxPerS2` stays **3000**. Neither is retuned by this plan.
- `parseQte` refuses any frame that is not 1920×1080 — that refusal stays, and the crop path adds its own size gate instead of relaxing this one.
- Commit at every milestone, staged by explicit path.
- The engine child and its workers are plain ESM: no TypeScript import may enter `src/engine/*.mjs`.

## Review Focus

Inputs and conditions the spec implies but no single task's happy-path test covers; each has a test in the task named beside it.

1. **A rect that no longer fits the window** (resized or un-maximised between computing `qteWindow` and the capture) — expect a named refusal, never a shifted parse. Task 3.
2. **A child that ignores `crop`** and answers with the native frame — expect the World to notice from the echoed rect and refuse the band parse rather than read bar geometry off a full frame. Task 5.
3. **A bar that is gone by the time the crop arrives** (loot, combat, a mimic) — expect `no-bar` to end the sub-loop with no press. Task 6.
4. **A QTE on a non-1080p frame** — expect `unsupported-size`, no press, and the tick to keep waiting. Task 4.
5. **A second entry into the sub-loop on a bar already resolved** — expect the dimmed button to stop the press, not the screen transition. Task 6.

---

### Task 1: The pure crop

**Files:**
- Create: `src/engine/crop.mjs`
- Create: `src/engine/crop.d.mts` — the TypeScript declaration, in the style of `scale.d.mts`: the test imports the `.mjs` and `tsc` refuses a consumed `.mjs` without one
- Test: `tests/engine-crop.test.ts`

**Interfaces:**
- Produces: `cropBgra(bgra, width, height, rect) → { pixels: Uint8Array, width: number, height: number }`; throws `RangeError` when `rect` is not four integers, is not positive, or does not fit `width`×`height`. A rect that covers the whole frame returns the input buffer uncopied.

- [ ] **Step 1: Write the failing test**

```ts
// tests/engine-crop.test.ts
import { describe, expect, it } from 'vitest';
import { cropBgra } from '../src/engine/crop.mjs';

// BGRA quadrants, as the capture worker produces them: blue TL, red TR, green BL, yellow BR.
function quadrants(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const colours = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
      data.set([...colour, 255], (y * width + x) * 4);
    }
  }
  return data;
}

describe('cropBgra', () => {
  it('copies exactly the rectangle, row by row, at the right stride', () => {
    const source = quadrants(192, 108);
    const cropped = cropBgra(source, 192, 108, { x: 96, y: 54, width: 96, height: 54 });
    expect(cropped.width).toBe(96);
    expect(cropped.height).toBe(54);
    expect(cropped.pixels).toHaveLength(96 * 54 * 4);
    // the bottom-right quadrant is yellow everywhere
    for (let offset = 0; offset < cropped.pixels.length; offset += 4) {
      expect([...cropped.pixels.subarray(offset, offset + 4)]).toEqual([0, 255, 255, 255]);
    }
  });

  it('returns the source buffer when the rect is the whole frame', () => {
    const source = quadrants(192, 108);
    const cropped = cropBgra(source, 192, 108, { x: 0, y: 0, width: 192, height: 108 });
    expect(cropped.pixels).toBe(source);
  });

  it.each([
    ['past the right edge', { x: 100, y: 0, width: 100, height: 10 }],
    ['past the bottom edge', { x: 0, y: 100, width: 10, height: 100 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 10 }],
    ['negative origin', { x: -1, y: 0, width: 10, height: 10 }],
    ['fractional', { x: 0.5, y: 0, width: 10, height: 10 }],
  ])('refuses a rect %s', (_label, rect) => {
    expect(() => cropBgra(quadrants(192, 108), 192, 108, rect as never)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine-crop.test.ts`
Expected: FAIL — `Failed to resolve import "../src/engine/crop.mjs"`.

- [ ] **Step 3: Implement `cropBgra` in `src/engine/crop.mjs`**

Module header: it is the `capture { crop }` counterpart of `scale.mjs` — pure arithmetic over a top-down BGRA buffer, no window, no native call. Validate the rect (four finite integers, positive size, `x + width <= width`, `y + height <= height`) and throw `RangeError` naming the field that failed, the way `scale.mjs:17-29` does. When the rect is the whole frame, return `{ pixels: bgra, width, height }` with the same buffer, as `scaleBgra` does at `scale.mjs:42`. Otherwise copy row by row into one `Uint8Array(width * height * 4)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/engine-crop.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/crop.mjs tests/engine-crop.test.ts
git commit -m "feat(engine): crop a BGRA frame to a rectangle"
```

---

### Task 2: The wire — `capture { crop }` and the rectangle echoed back

**Files:**
- Modify: `src/contracts.ts:115-130` (§5 `PixelRect`, `EngineCapture`, `EngineRequest`)
- Modify: `docs/specs/2026-10-24-contracts.md` §5
- Modify: `src/engine/protocol.mjs:80-95` (the `capture` case of `decodeRequest`)
- Test: `tests/engine.test.ts`

**Interfaces:**
- Produces: `PixelRect { readonly x, y, width, height: number }` in `src/contracts.ts`; `EngineRequest` gains `crop?: PixelRect` on `capture`; `EngineCapture` gains `readonly crop?: PixelRect` — the rectangle the child actually cropped, absent when it sent the whole frame.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `tests/engine.test.ts`, beside the existing `maxWidth` codec tests (`tests/engine.test.ts:68-84`):

```ts
it('carries a crop rectangle on capture and drops a malformed one', () => {
  const line = encodeRequest(9, { op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } });
  expect(decodeLine(line)).toEqual({
    request: { id: 9, request: { op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } } },
  });
});

it.each([
  ['a missing field', { x: 0, y: 0, width: 10 }],
  ['a fractional value', { x: 0, y: 0, width: 10.5, height: 10 }],
  ['a negative origin', { x: -1, y: 0, width: 10, height: 10 }],
  ['a zero size', { x: 0, y: 0, width: 0, height: 10 }],
  ['a non-object', 42],
])('refuses a crop with %s', (_label, crop) => {
  expect(decodeLine(JSON.stringify({ id: 3, request: { op: 'capture', crop } }))).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine.test.ts -t "crop"`
Expected: FAIL — the first case decodes to `{ op: 'capture' }` (the field is dropped), and the malformed cases decode to a request instead of `null`.

- [ ] **Step 3: Add `PixelRect`, extend §5, and decode the rectangle**

In `src/contracts.ts`, declare `PixelRect` above `EngineCapture` with a comment saying it is client device pixels, that the origin is the window's client top-left, and that a crop must lie inside the frame — the child refuses one that does not. Add `crop?: PixelRect` to `EngineCapture` (the rectangle actually cropped) and to the `capture` member of `EngineRequest`. Mirror every line into `docs/specs/2026-10-24-contracts.md` §5, including one sentence of why: a QTE sample is the bar's own rectangle, and cropping before the encode is what makes the sample cheap.

In `protocol.mjs`, in the `capture` case: build `{ op: 'capture' }`, attach `maxWidth` when present (present behaviour), attach `crop` when present. A `crop` that is not an object, or any of its four fields not a finite integer, or a size `< 1`, or a negative origin, makes the whole request malformed — return `null`, the codec's existing convention (`protocol.mjs:28-40`). Do not clamp: the frame bound is not knowable here, and the child owns that check.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts src/engine/protocol.mjs docs/specs/2026-10-24-contracts.md tests/engine.test.ts
git commit -m "feat(contracts): capture a rectangle instead of a frame (§5)"
```

---

### Task 3: The child serves the crop

**Files:**
- Modify: `src/engine/snapshot.mjs` (the frame-variant request queue)
- Modify: `src/engine/jpeg-worker.mjs:80-129` (encode the crop, reply)
- Modify: `src/engine/child.mjs:188-213` (dispatch `capture { crop }`)
- Test: `tests/engine-snapshot-queue.test.ts`, `tests/engine-child-snapshot.test.ts`

**Interfaces:**
- Consumes: `PixelRect`, the `capture` request shape from Task 2; `cropBgra` from Task 1.
- Produces: the `capture` reply's value gains `crop: PixelRect` when the child cropped. The directive on the child↔encoder port becomes `{ op: 'snapshot', snapshotId, maxWidth? , crop? }` — the queue and its timeout/cancel semantics are unchanged.

- [ ] **Step 1: Write the failing tests**

In `tests/engine-snapshot-queue.test.ts` (which drives `createSnapshotRequests` with a fake encoder, no workers):

```ts
it('carries a crop directive and settles with the rectangle the encoder used', async () => {
  const sent: unknown[] = [];
  const requests = createSnapshotRequests({ send: (m) => sent.push(m), timeoutMs: 50 });
  const pending = requests.requestVariant({ crop: { x: 4, y: 6, width: 8, height: 10 } });
  expect(sent[0]).toMatchObject({ op: 'snapshot', crop: { x: 4, y: 6, width: 8, height: 10 } });
  const id = (sent[0] as { snapshotId: number }).snapshotId;
  requests.settle({ kind: 'snapshot', snapshotId: id, jpeg: new Uint8Array(), width: 8, height: 10, seq: 0, capturedAt: 0, crop: { x: 4, y: 6, width: 8, height: 10 } });
  await expect(pending).resolves.toMatchObject({ width: 8, height: 10, crop: { x: 4, y: 6, width: 8, height: 10 } });
});
```

In `tests/engine-child-snapshot.test.ts`, in the existing `describe`, after the `maxWidth` case (the fake window is a 192×108 BGRA quadrant frame — `tests/fixtures/fake-win32-native.mjs:50-65`):

```ts
it.skipIf(process.platform !== 'win32')('serves a crop and nothing else', async () => {
  const child = spawn(process.execPath, ['--import', LOADER, CHILD, '--title=__wvd_fake_window__', '--hotkey='], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const engine = connectEngine(child, { timeoutMs: 15000, logger: () => {} });
  try {
    await engine.request({ op: 'capture' }); // warm the render threads
    const reply = await engine.request({ op: 'capture', crop: { x: 96, y: 54, width: 96, height: 54 } });
    expect(reply).toMatchObject({ ok: true });
    const value = (reply as { value: { jpeg: string; width: number; height: number; crop: unknown } }).value;
    expect(value.width).toBe(96);
    expect(value.height).toBe(54);
    expect(value.crop).toEqual({ x: 96, y: 54, width: 96, height: 54 });
    // the bottom-right quadrant is yellow; JPEG is lossy, so allow ±3 per channel
    const decoded = jpeg.decode(Buffer.from(value.jpeg, 'base64'), { useTArray: true, formatAsRGBA: true });
    const at = ((27 * 96) + 48) * 4;
    expect(Math.abs(decoded.data[at] - 255)).toBeLessThanOrEqual(3);     // R
    expect(Math.abs(decoded.data[at + 1] - 255)).toBeLessThanOrEqual(3); // G
    expect(Math.abs(decoded.data[at + 2] - 0)).toBeLessThanOrEqual(3);   // B
  } finally {
    engine.close();
  }
});

it.skipIf(process.platform !== 'win32')('refuses a crop that does not fit the frame', async () => {
  // same spawn boilerplate
  const reply = await engine.request({ op: 'capture', crop: { x: 100, y: 0, width: 100, height: 10 } });
  expect(reply).toMatchObject({ ok: false, error: 'rejected', detail: 'crop-out-of-frame' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine-snapshot-queue.test.ts tests/engine-child-snapshot.test.ts`
Expected: FAIL — `requests.requestVariant` is not a function, and the child answers the crop request with the native 192×108 frame.

- [ ] **Step 3: Implement the queue, the crop, and the dispatch**

`snapshot.mjs`: keep the file named for the snapshot it was written for, and state in its header that it now serves any per-frame variant request (a downscaled snapshot or a cropped frame) by id. Add `requestVariant(variant)` — the same body as `request(maxWidth)` (`snapshot.mjs:48-59`) but sending `{ op: 'snapshot', snapshotId, ...variant }` — and make `request(maxWidth)` delegate to it with `{ maxWidth }`. `settle` (`snapshot.mjs:62-73`) passes `crop` through when the encoder sent one.

`jpeg-worker.mjs`: the directive handler (`jpeg-worker.mjs:81-88`) queues `{ snapshotId, maxWidth, crop }`. At `jpeg-worker.mjs:102-129`, when the queued request carries `crop`, produce the pixels with `cropBgra(bgra, width, height, request.crop)` and encode that; otherwise scale as today. Post the reply with `crop` included for the crop case. A crop that `cropBgra` rejects becomes `{ kind: 'snapshot-problem', snapshotId, detail: 'crop-out-of-frame' }` — the existing failure channel.

`child.mjs`: in the `capture` case, before answering, if `request.crop` is present check it against `latest.width`/`latest.height` and throw `new EngineFailure('rejected', 'crop-out-of-frame')` when it does not fit; then await `snapshots.requestVariant({ crop: request.crop })` and reply with the frame's `jpeg`/`width`/`height` plus `crop`. A `SnapshotFailed` here is not recoverable by sending the native frame — a caller that asked for a band cannot parse a full frame — so turn it into `rejected` with the failure's detail rather than an oversized reply. Keep the `maxWidth` branch as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine-snapshot-queue.test.ts tests/engine-child-snapshot.test.ts tests/engine-snapshot.test.ts`
Expected: PASS, all three files — the existing snapshot cases must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/engine/snapshot.mjs src/engine/jpeg-worker.mjs src/engine/child.mjs tests/engine-snapshot-queue.test.ts tests/engine-child-snapshot.test.ts
git commit -m "feat(engine): crop the next frame before encoding it"
```

---

### Task 4: The perceiver owns the rectangle, and can read its own crop

**Files:**
- Modify: `src/perception/chest.ts:45-59` (geometry), `:223-298` (`parseQte`/`parseImage`), `:534-585` (`readButton`), and the band scanner beside `:345`
- Test: `tests/qte.test.ts`

**Interfaces:**
- Consumes: `PixelRect` from Task 2; `cropBgra` from Task 1 (tests only).
- Produces: `qteWindow(frame: { width: number; height: number }): PixelRect` — x 645, y 36, width 631, height 699 at 1920×1080, scaled by the frame's fractions. `parseQte(frame, previousMarkerX?, origin?: Point)` — with `origin`, the frame must be exactly the crop at `origin` (`frame.width === qteWindow(...).width`), and every number it returns is in full-frame coordinates.

- [ ] **Step 1: Write the failing tests**

In `tests/qte.test.ts`:

```ts
it('returns the same QteState from a crop as from the full frame', async () => {
  for (let index = 0; index < MARKER_X.length; index += 1) {   // the six stills the file already loads
    const name = `frame-${index}.jpg`;
    const full = await jpegFrame(name, 1_000, FIXTURES);
    const fromFull = await parseQte(full);
    const rect = qteWindow(full);
    const origin = { x: rect.x, y: rect.y };
    const cropped = await cropOf(full, rect);     // decode once, cropBgra, re-encode as a Frame
    const fromCrop = await parseQte(cropped, undefined, origin);
    expect(fromCrop).toEqual(fromFull);
  }
});

it('refuses a crop whose size is not the QTE window', async () => {
  const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
  const cropped = await cropOf(full, { x: 645, y: 36, width: 631, height: 400 });
  expect(await parseQte(cropped, undefined, { x: 645, y: 36 })).toEqual({
    ok: false,
    reason: 'unsupported-size',
  });
});

it('refuses the full frame when asked to read it as a crop', async () => {
  const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
  expect(await parseQte(full, undefined, { x: 0, y: 0 })).toEqual({ ok: false, reason: 'unsupported-size' });
});

it('keeps refusing a non-1080p full frame', async () => {
  const full = await jpegFrame('frame-0.jpg', 1_000, FIXTURES);
  const cropped = await cropOf(full, { x: 0, y: 0, width: 1280, height: 720 });
  expect(await parseQte(cropped)).toEqual({ ok: false, reason: 'unsupported-size' });
});
```

`cropOf` is a local helper in the test file: `toRgba()`, `cropBgra`, then a `Frame` whose `toRgba()` returns the crop and whose `width`/`height` are the rect's.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/qte.test.ts -t "crop"`
Expected: FAIL — `qteWindow` is not exported, and `parseQte` ignores the third argument.

- [ ] **Step 3: Implement `qteWindow` and the origin**

Replace the scattered fractions with one exported `qteWindow`: x from `BAR_X0_FRACTION`, width to `BAR_X1_FRACTION`, y from `BAND_Y0_FRACTION`, height to the button anchor plus `BUTTON_ANNULUS_OUTER` (`y = round(0.613·H) + 72`). State in its doc comment why the rectangle includes the button — one rectangle means one parser and one set of refusals — and that it is 631×699 = 21.3 % of a 1080p frame.

`parseQte(frame, previousMarkerX?, origin?)`: with no `origin`, keep the `REFERENCE_WIDTH`/`REFERENCE_HEIGHT` gate exactly as it is (`chest.ts:226-228`). With an `origin`, require `frame.width`/`frame.height` to equal `qteWindow(reference)` and set a local offset. `scanBand` and `readButton` take that offset so `x0` and the anchor `y` become local, and every absolute column the parser reports adds it back. No other rule moves: same thresholds, same refusals, same confidence terms.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/qte.test.ts`
Expected: PASS, the whole file — including the 199-frame parse count that the existing tests assert.

- [ ] **Step 5: Commit**

```bash
git add src/perception/chest.ts tests/qte.test.ts
git commit -m "feat(chest): own the QTE rectangle and read it from a crop"
```

---

### Task 5: The World-side source can ask for a band

**Files:**
- Modify: `src/contracts.ts` §1 (`FrameSource`), `docs/specs/2026-10-24-contracts.md` §1
- Modify: `src/engine/win32.ts:102-124` (`Win32Capture`)
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `PixelRect` (Task 2), the child's echoed `crop` (Task 3).
- Produces: `FrameSource.captureBand?(rect: PixelRect): Promise<Frame>` — the `Frame` is the crop, its `width`/`height` are the rect's, and its `atMs` is stamped the same way `capture()` stamps one. `Win32Capture` implements it.

- [ ] **Step 1: Write the failing test**

In `tests/engine.test.ts`, using the file's existing `FakeEngine`:

```ts
it('asks for a band and refuses a reply that is not the band it asked for', async () => {
  const engine = new FakeEngine({
    id: 1,
    ok: true,
    value: { jpeg: Buffer.from([0xff, 0xd8]).toString('base64'), width: 1920, height: 1080, ageMs: 4 },
  });
  const source = new Win32Capture(engine, { decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) });
  await expect(source.captureBand({ x: 645, y: 36, width: 631, height: 699 })).rejects.toMatchObject({
    reason: 'unavailable',
    detail: 'malformed-capture',
  });
});

it('returns the band when the child echoes the rectangle', async () => {
  const engine = new FakeEngine({
    id: 1,
    ok: true,
    value: {
      jpeg: Buffer.from([0xff, 0xd8]).toString('base64'),
      width: 631,
      height: 699,
      ageMs: 4,
      crop: { x: 645, y: 36, width: 631, height: 699 },
    },
  });
  const source = new Win32Capture(engine, { decode: () => ({ data: new Uint8Array(4), width: 1, height: 1 }) });
  const frame = await source.captureBand({ x: 645, y: 36, width: 631, height: 699 });
  expect(frame.width).toBe(631);
  expect(frame.height).toBe(699);
  expect(engine.seen[0]).toEqual({ op: 'capture', crop: { x: 645, y: 36, width: 631, height: 699 } });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/engine.test.ts -t "band"`
Expected: FAIL — `source.captureBand` is not a function.

- [ ] **Step 3: Implement `captureBand` and declare it**

`captureBand(rect)` sends `{ op: 'capture', crop: rect }`, then validates the reply through a new internal helper that requires the echoed `crop` to be present **and equal** to the rect, plus `width`/`height` equal to the rect's; anything else is an `EngineCaptureError('unavailable', 'malformed-capture')` — that is Review Focus 2, a child that silently sent a full frame. Then build the `Frame` exactly as `capture()` does, sharing the body with it (a private `frameFrom(reply)`), so `atMs`, the stale-frame rule and the lazy decode cannot drift apart. The rect is refused before the wire when it is not four integers with positive size — the codec would drop the line and the World would wait out `engineTimeoutMs`.

`contracts.ts` §1: add the optional method with a comment that a source without it keeps working and the sub-loop falls back to `capture()`. Mirror into contracts §1.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/engine.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts src/engine/win32.ts docs/specs/2026-10-24-contracts.md tests/engine.test.ts
git commit -m "feat(engine): FrameSource.captureBand (§1)"
```

---

### Task 6: The sub-loop — `timeQte`

**Files:**
- Create: `src/actions/qte.ts`
- Test: `tests/qte-loop.test.ts`

**Interfaces:**
- Consumes: `planTap`, `qteVelocity` (`src/policy/qte.ts`), `parseQte` + `qteWindow` (Task 4), `FrameSource.captureBand?` (Task 5), `Actuator`-free: the press arrives as a callback.
- Produces:

```ts
export type QteRefusal =
  | 'bar-gone'          // a sample refused: the QTE screen is not there any more
  | 'resolved'          // the 解除 button reads dimmed: this pass was already answered
  | 'no-velocity'       // samples came, but no three spanned a steady 66 ms before the budget ran out
  | 'no-reachable-zone' // no zone centre can be reached in the current pass, inside the horizon
  | 'budget-spent'      // the bar outlived `budgetMs`
  | 'press-refused';    // the actuator declined the press (not foreground, engine gone)

export interface QteTiming {
  readonly ok: true;
  readonly v: number;         // px/s, signed
  readonly atMs: number;      // the delay planTap asked for, from the sample that produced it
  readonly target: number;    // the zone centre the plan aimed at
  readonly tapX: number;      // the marker's position on the planning sample
  readonly restX: number | null; // where it parked, when the bar was still there to read
}
export type QteOutcome = QteTiming | { readonly ok: false; readonly reason: QteRefusal };

export interface QteTimingOptions {
  readonly source: FrameSource;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly press: () => Promise<ActionResult>;
  readonly latencyMs: number;
  readonly decelPxPerS2: number;
  readonly minWindowMs: number;
  readonly budgetMs: number;
}

export function timeQte(options: QteTimingOptions): Promise<QteOutcome>;
```

- [ ] **Step 1: Write the failing tests**

`tests/qte-loop.test.ts`, with a fake source that returns scripted frames (each frame's `toRgba()` returns a rendered bar at the scripted marker x) and a fake `wait` that advances a virtual clock:

```ts
it('presses once, at the instant the plan named, and reports the fit sample', async () => {
  // marker 20 px per 33 ms → 606 px/s; the left zone centre is 694+114 = 808
  const clock = virtualClock(0);
  const source = bandSource([
    { atMs: 0, markerX: 700 },
    { atMs: 33, markerX: 720 },
    { atMs: 66, markerX: 740 },
    { atMs: 400, markerX: 900 },   // the rest read
  ], clock);
  const presses: number[] = [];
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => { presses.push(clock.now()); return { ok: true }; },
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.v).toBeCloseTo(606, 0);
  expect(presses).toHaveLength(1);
  expect(presses[0]).toBeCloseTo(66 + out.atMs, 0);   // the sample's clock plus the plan's delay
  expect(out.restX).not.toBeNull();
});

it('does not press when the plan is shorter than the minimum window, and presses on the next pass', async () => {
  // The marker sits 6 px short of the left zone centre at 606 px/s: the plan is ~10 ms, under the
  // 150 ms floor, so the first opportunity must be refused and nothing pressed.
  const clock = virtualClock(0);
  const source = bandSource([
    { atMs: 0, markerX: 700 },
    { atMs: 33, markerX: 720 },
    { atMs: 66, markerX: 780 },   // now a real distance away: this plan is over the floor
    { atMs: 400, markerX: 900 },
  ], clock);
  const presses: number[] = [];
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => { presses.push(clock.now()); return { ok: true }; },
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
  });
  expect(out.ok).toBe(true);
  expect(presses).toHaveLength(1);
  // the first plan was refused: the press is later than the first sample's own plan would have been
  expect(presses[0]).toBeGreaterThan(66 + 10);
});

it('stops with bar-gone when a sample refuses', async () => {
  const clock = virtualClock(0);
  const source = bandSource([{ atMs: 0, markerX: 700 }, { atMs: 33, markerX: 720 }, { atMs: 66, noBar: true }], clock);
  const presses: number[] = [];
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => { presses.push(clock.now()); return { ok: true }; },
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
  });
  expect(out).toEqual({ ok: false, reason: 'bar-gone' });
  expect(presses).toHaveLength(0);
});

it('does not press a bar whose 解除 button is dimmed', async () => {
  // Review Focus 5: the loop re-enters on a bar a previous press already answered.
  const clock = virtualClock(0);
  const source = bandSource([
    { atMs: 0, markerX: 700, enabled: false },
    { atMs: 33, markerX: 720, enabled: false },
    { atMs: 66, markerX: 740, enabled: false },
  ], clock);
  const presses: number[] = [];
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => { presses.push(clock.now()); return { ok: true }; },
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
  });
  expect(out).toEqual({ ok: false, reason: 'resolved' });
  expect(presses).toHaveLength(0);
});

it('stops with budget-spent when every plan is unreachable', async () => {
  // The marker never moves toward a zone: `planTap` keeps refusing, the budget runs out.
  const clock = virtualClock(0);
  const source = bandSource(
    Array.from({ length: 40 }, (_, i) => ({ atMs: i * 33, markerX: 700 + (i % 2) })),
    clock,
  );
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => ({ ok: true }),
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 1000,
  });
  expect(out).toEqual({ ok: false, reason: 'budget-spent' });
});

it('does not read a rest position when the press is refused', async () => {
  const clock = virtualClock(0);
  const source = bandSource([
    { atMs: 0, markerX: 700 }, { atMs: 33, markerX: 720 }, { atMs: 66, markerX: 740 },
  ], clock);
  const out = await timeQte({
    source, now: clock.now, wait: clock.wait,
    press: async () => ({ ok: false, reason: 'rejected', detail: 'not-foreground' }),
    latencyMs: 60, decelPxPerS2: 3000, minWindowMs: 150, budgetMs: 4000,
  });
  expect(out).toEqual({ ok: false, reason: 'press-refused' });
});
```

`virtualClock` (a `now`/`wait` pair over a mutable number, where `wait(ms)` advances it), `bandSource` (a `FrameSource` whose `captureBand` serves the scripted sample and whose `capture` serves a full frame) and the one-pixel bar renderer are local helpers in this test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/qte-loop.test.ts`
Expected: FAIL — `Failed to resolve import "../src/actions/qte.ts"`.

- [ ] **Step 3: Implement `timeQte`**

The loop: take a sample (`source.captureBand?.(qteWindow(frame))` when available, else `capture()` — the first full frame supplies the window), `parseQte` it, and keep the last three readings as `QteSample`s. A sample that refuses is `bar-gone`; a sample whose `parseQte` reported `enabled: false` is `resolved` — the button's dimmed state is how the parser separates "the QTE is live" from "this pass is answered" without waiting for the screen to change (`chest.ts:286`, chest spec §8a). `qteVelocity` over three samples; while it is `null`, keep sampling (that is the "walking the first 66 ms" case). With a velocity, `planTap`, then gate on `minWindowMs`: under the floor, drop the sample and re-plan on the next; over it, `await wait(max(0, planDueAt − now()))`, then `press()`. After a successful press, watch for the rest position for up to `REST_READ_MS` (600) by sampling until two consecutive readings agree within 2 px, and report it; a sample that refuses first means the bar vanished — `restX: null`, still `ok`. The whole function stops at `budgetMs` and returns `budget-spent` if nothing was pressed, `no-velocity` if the budget ends with samples but no speed.

Module doc: why this is an action and not a policy (it owns a clock, and the policy is pure), and that `planTap`'s `atMs` is a delay from the sample's `frame.atMs`, not from `now()` — contracts §7's one trap.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/qte-loop.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/actions/qte.ts tests/qte-loop.test.ts
git commit -m "feat(chest): time one QTE press with planTap"
```

---

### Task 7: The World hands the bar to the sub-loop

**Files:**
- Modify: `src/world.ts:776-840` (`#step`), a new private `#timeQte` beside `#execute`, and `WvdWorldOptions` (`world.ts:135-150`)
- Modify: `src/actions/chest.ts` (the disarm key)
- Modify: `src/config.ts:66-69` (defaults) and the schema beside `:154-166`
- Modify: `src/main.ts` (pass the real timer at the composition root)
- Modify: `docs/specs/2026-10-24-contracts.md` §8.4
- Test: `tests/world.test.ts`, `tests/definition.test.ts`, `tests/task-run.test.ts`

**Interfaces:**
- Consumes: `timeQte` and `QteTimingOptions` (Task 6), `pressHoldMs` (existing).
- Produces:
  - `export type QteTimer = (options: QteTimingOptions) => Promise<QteOutcome>`, a new `WvdWorldOptions` member `timing: QteTimer` — dependencies arrive (§0 rule 2), so a test drives the sub-loop without a bar on screen, exactly as it already injects `policy`, `classify` and `commands`.
  - `export const DISARM_SCAN = 0x39` in `src/actions/chest.ts` — Space, measured by the operator (chest spec §3b).
  - Config key `qteSubLoopMs`, integer, default `4000`, owner `chest` — "how long the QTE sub-loop may hold the tick before it gives up".

- [ ] **Step 1: Write the failing tests**

In `tests/world.test.ts`, following `makeWorld` (`tests/world.test.ts:282-355`) — add a `timing` option to it that defaults to a fake the test can script:

```ts
const qteBar: Observation = {
  screen: 'chest-qte',
  atMs: 100,
  confidence: 1,
  qte: { zones: [{ from: 694, to: 922 }, { from: 997, to: 1223 }], markerX: 800, button: { x: 958, y: 662 }, attempts: null },
};

it('times the bar before the policy acts, and presses Space once', async () => {
  const seen: QteTimingOptions[] = [];
  const timing: QteTimer = async (options) => {
    seen.push(options);
    await options.press();                       // the World owns the press
    return { ok: true, v: 606, atMs: 120, target: 808, tapX: 700, restX: 809 };
  };
  const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
  await started(world, host);
  await world.tick();                            // one tick, no auto-tick
  expect(seen).toHaveLength(1);
  expect(seen[0]!.minWindowMs).toBe(WVD_DEFAULTS.qteMinWindowMs);
  expect(seen[0]!.budgetMs).toBe(WVD_DEFAULTS.qteSubLoopMs);
  expect(actuator.calls).toEqual([`key ${DISARM_SCAN} ${WVD_DEFAULTS.pressHoldMs}`]);
});

it('does not press when the sub-loop gives up, and the tick carries on', async () => {
  let calls = 0;
  const timing: QteTimer = async () => {
    calls += 1;
    return { ok: false, reason: 'resolved' };
  };
  const { world, host, actuator } = makeWorld({ observation: qteBar, timing });
  await started(world, host);
  await world.tick();
  expect(actuator.calls).toEqual([]);
  // a resolved pass is not a stop: the tick that follows asks the sub-loop again
  await world.tick();
  expect(calls).toBeGreaterThanOrEqual(2);
});
```

In `tests/definition.test.ts`, add `qteSubLoopMs: 4000` to the defaults object the file already asserts (`tests/definition.test.ts:124`).

In `tests/task-run.test.ts`, beside the existing agreement block (`tests/task-run.test.ts:83-87`):

```ts
it('agrees with the chest module on the disarm key', () => {
  expect(TASK_KEYS.space).toBe(DISARM_SCAN);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/world.test.ts -t "bar"` and `pnpm vitest run tests/definition.test.ts tests/task-run.test.ts`
Expected: FAIL — `timing` is not a `WvdWorldOptions` member (`tsc`/vitest resolve error), no press is ever sent (the route waits, `route.ts:82-84`), and the defaults object lacks the key.

- [ ] **Step 3: Wire it**

`actions/chest.ts`: export `DISARM_SCAN = 0x39`, documented as Space, cited to chest §3b — the disarm is a key, not a click.

`world.ts`: `WvdWorldOptions` gains `readonly timing: QteTimer`. In `#step`, after the perception and the progress book-keeping (**`world.ts:791-804`**) and **before** the policy switch, if `observation.screen === 'chest-qte'`, `await this.#timeQte(session, observation)` and `return` — one command at a time, and the sub-loop is that command this tick. `#timeQte` builds `QteTimingOptions` from `this.#cfg` (`qteLatencyMs`, `qteDecelPxPerS2`, `qteMinWindowMs`, `qteSubLoopMs`), `session.source`, `wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))`, `now: () => this.#now()`, and `press: () => session.actuator.holdKey(DISARM_SCAN, this.#cfg.pressHoldMs)`; it re-checks `this.#running` and `this.#session === session` after the await, exactly as `#step` does at `world.ts:780-789`, and drops the result if the session changed. On `ok` it logs one line with `v`, `atMs`, `target`, `tapX`, `restX` — that line is `qteDecelPxPerS2`'s fit input (task #18) — and on a refusal it logs the reason at `warn`.

`config.ts`: add `qteSubLoopMs: 4000` to the defaults and a schema row beside the other `qte*` keys, described as the sub-loop's budget in milliseconds. Mirror the row into contracts §8.4.

`main.ts`: pass `timing: timeQte` in the `WvdWorld` options, beside `policy`, `classify` and `commands`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/world.test.ts tests/definition.test.ts tests/task-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/world.ts src/actions/chest.ts src/config.ts src/main.ts docs/specs/2026-10-24-contracts.md tests/world.test.ts tests/definition.test.ts tests/task-run.test.ts
git commit -m "feat(world): hand the chest QTE to the timing sub-loop"
```

---

### Task 8: The measured win, on the record

**Files:**
- Modify: `docs/status.md`
- Test: `tests/qte-band.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a decode-cost test that measures a full-frame decode against a band decode of the same still, and a `status.md` line carrying the numbers.

- [ ] **Step 1: Write the failing test**

```ts
// tests/qte-band.test.ts
// The claim the design makes: a QTE sample costs a quarter of a full frame. Measured here on the
// same still, with the native decoder the World uses; skipped where GDI+ is unavailable.
it.skipIf(gdiplusProblem() !== '')('decodes the band in at most a quarter of the full frame', async () => {
  const full = await jpegFrame('frame-3.jpg', 1_000, FIXTURES);
  const bands = Array.from({ length: 20 }, () => cropFrameOf(full, qteWindow(full)));
  const fullMs = await timeDecode(full, 20);
  const bandMs = Math.min(...await Promise.all(bands.map((band) => timeDecode(band, 5))));
  console.log(`full ${fullMs.toFixed(1)} ms, band ${bandMs.toFixed(1)} ms`);
  expect(bandMs).toBeLessThanOrEqual(fullMs / 4);
});
```

- [ ] **Step 2: Run it to see the numbers**

Run: `pnpm vitest run tests/qte-band.test.ts`
Expected: PASS with the two numbers printed. If it fails, the crop is not paying for itself and Task 3/4 need looking at before anything else — do not relax the ratio.

- [ ] **Step 3: Record the numbers**

Add a paragraph to `docs/status.md` under "Round 4": the full-frame decode, the band decode, the ratio, and the resulting sample cost (decode + parse + the 2.5 ms round trip), stating that a QTE sample now fits three-in-one-pass. Say plainly that the 60 fps experiment is still unmeasured and that `qteMinWindowMs` stays 150 until #18.

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: every file green (340 + the new ones), `tsc --noEmit` silent.

- [ ] **Step 5: Commit**

```bash
git add tests/qte-band.test.ts docs/status.md
git commit -m "test(chest): the band decode costs a quarter of the frame"
```
