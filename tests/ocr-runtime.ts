/**
 * Where the suite's OCR proofs run (review F3).
 *
 * The live reads need `WVD_OCR_PYTHON` and `WVD_OCR_SCRIPT` in the **environment**. That is the gate —
 * not a host path. The old check (`existsSync('.tmp/ocr-venv/Scripts/python.exe')`) let a gitignored
 * directory decide whether the OCR proof ran at all: green on a machine that happened to have the
 * venv, silently skipped on one that did not, and the review could not tell which had happened.
 *
 * - the plain gate (`vitest run`, no env) **skips** the live blocks and stays green;
 * - a proving run exports the pair *and* `WVD_OCR_REQUIRED=1`, which turns a missing runtime into a
 *   failure instead of a skip — the proving-run rule: a run that skipped its OCR proof proved
 *   nothing, so it must not be able to report success.
 */
const python = process.env.WVD_OCR_PYTHON ?? '';
const script = process.env.WVD_OCR_SCRIPT ?? '';

/** The environment names both halves of the OCR runtime. */
export const OCR_CONFIGURED = python !== '' && script !== '';

/** The proving run: a missing runtime must fail, never skip. */
export const OCR_REQUIRED = process.env.WVD_OCR_REQUIRED === '1';

/** Run the live reads: configured, or required (in which case their `beforeEach` fails loudly). */
export const OCR_LIVE = OCR_CONFIGURED || OCR_REQUIRED;

/** The runtime the environment names, or empty strings when it names none. */
export const OCR_PYTHON = python;
export const OCR_SCRIPT = script;

/**
 * The proving run's premise, asserted in every live block's `beforeEach`: with `WVD_OCR_REQUIRED=1`
 * and no runtime, the tests run and fail here — a named failure, not a silent skip.
 */
export function assertOcrRuntime(): void {
  if (OCR_CONFIGURED) return;
  throw new Error(
    'WVD_OCR_REQUIRED=1 but WVD_OCR_PYTHON/WVD_OCR_SCRIPT are not both set: a proving run must name '
    + 'the OCR runtime (the environment is the gate, review F3)',
  );
}
