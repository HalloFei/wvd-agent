# The UI knowledge base — pages as a directed graph

Measured and designed 2026-11-06, in a live probe session with the operator (1920x1080 client).

## Intent

The World's blind spot is not a screen it misreads — it is a page nobody has named. Two unattended
runs have now been stopped by one (the currency reward, the 记录 menu), and each time the fix was the
same manual work: capture the frame, read it, find the close. The operator's request (2026-11-06):

> treat it as a dag, directed asy graph or tree. save it as knowledge or vector or knowledge base.
> and make it GUI module, so u do understand and learn game. or the wvd world learn the game

and for the probe itself:

> locate a bottom with its name -> tab -> locate sub-page bottoms -> locate exit bottom to homepage or
> previous page, the parent page. like treat it as standard workflow with enter, exit, or other UI

So: a knowledge base of pages and buttons, a graph that can always answer *how do I leave this page*,
and a probe workflow that turns any unnameable frame into one more page.

## Approaches

- **(a) One measured library and perceiver per page** — today's pattern (`inn-library.ts`,
  `harken-library.ts`). Precise, but each new page is a script, a generated module, a perceiver and a
  policy branch; ten pages is ten of each, and the graph stays in nobody's head.
- **(b) One catalog, one generic reader** — pages are data: rows with labels, kinds and points; one
  graph walks exits; later one recogniser matches a page against its own rows. This is the chosen
  shape. (a)'s matching primitives (`sampleRegion`, `StripLibraryReader`) are what the recogniser will
  use — the catalog is what they read.
- **(c) OCR at runtime** — the package has no OCR, the game's font is styled, and adding one would put
  a model or a native dependency in the 10 Hz path. Dropped.

## The model

`src/ui/catalog.ts` — the contract. A `UiPage` is an id, the game's own title, the section it lives in
(`boot` / `town` / `dungeon` / `combat` / `worldmap`; operator: *there can be different sections as
well*), its `rows`, and what was measured. A `UiButton` is a label, a kind, a client-pixel point and,
when it was probed, the page it leads to.

Three kinds, and only three: **enter** opens a sub-page, **exit** returns to the parent (and is the
only kind the graph routes through), **other** spends, claims or destroys — recorded, never pressed.

`src/ui/graph.ts` — the questions the World asks: `exitOf(page)`, `rootOf(catalog, page)`,
`routeToRoot(catalog, page)` (the exit taps, nearest first) and `validateCatalog`. The route is
**advisory**: the World sends one command and re-reads the frame, so a page that closes onto a
different parent than the record expected is still handled — the next observation recomputes.

It is a **graph, not a tree**: 祝福之日 was measured opening over the trader, and a page can be entered
from more than one parent in principle. And it
is **not exhaustive**: an `enter` row without a `child` is a button found and placed whose destination
has not been probed. The validator allows that and refuses a guessed edge anywhere else.

## What was measured (2026-11-06)

Fourteen pages, each with a still under `testdata/screens/2026-11-06-ui/`:

| section | root | pages |
| --- | --- | --- |
| dungeon | 3-D view, HUD icon row | 选项, 记录, 每日任务, 道具一览, 角色页 |
| town | 诺森霍洛村 | 旅店 (service / rooms / confirm), 寺院, 道具店, 交易商, 祝福之日 |

Every exit was **seen to work** (the parent came back): 关闭 on 选项 (960,945), 记录 (960,870) and
道具一览 (960,989); 返回 on 每日任务 (754,1029); 离开 on 道具店 and 寺院 (1162,677) and 交易商
(1162,723); X 关闭 on 祝福之日 (960,866); X 关闭 on 角色页 (699,1012). The inn's three dialogs carry
the 2026-11-06 library measurements.

The 记录 menu — the page that stopped the 99-cycle run (`t-mw4z5ffs-2o0jnp`) — is now a named page
with eight named rows and a measured close. It no longer needs a dedicated fix.

## What this does not yet do

- **No perceiver.** The catalog is knowledge; nothing in the perceiver chain reads it yet. Next
  milestone: sample each row's label band into a library and match a page by two of its rows, exactly
  as the inn does — then one `ui-menu` observation and one World branch that closes what it names.
- **Incomplete coverage.** 打铁铺 and 酒馆 were located but never opened; the options' and records'
  children are placed, not probed; the four outer HUD icons were not pressed at all.
- **Client pixels only.** Every point is 1920x1080, like `heal.ts`; the World runs at that client size.
- **The popup risk.** 祝福之日 opens over the trader (measured). Whether it also opens over the town
  uninvited is unproven: the blurred host behind it looked like both, and the one session could not
  tell them apart. If it does, the rest tap lands on it; the catalog names the page and its close, so
  the World branch above is the fix.

## Provenance

Design record: this file. Contract and graph: `src/ui/catalog.ts`, `src/ui/graph.ts`. Data:
`src/ui/pages.ts`. Proof: `tests/ui-graph.test.ts`. Workflow: the `wvd-ui-probe` skill.
