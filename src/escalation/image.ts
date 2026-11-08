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
import type { BlobInput } from 'cortico/core/types.ts';

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
