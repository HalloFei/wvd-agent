# Readers: the primitive every screen's reader shares (2026-11-03)

The operator's rule:

> *a reader. and reader is a primitive module that we need to have. what's the current reader? can we
> reuse it? like the realization and methods it exposes can change... so similar readers can all
> inherit basic reader class. similar attributions, etc. remember modular design idea.*

## The primitive

`src/perception/reader.ts`. A **reader** turns a region of a frame into one typed value:

```ts
interface ReadResult<T> { readonly value: T; readonly confidence: number }
abstract class FrameReader<T> {
  readonly name: string;                                  // which reader answered
  abstract read(image: RgbaImage): ReadResult<T> | null;  // never throws; null is the miss
}
```

Shared by every reader (the "similar attributes"): the frame shape it accepts, the region it reads
(`ReadRegion`, fractions of a 16:9 frame — except the readers whose controls are drawn against the
fixed 1920×1080 client, which say so), the luma rule (`lumaAt`), the patch and correlation helpers
(`lumaPatch`, `correlationAt`), and the answer shape. The **realisation is free**: a glyph template, a
strip against a measured library, an ink count, a structural parse. Changing one must not change its
caller.

`StripLibraryReader` is the first realisation that covers the *learned* case: a fixed band whose
content is a label, matched against a library of measured patches. It is the pattern the harken's floor
rows need and the loot-item database will use — the labels are **learned from frames**, not decoded.

## What exists today, and what each one becomes

The package has readers already; they grew as one perceiver per screen, without the shared base. In
order of what they read:

| today | reads | realisation | on the base |
| --- | --- | --- | --- |
| `match.ts findTemplate` | a glyph anywhere in a band | luma template, normalised correlation | `GlyphReader` (the page's X 关闭 tile, the automove element) |
| `map.ts parseMap` | the minimap: title ink, grid, icon glyphs, player tile | one structural parse over the whole frame | `MapReader` |
| `map.ts titleBarInk` | the centred title's text ink count | a measure (a fact), not a reader | stays a fact |
| `party.ts activePartyMember` | the battle's ACTIVE card | colour measure over the six fixed cards | `PartyReader` |
| `opener.ts` | the chest opener panel | slot cards + willpower read | `OpenerReader` |
| `loot.ts` | the loot card | borders + flat interior + caption + item art | `LootReader` |
| `chest-opening.ts`, `chest.ts`, `prompt.ts`, `dungeon-select.ts`, `location.ts`, `combat.ts`, `hud.ts`, `screens.ts` | their own screens | their own measures | each a reader of the same base |

The **reuse** is real and cheap: those modules already take an `RgbaImage` and answer a typed value or
null. Wrapping them onto `FrameReader` is a per-module refactor that changes no caller — they keep their
exports, and the base adds the shared type, the region helper and the answer shape. It is done
incrementally, as each module is next touched, not as a big-bang rewrite.

## The first new consumer: the harken's floor menu

Measured 2026-11-03 20:44 on `testdata/screens/2026-11-03-harken-menu/harken-2f.jpg` (1600×900; client
coordinates ×1.2): the menu is a centred list, rows at **y ≈ 484 / 556 / 628 / 700** on the 1920×1080
client (pitch **72 px**), labels centred on **x ≈ 960**, followed by the 加护 block.

The rows, as the operator read them: `第一区-城外-`, `第二区-城内1F-`, `第四区-城内2F深处-`, `归还`.

**The list is not fixed** (operator rule): a harken only offers a floor once that floor's harken has
been reconstructed, so a new harken may show **nothing but 归还**. The climb therefore *reads* the list:

1. the harken menu is named by the row structure (the reader), and each row's label is matched against
   the library;
2. the farm floor's row is offered → tap it (the teleport);
3. only 归还 or an unknown list → tap 归还 to back out, and take the **stair icon** (the door-with-arrow
   glyph on the minimap) — the second exit the operator described: go to the next floor on foot.

The stair glyph is the map's own icon (`MapIcon.kind` already distinguishes harken / chest / hole /
teleport / hazard; the door-with-arrow needs its kind named — `t-mvmdjlju-30n3it`).

## What stays out

- **No text decoding.** The labels are learned patches, not OCR: a label the library has never seen
  answers `null`, and the reader says so instead of guessing the closest name.
- **No new per-screen ad-hoc measure.** A new screen writes a `FrameReader`, not a bespoke function in
  a perceiver.
