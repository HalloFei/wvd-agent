/**
 * The claim the design makes (2026-10-24-qte-sub-loop-design §1): a QTE sample costs a quarter of a
 * full frame. It is measured here, on one real still, with the decoder the World actually uses —
 * GDI+ through `decodeJpeg` — because `capture { crop }` (contracts §5) ships a JPEG of the band and
 * the World pays *that* decode, not the 1080p frame's.
 *
 * The full-frame figure is the fixture's own 1920 × 1080 JPEG. The band figure is the same still
 * cropped to `qteWindow` and encoded at `WVD_DEFAULTS.jpegQuality` — the artifact the engine's
 * encoder thread produces (it crops the BGRA before encoding, `jpeg-worker.mjs`). The band run is the
 * minimum of five decodes and the full frame the median of three, so a scheduler hiccup cannot flake
 * the bound into a false failure: a slow band run is discarded and a single slow full-frame run is
 * outvoted. The expected ratio is ≈ 1/5, so the 1/4 bound keeps margin.
 *
 * Skipped where GDI+ cannot start (another OS, a broken `gdiplus.dll`): the ratio is a fact about the
 * native decoder, and `skipIf` says so instead of turning an unsupported machine red. `gdiplusProblem()`
 * answers `''` on a working machine.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WVD_DEFAULTS } from '../src/config.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { createJpegEncoder, decodeJpeg, gdiplusProblem } from '../src/engine/gdiplus.mjs';
import { qteWindow } from '../src/perception/chest.ts';

const FIXTURES = new URL('../testdata/chest/2026-10-24-qte-0141/', import.meta.url);
/** One of the six stills of the same chest: a full 1920 × 1080 engine-quality JPEG. */
const STILL = 'frame-3.jpg';

/** One decode's wall clock in milliseconds. Every call allocates fresh pixels, so nothing is shared. */
function timeDecode(jpegBytes: Uint8Array): number {
  const started = performance.now();
  decodeJpeg(jpegBytes);
  return performance.now() - started;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * RGBA → the BGRA the engine's encoder reads. `crop.mjs` copies bytes and never swaps channels, so a
 * decoded still has to be flipped before it is encoded as the engine would encode it; the colours do
 * not change the band's size or its decode cost, but the artifact should be the real one.
 */
function toBgra(rgba: Uint8Array): Uint8Array {
  const bgra = new Uint8Array(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    bgra[offset] = rgba[offset + 2];
    bgra[offset + 1] = rgba[offset + 1];
    bgra[offset + 2] = rgba[offset];
    bgra[offset + 3] = rgba[offset + 3];
  }
  return bgra;
}

describe('the QTE band', () => {
  it.skipIf(gdiplusProblem() !== '')(
    'decodes the band in at most a quarter of the full frame',
    async () => {
      const fullBytes = await readFile(new URL(STILL, FIXTURES));
      const full = decodeJpeg(fullBytes);
      const rect = qteWindow(full);
      const band = cropBgra(full.data, full.width, full.height, rect);
      const encoder = createJpegEncoder(WVD_DEFAULTS.jpegQuality);
      if (!encoder) throw new Error(`GDI+ unavailable: ${gdiplusProblem()}`);
      const bandBytes = encoder.encode(toBgra(band.pixels), band.width, band.height);

      // One untimed decode of each, so GDI+ startup and JIT warm-up are not part of a sample.
      decodeJpeg(fullBytes);
      decodeJpeg(bandBytes);

      const fullMs = median([timeDecode(fullBytes), timeDecode(fullBytes), timeDecode(fullBytes)]);
      const bandMs = Math.min(
        timeDecode(bandBytes),
        timeDecode(bandBytes),
        timeDecode(bandBytes),
        timeDecode(bandBytes),
        timeDecode(bandBytes),
      );
      console.log(
        `band ${band.width}×${band.height} decode ${bandMs.toFixed(1)} ms, ` +
          `full ${full.width}×${full.height} decode ${fullMs.toFixed(1)} ms ` +
          `(1/${(fullMs / bandMs).toFixed(1)})`,
      );

      expect(band.width).toBe(631);
      expect(band.height).toBe(699);
      expect(bandMs).toBeLessThanOrEqual(fullMs / 4);
    },
    30_000,
  );
});
