# WVD live control guide

How to drive Wizardry Variants Daphne (Steam, app 2379740) with this repository: what is built, what
is verified on the live game, the exact UI steps and coordinates, and what is still open. It is a
**guidebook**, not a spec — the binding declarations stay in
[`docs/specs/2026-10-24-contracts.md`](../specs/2026-10-24-contracts.md).

Status recorded 2026-10-24, after a live run from the operator's request. Anything marked **open**
was not reproduced; do not treat it as procedure.

---

## 1. What exists today

| Piece | State | Where |
| --- | --- | --- |
| Engine child: window capture as JPEG, foreground-guarded input, stop hotkey, native decode | **done, verified on the real game** | `src/engine/`, `src/engine/child.mjs` |
| Frame ring | done | `src/frames/ring.ts` |
| Dungeon map reading (`readMap`, `MapPerceiver`) | done | `src/perception/map.ts` |
| Route state machine (`nextIntent`) | done | `src/policy/route.ts` |
| Automove command chain, chest/QTE policy, session lifecycle, the World loop | **not built yet** (Tasks 5, 6, 8, 10) | — |

The World does not run a tick loop yet. Until Task 10 wires it, the engine is driven directly (the
bench below is the reference client), and the in-game steps are performed by hand or by a probe.

## 2. Safety rules (non-negotiable)

- **The farmer owns the machine.** Input reaches the game only when the game window is foreground;
  taking the foreground is announced. Do not click or type into a window you cannot name.
- **Do not start, focus, click or stop the game without an explicit operator request.** Default
  state: idle, hands off.
- **Never send input to UU (UU加速器).** It runs elevated (High integrity, `0x3000`); this tool runs
  Medium (`0x2000`), so Windows blocks synthetic clicks and keys to it (SetCursorPos fails while it
  is foreground). There is no CLI or URI; leave UU alone.
- **Never click an unfamiliar modal.** The glowing altar in a zone opens a teleport menu
  (`移动` → zone names, `归还`, `什么也不做`); choose `什么也不做` to dismiss. Other dialogs may
  spend items or change floors.
- The game window is `WizardryVariantsDaphne`, **1920×1080**, client area = the full window.
  Coordinates below are client device pixels at that size; the engine converts them to screen once
  through `ClientToScreen`.

## 3. Starting the game

1. Start Steam and launch **Wizardry Variants Daphne** (app `2379740`). Launching from the library or
   `steam.exe -applaunch 2379740` both work; Steam is normally already running.
2. The game opens directly into town if a session is remembered; otherwise the title screen shows
   `- Tap to Start -` at about **(960, 924)**.
3. Do **not** drive UU. If the operator wants acceleration, they operate UU themselves.

## 4. The live route as far as it was verified

All coordinates are client pixels at 1920×1080.

### 4.1 Open the world map (from town)

- The parchment-with-pin button at the bottom right, about **(1185, 1023)**, opens the world map.
- The map has locations labelled in Chinese. Zoom: **Q** smaller, **E** larger (the buttons
  `-`/`+` at the bottom also zoom). Panning is **open** — a synthetic left-button drag did not move
  the view in testing; re-test before relying on it.
- **北穿幽冥城** (the FFXI collab dungeon; the operator's "北川" is that name's pinyin) is the
  icy-castle icon on the western continent. Identify it by the icon/label, not a fixed coordinate:
  at the first zoom it sat around **(758, 348)**, after zooming out around **(677, 372)**. Clicking
  it enters a loading screen and then Dungeon Select.

### 4.2 Dungeon Select

The rows, top to bottom, are:

```
入口
第一区-城外-
第二区-城内1F-
第三区-城内2F-
第四区-城内2F深处-      <- the v1 target floor
打开世界地图
```

`第四区-城内2F深处-` is about **(1128, 592)**. Clicking it loads the 3D dungeon.

### 4.3 Open the dungeon map

- Click the **minimap** in the top-right, about **(1826, 120)**, or press **G** (`地图`).
- The map title is the floor name (`第四区-城内2F深处-`), the player's grid position is the
  `X: n  Y: n` readout near the bottom, and the right-hand list is a **key legend**, not buttons:

  | Command | Key |
  | --- | --- |
  | 移动至宝箱 (move to chest) | **L** |
  | 移动至标记 (move to marker) | **Q** |
  | 移动至出口 (move to exit) | **F** |
  | 移动至目的地 (move to destination) | **G** |
  | 切换指针模式 (toggle pointer mode) | **R** |

- **G/Q/E keys do reach the game** (G opened the map, Q/E zoomed the world map). **L did not
  trigger movement on the dungeon map in testing — open.**
- Close the map with the `关闭` button at the bottom, about **(961, 1060)**. Pressing G on the map
  did not close it in testing.

### 4.4 Automove to a chest — **open, the current blocker**

The verified *idea* (navigation spec §3a) is: click a chest tile → a small `自动移动` element
appears beside it → double-click that element → the map closes and the party walks. On this build:

1. **Toggle pointer mode first (R)**. Without it, clicking a map tile did nothing.
2. A click on a map tile/chest icon (the purple orb markers on 第四区) then opened a `自动移动`
   element — but at the **top-left of the map** (about 486–632 × 174–200), not beside the tile.
3. That element did **not** start movement with a single click, the engine's double click
   (2×60 ms), a fast native double-click (12 ms presses, 45 ms gap), or Enter.

Because of this, chest farming could not be exercised. The next person should capture the frames
while performing one automove **by hand**, then fix the detector and the activation gesture. Until
then, treat `自动移动` as an unresponsive control.

### 4.5 What was left running

The last live run left the party in `第四区-城内2F深处-`, 3D view, no chest opened, no zone changed.
The altar teleporter menu was dismissed with `什么也不做` at about **(961, 899)**.

## 5. Driving the engine directly (developers)

The engine child is plain ESM and speaks contracts §5 over stdin/stdout, one JSON object per line.

- `startEngine({ title, hotkey?, jpegQuality? })` spawns `child.mjs` under `process.execPath` with
  `ELECTRON_RUN_AS_NODE=1`; `connectEngine(child, { timeoutMs, logger })` gives `request`, `onEvent`
  and `close`.
- `capture` replies `{ jpeg, width, height, ageMs }`; the frame is served from the child's newest
  frame and `ageMs` is its age on the child's clock. The World stamps
  `atMs = performance.now() - ageMs`.
- `tap`/`key` replies carry `{ inputMs }`, measured from request receipt to the final `SendInput`.
  A foreground miss is `{ ok:false, error:'rejected', detail:'not-foreground' }` and sends nothing.
- `Win32Capture` (World side) decodes the JPEG natively through GDI+ and memoises `toRgba()`;
  `jpeg-js` is the fallback and reports `engineProblem` / `native-decoder-unavailable`.
- Events: `stopHotkey` (the global stop key, default `Ctrl+Alt+W`) and `engineProblem` with a detail
  (`stop-hotkey-unregistered`, `native-encoder-unavailable`, startup stderr).

Commands:

```
pnpm test                 # 67 tests at 2026-10-24
pnpm typecheck
node scripts/bench-engine.mjs --title="WizardryVariantsDaphne" --frames=120
```

`scripts/bench-engine.mjs` measures capture round trip, cadence, age, World-side decode and native
encode, in Node and in Electron-as-Node when it can find Electron. On the live game it measured
(1920×1080, q75): round trip 2.5 / 1.3 ms, cadence ~33 ms (~30 fps), decode 23.4 / 24.3 ms, encode
20.4 / 20.6 ms, ~126 KB frames.

## 6. Open items this run produced

1. **Automove activation** (§4.4): the popup's anchor, pointer-mode prerequisite and the actual
   double-click target need settling against hand-driven frames. Task 5 depends on it.
2. **L gating**: the `移动至宝箱` hotkey was inert while G/Q/E worked; it may require a discovered
   chest, a different mode, or a different key. Verify before wiring the command chain.
3. **Altar teleporter**: a new modal state (`移动` → zones/`归还`/`什么也不做`). The loop must never
   click it blindly; the safe dismissal is `什么也不做`.
4. **Panning** the world map with a synthetic drag is unverified.
5. **UU**: unusable from this session (elevated); acceleration is the operator's manual step.
