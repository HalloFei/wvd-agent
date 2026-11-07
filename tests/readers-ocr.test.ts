/**
 * The numerals-reader seam's OCR tier (Task 1), measured on the opener panel.
 *
 * `panel-00.jpg` is the 由谁打开? fixture: its top-left card carries 陷阱发现 38 and 陷阱解除 49
 * (`measurements.json`). The numeral alone — a context-free 87 x 16 slice — reads nothing; the crop
 * that also carries the label reads the answer (measured 2026-11-07). That measurement is why a read
 * covers `region ∪ hint.label`.
 *
 * The live reads run the operator's RapidOCR: `WVD_OCR_PYTHON` / `WVD_OCR_SCRIPT` when the
 * environment names them, else the repo-local `.tmp/ocr-venv` and `scripts/ocr-readout.py`. Without
 * either pair there is no runtime to measure, so that block **skips**; the refusal tests need none
 * and run everywhere. The stubbed env below only names the pair — it is not a runtime — so an ungated
 * live read fails rather than skips on a machine that never had the venv (found by review).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { numeralOf, ocrReader } from '../src/perception/readers/ocr.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PANEL = new URL('../testdata/chest/2026-10-24-opener/panel-00.jpg', import.meta.url);

/** The operator's venv and the readout script; env wins, the repo-local pair is the fallback. */
const PYTHON = process.env.WVD_OCR_PYTHON || join(ROOT, '.tmp', 'ocr-venv', 'Scripts', 'python.exe');
const SCRIPT = process.env.WVD_OCR_SCRIPT || join(ROOT, 'scripts', 'ocr-readout.py');
/** Is there a runtime to measure? Gates the live-read block, so a host without it skips, not fails. */
const OCR_AVAILABLE = existsSync(PYTHON) && existsSync(SCRIPT);

/**
 * Card 1's fields on the 1920 x 1080 panel. `DETECT` / `DISARM` are the measured number bands
 * (x0 + 74 .. x1 - 3); the label bands are the same rows' left 74 px, 30 px tall because a 16 px crop
 * clips the CJK (measured 2026-11-07). The union is the measured crop that reads `陷阱发现38`.
 */
const DETECT = { x: 778, y: 793, width: 87, height: 16 };
const DETECT_LABEL = { x: 704, y: 785, width: 74, height: 30 };
const DISARM = { x: 778, y: 814, width: 87, height: 16 };
const DISARM_LABEL = { x: 704, y: 806, width: 74, height: 30 };

let cached: Promise<RgbaImage> | undefined;

/** `panel-00.jpg`, decoded once: `jpeg-js` spends ~150 ms on a 1080p frame. */
function panel(): Promise<RgbaImage> {
  cached ??= readFile(PANEL).then((bytes) => {
    const decoded = jpeg.decode(bytes, { useTArray: true });
    return { data: decoded.data, width: decoded.width, height: decoded.height };
  });
  return cached;
}

beforeEach(() => {
  vi.stubEnv('WVD_OCR_PYTHON', PYTHON);
  vi.stubEnv('WVD_OCR_SCRIPT', SCRIPT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the numerals-reader seam, OCR tier', () => {
  // The refusals below are decided before any process would be spawned, or by a spawn that fails —
  // they prove the contract on every host.
  it('refuses a hint whose label lies outside the frame (no pixels to crop)', async () => {
    await expect(ocrReader.read(await panel(), DETECT, { label: { x: -4, y: 785, width: 74, height: 30 } }))
      .resolves.toBeNull();
  });

  // The contract is not Windows-specific; the induction is. Windows names the temp root by env
  // (GetTempPath, no existence check), so a missing root is that failure without a mock.
  it.skipIf(process.platform !== 'win32')('answers null, never a throw, when the crop cannot be written to a temp path', async () => {
    // A missing, full or unwritable temp directory is a refusal like the rest: handing the crop over
    // as a PPM is the one filesystem step, and the tier's contract is `null` (readers/ocr.ts). The
    // pressure is real on this host — a full disk or a locked-down temp root must not throw into the
    // loop — and `os.tmpdir()` reads TMP/TEMP at call time, so a root that does not exist is that
    // failure without a mock.
    const missingRoot = join(ROOT, '.tmp', 'no-such-temp-root');
    vi.stubEnv('TMP', missingRoot);
    vi.stubEnv('TEMP', missingRoot);
    vi.stubEnv('TMPDIR', missingRoot);
    // The premise: this host's temp root is gone, so no temp directory can be created for the read.
    expect(() => mkdtempSync(join(tmpdir(), 'wvd-ocr-probe-'))).toThrow();
    await expect(ocrReader.read(await panel(), DETECT, { label: DETECT_LABEL })).resolves.toBeNull();
  });

  it('answers null, never a throw, when the OCR runtime is unavailable', async () => {
    const image = await panel();
    delete process.env.WVD_OCR_PYTHON;
    await expect(ocrReader.read(image, DETECT, { label: DETECT_LABEL })).resolves.toBeNull();
    vi.stubEnv('WVD_OCR_PYTHON', join(ROOT, '.tmp', 'no-such-ocr-python.exe'));
    await expect(ocrReader.read(image, DETECT, { label: DETECT_LABEL })).resolves.toBeNull();
  }, 20_000);

  it("takes the one numeral of an answer, and the hint's expected length", () => {
    expect(numeralOf('陷阱发现 38')).toBe(38);
    expect(numeralOf('陷阱发现38')).toBe(38);
    expect(numeralOf('陷阱发现')).toBeNull();
    expect(numeralOf('')).toBeNull();
    // Two runs is an ambiguous answer, not a concatenation.
    expect(numeralOf('38 49')).toBeNull();
    expect(numeralOf('38', 2)).toBe(38);
    expect(numeralOf('38', 1)).toBeNull();
  });

  // These read the operator's RapidOCR and assert its measurement, so they need the runtime
  // `OCR_AVAILABLE` names; a host without it skips instead of failing 38/49 (review finding I2).
  describe.skipIf(!OCR_AVAILABLE)('with the OCR runtime on this machine', () => {
    it('reads 陷阱发现 as 38 when the crop also carries its label', async () => {
      const read = await ocrReader.read(await panel(), DETECT, { label: DETECT_LABEL });
      expect(read).not.toBeNull();
      expect(read!.value).toBe(38);
      expect(read!.tier).toBe('ocr');
      expect(read!.confidence).toBeGreaterThan(0);
      expect(read!.confidence).toBeLessThanOrEqual(1);
    }, 20_000);

    it('reads 陷阱解除 as 49 on the row below', async () => {
      const read = await ocrReader.read(await panel(), DISARM, { label: DISARM_LABEL });
      expect(read?.value).toBe(49);
      expect(read?.tier).toBe('ocr');
    }, 20_000);

    it('cannot read the numeral without its label — the measured reason a read covers region ∪ label', async () => {
      // The 87 x 16 band alone is the same number's pixels with no context; the OCR answers nothing.
      await expect(ocrReader.read(await panel(), DETECT)).resolves.toBeNull();
    }, 20_000);

    it('refuses a crop that carries text but no numeral', async () => {
      // Card 1's 陷阱发现 label without its number: OCR sees the label and no digit.
      await expect(ocrReader.read(await panel(), DETECT_LABEL)).resolves.toBeNull();
    }, 20_000);

    it('refuses a read whose hint bounds exclude the number', async () => {
      // 38 is on the card; a hint that expects 60..70 is a refusal, not a re-read.
      await expect(ocrReader.read(await panel(), DETECT, { label: DETECT_LABEL, min: 60, max: 70 }))
        .resolves.toBeNull();
    }, 20_000);
  });
});
