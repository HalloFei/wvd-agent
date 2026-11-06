/**
 * The claim the design makes (2026-10-24-qte-sub-loop-design §1): decoding a band costs a quarter of
 * decoding a full frame. The QTE loop no longer decodes anything — since the vision module (2026-11-07)
 * the band is a raw rectangle cropped out of the channel's copied slot — so this measurement is about
 * the **artifact** path: a JPEG that carries the band, read back by the native decoder.
 *
 * It is kept because the decoder is still the one recorded artifacts and the native round-trip test
 * use, and because it is the number the old band decode was judged by. The full-frame figure is the
 * fixture's own 1920 × 1080 JPEG. The band figure is the same still cropped to `qteWindow` and encoded
 * at `WVD_DEFAULTS.jpegQuality` with jpeg-js, the encoder the World's escalation snapshot now uses (the
 * child's native encoder was deleted with the crashing COM `Seek`). The band run is the minimum of
 * five decodes and the full frame the median of three, so a scheduler hiccup cannot flake the bound
 * into a false failure: a slow band run is discarded and a single slow full-frame run is outvoted. The
 * expected ratio is ≈ 1/5, so the 1/4 bound keeps margin.
 *
 * Skipped where GDI+ cannot start (another OS, a broken `gdiplus.dll`): the ratio is a fact about the
 * native decoder, and `skipIf` says so instead of turning an unsupported machine red. `gdiplusProblem()`
 * answers `''` on a working machine.
 */
import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { WVD_DEFAULTS } from '../src/config.ts';
import { cropBgra } from '../src/engine/crop.mjs';
import { decodeJpeg, gdiplusProblem } from '../src/engine/gdiplus.mjs';
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
 * BGRA → the RGBA jpeg-js reads, which is what the World's snapshot encoder now produces (the native
 * encoder was deleted with the vision module; the decoder is what this test measures). `crop.mjs`
 * copies bytes and never swaps channels, so a decoded still has to be flipped before it is encoded;
 * the colours do not change the band's size or its decode cost, but the artifact should be the real
 * one.
 */
function toRgba(bgra: Uint8Array): Uint8Array {
  const rgba = Uint8Array.from(bgra);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = bgra[offset + 2];
    rgba[offset + 1] = bgra[offset + 1];
    rgba[offset + 2] = bgra[offset];
    rgba[offset + 3] = bgra[offset + 3];
  }
  return rgba;
}

describe('the QTE band', () => {
  it.skipIf(gdiplusProblem() !== '')(
    'decodes the band in at most a quarter of the full frame',
    async () => {
      const fullBytes = await readFile(new URL(STILL, FIXTURES));
      const full = decodeJpeg(fullBytes);
      const rect = qteWindow(full);
      const band = cropBgra(full.data, full.width, full.height, rect);
      const bandBytes = Uint8Array.from(jpeg.encode(
        { data: toRgba(band.pixels), width: band.width, height: band.height },
        WVD_DEFAULTS.jpegQuality,
      ).data);

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
