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

- The legend is live: **L does move the party to a chest** (verified 2026-10-24 night, see §4.4).
  The earlier "L did nothing" was a focus problem — the window was not foreground, so the engine
  refused or the game ignored the key. `G` on the map is 移动至目的地, not close.
- Close the map with `关闭` at about **(961, 1060)**, or `Esc`.

### 4.4 Automove to a chest — **solved**

Two ways, both verified live:

**Fast path — the key (use this).** With the map open, press **L** (移动至宝箱). The map closes and
the party walks to a chest, fighting anything on the way; auto-battle resolves those. Measured
during the night's run: `X:19 Y:21` → `X:11 Y:19` after one `L`, with two encounters fought on the
route. The game chooses the chest — the command means "go to a chest", not "go to the chest I
picked".

**Slow path — pointer mode.** Press **R** first, then click a **black tile**. Black is the road:
the dark cells are walkable floor, the white lines are walls, and a click on anything that is not a
road tile does nothing. The `自动移动` element then appears next to that tile — click it and the map
closes and the party walks. Verified 2026-10-24 night: one click on a dark tile at `(878, 384)` in
`B1F -巨坑-` started the move. Two interactions, and a detector for the element; that is the cost of
choosing a *specific* tile rather than letting `L` choose.

Two facts that bound it:

- **Automove does not cross floors.** It stays on the current floor; stairs and floor changes are
  not reachable through it. To leave, the operator walks out or uses the altar teleporter.
- **Opening the map takes `G` twice** from the 3D view: the first opens the menu (地图 `G`, 调查
  `F`, 切换指针 `Tab`, 返回 `Esc`), the second opens the map.

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
