/**
 * The escalation snapshot: **a second capture**, not a re-encode (research-escalation-design.md
 * §2.4, the brief's step 3).
 *
 * The engine already encoded the frame once, in the child. Re-encoding `toRgba()` in the World would
 * spend ~100 ms undoing that encode and pay a second generation of JPEG loss, so the snapshot asks
 * the source for its own JPEG again, at `maxWidth` (contracts §5 declares `capture { maxWidth }`).
 *
 * `SnapshotSource` is the port the composition root binds to that engine capture. The child does
 * **not downscale yet** — the request carries `maxWidth` and the child ignores it, so the image
 * arrives at native size (see the Task 10 report, "not implemented"). The width is always carried
 * with the bytes, which is what keeps `wvd_act`'s coordinate mapping correct either way.
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
