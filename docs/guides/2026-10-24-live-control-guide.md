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
| Automove command chain (`openMap`, `automoveToChest`, `automoveToExit`) | done | `src/actions/automove.ts` |
| QTE bar parsing and tap planning (`parseQte`, `planTap`) | done | `src/perception/chest.ts`, `src/policy/qte.ts` |
| Session verdicts (`classify`) | done | `src/policy/session.ts` |
| The 10 Hz loop, the composition root, the escalation to Coo | done | `src/world.ts`, `src/main.ts`, `src/escalation/` |

The World runs a tick loop now, reads the opener panel, and honours `capture { maxWidth }` for the
snapshot it sends the model. This guide stays useful for driving the game **by hand or by a probe**,
and for the two gaps that remain: the heart numeral atlas is partial (0/1/9 only), and `planTap` has no
caller in the loop yet. See `docs/status.md`.

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

## 2a. Starting Coopanion when the harness exports ELECTRON_RUN_AS_NODE

This environment exports `ELECTRON_RUN_AS_NODE=1`, so a plain `pnpm dev` in `Coopanion/` runs Electron
in Node mode and dies on `app.commandLine` being undefined. Launch it as:

    env -u ELECTRON_RUN_AS_NODE pnpm dev

Coopanion then starts as a tray/pet application with **no titled window** — the pet window has no
title, so it cannot be found or captured by title. Left-click the tray icon for the settings window.

**Link the extension from the main checkout, never from a worktree.** The World is loaded from
`Coopanion/build/data/extensions/node_modules/cortico-world-wvd`, and a link to an old worktree loads
old code with no error in the app — the World simply appears with no console. Point it at the
repository root:

    cd Coopanion/build/data/extensions
    pnpm remove cortico-world-wvd
    pnpm add "C:/Personal/game/DeepSeek_Coopanion/wvd-agent"

**No publishing step is needed, and none is involved.** The loader enumerates
`build/data/extensions/package.json` dependencies, resolves each name under
`node_modules/<name>/package.json`, and imports the package's entry — so a `link:` to this checkout is a
first-class install. Publishing only matters for Coopanion's extension store/search. An entry whose
`package.json` cannot be read is dropped **silently** (no `扩展导入失败` warning is logged in that
case), which is what a link pointing at a checkout being rewritten looks like from the app's side: the
World simply does not appear.

The console was verified against the running app on 2026-10-24: `/api/worlds` reports the World's lamp
and badges (`state`, `escalations used/cap`), and the panel answers under
`/api/webui/providers/world%3Awvd/panels/wvd-console/{status,log}` — `status` returns the six-state
snapshot and the exact reason for the current state, `log` the recent transitions.

`pnpm dev` re-stages `build/` on every start; the linked World lives under `build/data/extensions` and
survives it.

## 3. Starting the game

1. Start Steam and launch **Wizardry Variants Daphne** (app `2379740`). The install is at
   `C:\Program Files (x86)\Steam\steamapps\common\Wizardry Variants Daphne\WizardryVariantsDaphne.exe`;
   launching that exe directly works when Steam is already running, and the library or
   `steam.exe -applaunch 2379740` work too. Steam does **not** have to be logged in for the window to
   appear, but the exe will not start without the Steam client running.
2. The first screens are a legal notice (请注意 / 未成年玩家须知) and a title screen; both need a click
   before the game reaches the main menu or the party's last position.
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
road tile does nothing. The `自动移动` element then appears — click it and the map closes and the
party walks. Verified 2026-10-24 night: one click on a dark tile at `(878, 384)` in
`B1F -巨坑-` started the move. Two interactions, and a detector for the element; that is the cost of
choosing a *specific* tile rather than letting `L` choose.

**On the FFXI floors the slow path is the only path (measured 2026-10-24, round 4).** `L` is inert
on 第三区 and 第四区 even when the map reads three chests, so the World does not press it: its
`move` is `R` → the tile → the element. The element sits **79–84 px above the clicked tile** (three
instances) and is clicked blind at that offset; the World converts the route's grid cell to a
screen point with the map's `origin` (`MapState.origin`, contracts §3). `docs/specs/
2026-10-24-navigation-design.md` §3e is the record.

Two facts that bound it:

- **The chest command stays on the floor; the exit command crosses.** `L` never leaves the floor.
  `F` does: pressed on `B1F -巨坑-`, the party walked to the exit and the screen came up
  `B2F -圣堂-` with no further input (observed). Going back *up* is not established.
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

## 6. Open items this guide produced

All four were settled on 2026-10-24 night, and one more was found:

1. **Automove activation** — settled: `G`,`G` opens the map, `L` walks to a chest (see §4.3–§4.4).
   The earlier "L is inert" was a focus problem, not a dead key.
2. **L gating** — settled: `L` works on the map when chest icons exist; on a floor with none it does
   nothing at all, which is correct behaviour to encode rather than retry.
3. **Altar teleporter** — still a modal the loop must never click blindly; `什么也不做` dismisses it.
4. **Panning** the world map — still unverified.
5. **The opener panel** (`由谁打开?`, 陷阱发现/陷阱解除 per member) — captured on 2026-10-24 and parsed;
   the fixture lives in `testdata/chest/2026-10-24-opener/`. The disarm is **Space**, not a click (§3b
   of the chest spec). What remains is the willpower atlas, which knows 0/1/9 only.
5. **UU**: unusable from this session (elevated); acceleration is the operator's manual step.
