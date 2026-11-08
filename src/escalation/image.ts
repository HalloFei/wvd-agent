/**
 * The escalation snapshot: **a second capture**, not a re-encode (research-escalation-design.md
 * §2.4, the brief's step 3).
 *
 * The engine already encoded the frame once, in the child. Re-encoding `toRgba()` in the World would
 * spend ~100 ms undoing that encode and pay a second generation of JPEG loss, so the snapshot asks
 * the source for its own JPEG again, at `maxWidth` (contracts §5 declares `capture { maxWidth }`).
 *
 * `SnapshotSource` is the port the composition root binds to that engine capture. The request's
 * `maxWidth` is honoured in the child's render path — the encoder downscales the frame *before*
 * encoding it and reports the size of the JPEG it actually returned, so `width`/`height` here are
 * the size the model is reading, not the window. A window already narrower than the request comes
 * back native (the snapshot is never upscaled), and the width is always carried with the bytes,
 * which is what keeps `wvd_act`'s coordinate mapping correct.
 */
import jpeg from 'jpeg-js';
import type { BlobInput } from 'cortico/core/types.ts';
import type { RgbaImage } from '../contracts.ts';
import { encodePng } from '../perception/ledger.ts';

/** Encoded pixels, with the size the model is reading them at. */
export interface Snapshot {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The World's second-capture port: one JPEG of the game window, downscaled when asked. */
export interface SnapshotSource {
  captureJpeg(maxWidth?: number): Promise<Snapshot | null>;
  /**
   * The same frame **losslessly** (PNG), for the ledger — optional, because a source that only encodes
   * JPEG is a legal realisation of this port; the event then carries the JPEG alone.
   */
  capturePng?(maxWidth?: number): Promise<Snapshot | null>;
}

/** The `BlobInput` the event or a `wvd_look` receipt carries. */
export function snapshotBlob(snapshot: Snapshot): BlobInput {
  return {
    bytes: snapshot.bytes,
    mime: 'image/jpeg',
    name: 'wvd-frame.jpg',
    // Always visible, image attached or not (research §2.3), so it says what the image *is* and
    // never that it is attached. The model reads this beside the perception line.
    fallbackText: `screenshot ${snapshot.width}×${snapshot.height}`,
  };
}

/**
 * The same frame as the event's **second** blob, lossless: the ledger's copy. The model reads the
 * JPEG; the refused frame is kept as the bytes the reader refused (2026-11-08: a q75 re-encode hid the
 * ink column that split a digit, so the run's own snapshot could not reproduce the refusal).
 */
export function losslessBlob(snapshot: Snapshot): BlobInput {
  return {
    bytes: snapshot.bytes,
    mime: 'image/png',
    name: 'wvd-frame.png',
    fallbackText: `lossless frame ${snapshot.width}×${snapshot.height}`,
  };
}

/**
 * The evidence of one refusal, encoded **from the frame the reader judged** rather than from a second
 * capture.
 *
 * A second capture is a different instant, and on 2026-11-08 that difference cost an hour of
 * diagnosis: the loop escalated a correct \`dungeon 0.94\`, the snapshot taken some tens of milliseconds
 * later showed a menu the Esc had just opened, and the saved frame then classified \`ui-menu 0.93\`.
 * The evidence contradicted the claim — not because perception was wrong, but because the two were
 * not the same picture. A filed refusal must be the picture the loop acted on, or triage is guessing.
 *
 * The cost is paid only when a question is asked (the escalation budget is twenty an hour), so both
 * encodes happen here rather than in the tick: \`jpeg\` is what the model reads, \`png\` is the ledger's
 * lossless bytes and the one a triage script can re-classify against the production chain.
 */
export interface JudgedFrame {
  /** The model's copy: JPEG at \`maxWidth\`, the format the escalation always carried. */
  readonly jpeg: Snapshot;
  /** The ledger's copy: the same pixels, losslessly. */
  readonly png: Snapshot;
}

/** Encode a judged frame for the escalation. `null` when the pixels cannot be read or encoded. */
export async function judgeSnapshot(
  frame: { readonly width: number; readonly height: number; toRgba(): Promise<RgbaImage> },
  maxWidth: number,
): Promise<JudgedFrame | null> {
  try {
    const pixels = await frame.toRgba();
    // The pixels must be the frame they claim to be. A source whose decode disagrees with its own
    // declared size cannot be filed as evidence — the caller then falls back to its own capture,
    // which is the old behaviour (a second instant, and the reason this function exists).
    if (pixels.width !== frame.width || pixels.height !== frame.height) return null;
    const image = fitTo(pixels, maxWidth);
    const encoded = jpeg.encode({ data: Buffer.from(image.data), width: image.width, height: image.height }, 75);
    if (encoded.data.length === 0) return null;
    return {
      jpeg: { bytes: new Uint8Array(encoded.data), width: encoded.width, height: encoded.height },
      png: { bytes: encodePng(image), width: image.width, height: image.height },
    };
  } catch {
    return null;
  }
}

/**
 * Downscale to `maxWidth` by averaging each target pixel's box, never upscale: the same rule the
 * source's own capture path used, so the model reads the size it is told it reads.
 */
function fitTo(image: RgbaImage, maxWidth: number): RgbaImage {
  if (maxWidth <= 0 || maxWidth >= image.width) return image;
  const width = Math.max(1, Math.round(maxWidth));
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const data = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const at = (py * image.width + px) * 4;
          sums[0]! += image.data[at]!;
          sums[1]! += image.data[at + 1]!;
          sums[2]! += image.data[at + 2]!;
          sums[3]! += image.data[at + 3]!;
          count += 1;
        }
      }
      const to = (y * width + x) * 4;
      data[to] = Math.round(sums[0]! / count);
      data[to + 1] = Math.round(sums[1]! / count);
      data[to + 2] = Math.round(sums[2]! / count);
      data[to + 3] = Math.round(sums[3]! / count);
    }
  }
  return { data, width, height };
}

/**
 * The lossless sibling of `takeSnapshot`: null when the source has no PNG path, fails, or produces
 * nothing. Never throws into the loop (contracts §0.6).
 */
export async function takeSnapshotLossless(
  source: SnapshotSource | undefined,
  maxWidth: number,
): Promise<Snapshot | null> {
  if (!source?.capturePng) return null;
  try {
    const snapshot = await source.capturePng(maxWidth);
    if (!snapshot || snapshot.width <= 0 || snapshot.height <= 0 || snapshot.bytes.length === 0) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * One snapshot attempt, as a value: a source that is absent, fails or produces nothing yields
 * `null` and the question still goes out. Never throws into the loop (contracts §0.6).
 */
export async function takeSnapshot(
  source: SnapshotSource | undefined,
  maxWidth: number,
): Promise<Snapshot | null> {
  if (!source) return null;
  try {
    const snapshot = await source.captureJpeg(maxWidth);
    if (!snapshot || snapshot.width <= 0 || snapshot.height <= 0 || snapshot.bytes.length === 0) return null;
    return snapshot;
  } catch {
    return null;
  }
}
