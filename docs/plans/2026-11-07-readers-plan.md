# The Numerals-Readers Implementation Plan

> **For agentic workers:** executed by superpowers:subagent-driven-development (fresh implementer per
> task, task review, final whole-branch review). Steps use checkbox (`- [ ]`) syntax.

**Goal:** give perception a **numerals-reader seam** with an OCR tier, so a numeral field is read from
the shape or from a package rather than from an atlas calibrated on one capture codec, and so the
strategy can be switched without touching the consumer.

**Architecture:** `src/perception/readers/` — the `NumeralsReader` contract, three tier
implementations (rule / template / ocr), an `auto` selector that reports the tier that answered, and
one config switch. The opener's 陷阱 and heart numerals are the first consumers; nothing else changes.

**Tech Stack:** TypeScript (Node ≥22, ESM, `.ts` imports), vitest, jpeg-js, the RapidOCR venv via
`scripts/ocr-readout.py` (already used by the map readout escalation).

**Spec:** [`docs/specs/2026-11-07-readers-design.md`](../specs/2026-11-07-readers-design.md)

**Branch:** `feat/readers` (isolated development; fast-forward to `main` after the live acceptance).
Commit per task, staged by explicit path.

## Global Constraints

- **TDD:** each task's tests are written first, watched fail, then the code. The implementer commits
  with the proving command.
- **The seam's semantics:** a reader names a **number** (or `null`); it never decides what an
  unreadable field means. The opener keeps `unreadable`/`absent` and its floors (contracts §0.6).
- **The OCR tier is an escalation, never the loop:** it runs only when the fast tiers refuse, from the
  venv command in `WVD_OCR_PYTHON`/`WVD_OCR_SCRIPT`; unset means the tier is unavailable (a `null`,
  not a throw). Bounded by a timeout (default 8 s, as the map readout).
- **No perception-wide refactor:** only the opener's two numeral reads move onto the seam in this plan.
- **Config in one place:** `worlds.wvd.readers.numerals` with its schema row and description; default
  `auto`. Never hard-code the strategy in a module.
- **The tier that answered must be observable:** every read carries `tier`, and the opener logs it at
  `info` once per panel read (not per glyph).
- `src/contracts.ts` is not changed by this plan; if a task finds it must, that is a plan defect to
  report, not a ruling to make.
- Every command through `node ~/.dsh/tools/check-digest.mjs --timeout 300 -- "<command>"`; the full
  suite in the final task and before the fast-forward.
- **The suite's OCR bound (R7 in practice, 2026-11-07):** `pnpm test` (plain `vitest run`)
  is the gate, and it is green on this host with **no hand-set env and no extra flag** (859 passed,
  0 failed, 65 files, 366 s). The OCR-dependent test files stub their own `WVD_OCR_TIMEOUT_MS=20000`
  — R7's bound is the test's to set, and unset in production the committed 8 s default stands — and
  `vitest.config.ts` sets `test.fileParallelism: false`: the Task 5 corpus's 24 real OCR reads run
  beside two pre-existing load-sensitive timing files (`engine-child-snapshot`, `qte-band`), and under
  parallel forks the load pushed those, and single OCR calls (2.5–5 s → 10–13 s), over their
  assertions. The config carries the measurement and the reason; the flag changes no assertion.

## File Structure

| file | responsibility |
| --- | --- |
| `src/perception/readers/contract.ts` | `NumeralsReader`, `Region`, `ReadHint`, `Numerals`, `Tier` |
| `src/perception/readers/ocr.ts` | the OCR tier: crop → PPM → `scripts/ocr-readout.py` → digits |
| `src/perception/readers/rule.ts` | the rule tier: `src/perception/number.ts` over the region |
| `src/perception/readers/template.ts` | the template tier: an atlas reader over a region (reuses the opener's matcher) |
| `src/perception/readers/auto.ts` | the selector: rule → template → ocr, with the tier reported |
| `src/perception/readers/index.ts` | the factory `createNumeralsReader(config)` |
| `src/perception/opener.ts` (changed) | `readTrapNumber`/`readHeartNumber` read through the seam, label as context |
| `src/config.ts` (changed) | `readers.numerals` + schema |
| `tests/readers-contract.test.ts` | the contract and the tier reporting |
| `tests/readers-ocr.test.ts` | the OCR tier on a known crop (skip when the venv is absent) |
| `tests/readers-opener.test.ts` | the opener panel through the seam: decoded fixture, sharpened variant, the negatives |
| `testdata/readers/<field>/` | the regression corpus (old-decoded and raw crops) |

## Tasks

### Task 1 — The contract and the OCR tier

- [ ] `tests/readers-ocr.test.ts`: the trap-numeral crop of `panel-00.jpg` (the label + the number) is
      read as 38 (and the disarm row as 49); a crop with no numerals is `null`; an unset
      `WVD_OCR_PYTHON` is `null` (not a throw); an out-of-range `hint` bound refuses.
- [ ] `src/perception/readers/contract.ts` + `src/perception/readers/ocr.ts`: the reader contract and
      the OCR implementation (PPM, spawn, timeout, parse the digits of the answer, apply the hint's
      bounds; `tier: 'ocr'`).
- [ ] Commit: `feat(readers): the numerals-reader contract and its OCR tier`.

### Task 2 — The rule and template tiers, and the selector

- [ ] `tests/readers-contract.test.ts`: `auto` answers from the rule tier when the region is a plain
      numeral strip; falls to the template tier when the rule refuses (a shaped case the rule cannot
      name but a template can — use `number.ts`'s refusal cases); falls to OCR when both refuse (a
      one-glyph crop the fast tiers cannot place); every answer carries its `tier`; `fast` never
      calls OCR (a fake OCR that throws if called); `ocr` skips the fast tiers.
- [ ] Implement `rule.ts`, `template.ts`, `auto.ts`, `index.ts` (the factory).
- [ ] Commit: `feat(readers): rule, template and auto tiers`.

### Task 3 — The opener reads its numerals through the seam

- [x] `tests/readers-opener.test.ts`: `panel-00.jpg` reads `measurements.json`'s twelve 陷阱 values;
      the **sharpened** variant reads the same twelve (the live failure, proved through OCR); the
      negatives still refuse (the QTE bar, the 3-D view); the heart's `absent`/`unreadable`
      distinction survives.
- [x] `readTrapNumber` reads through the seam (template → OCR, R4) with the 陷阱 label as context.
- [x] **R5 (amendment):** `readHeartNumber` keeps its own matcher. Its atlas was recorded with the
      opener's chroma ink on a numeral-tight crop and normalised against that crop's own median; the
      tier segments by luma against the region median, so the same crop splits differently and 3 of 5
      hearts refuse at the 0.95 identity floor. On the sharpened proxy even the opener's own matcher
      refuses card 1's `100` (0.871), so "the sharpened heart reads" is not achievable by either
      matcher. Moving the heart needs a re-recorded atlas (Task 5's corpus) or an ink/normalisation
      mode in the template tier — a separate change, pinned on the board.
- [x] Commit: `feat(readers): the opener's trap numerals through the seam` (`a9c9caa`).

### Task 4 — The config switch and the tier log

- [x] `tests/readers-config.test.ts`: the `worlds.wvd.readers.numerals` row (`auto` | `fast` |
      `template` | `ocr`, default `auto`), its schema, and `main.ts`'s
      `createNumeralsReaderFromConfig` building the seam's reader from a config object (R8).
- [x] `src/config.ts`: the nested `readers` row; the factory and its wiring in `main.ts`; the
      opener's `onTiers` reported once per panel and logged by `ChestPerceiver`'s option.
- [x] **R7 (amendment):** `WVD_OCR_TIMEOUT_MS` (default 8000, read at call time) bounds the OCR
      tier; proved by a fake process killed at the configured bound.
- [x] Commit: `feat(readers): the numerals strategy is a config value`.

### Task 5 — The regression corpus and the whole-suite proof

- [x] `testdata/readers/trap-numbers/`: the twelve 陷阱 fields of `panel-00.jpg` (six cards ×
      陷阱发现 / 陷阱解除) as the exact crop the opener hands a reader (numeral band ∪ label), in both
      forms — the decoded fixture and the sharpened proxy (R3's raw-capture stand-in) — as 24 lossless
      PPM crops with `manifest.json` and a README, recorded by `scripts/record-readers-corpus.ts`.
- [x] `tests/readers-corpus.test.ts`: the rule, template and OCR tiers over every crop. The template
      tier reads all twelve decoded values (and the proxy's twelve as eleven values + one refusal, never
      a different number); the OCR tier reads both forms with its two box-split refusals and its
      77-as-177 misread **recorded**; the rule tier's known 4-vs-3 misname is recorded beside its other
      measured defeats and four refusals (board card `t-mw65nlh4-lfoik7`); no tier answers outside the
      field's plausible range (1–999). `docs/status.md` records the corpus and the measured defects.
- [x] Full suite (plain `pnpm test` — no env, no flag — 859 passed; R7's bound stubbed per test
      file) + `tsc` clean; commit:
      `feat(readers): the numerals corpus and the full-suite proof`.

### Task 6 — Live acceptance (controller)

- [ ] The farm reaches a chest, the opener panel is named, the chest opens. Needs the game launched by
      the operator; the controller runs `.tmp/run3*.sh` and records the result in the ledger and
      `docs/status.md`.

## Review Focus

1. **The seam does not leak the opener's semantics** — `unreadable`/`absent`, the floors and the
   ineligibility stay in `opener.ts`.
2. **The OCR tier is bounded and quiet** — a timeout or a missing venv is `null`, never a throw into
   the loop; it is never called by `fast`.
3. **The tier is reported** — a read that silently changes tier cannot be measured.
4. **The corpus proves the class** — the sharpened variant is the raw proxy; both must read.
