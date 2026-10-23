/**
 * The composition seam: one `Perceiver` over a set of screen recognisers.
 *
 * Contracts §3: "Each screen type is its own recogniser behind this interface. A `CompositePerceiver`
 * tries them in order and returns the first answer above its floor." That is all this class does —
 * it holds no pixel knowledge, and the order (cheap structural tests first, expensive parses last)
 * is the composition root's decision, not this module's.
 *
 * Two rules it does enforce:
 *
 * - **A recogniser's floor is its own.** Each entry carries the confidence at which its answer is
 *   trusted, because the floors are measured per screen type, not shared. An answer below its floor
 *   is a refusal for this purpose, so the next recogniser gets its turn.
 * - **The frame is decoded once.** Every recogniser reads pixels, and a 1080p JPEG decode is far
 *   more expensive than the whole recogniser chain (`observe()` must fit the 50 ms half-tick,
 *   contracts §0.7). The derived `Frame` memoises the first `toRgba()` and hands every recogniser
 *   the same image. The Win32 source already caches its own decode per frame; the contract does not
 *   promise that, and a replay source may decode on every call.
 *
 * A recogniser that throws is not caught here: contracts §0.6 makes that the loop's failure to
 * handle, and swallowing it would hide a bug behind an `unknown`.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';

export interface Recogniser {
  readonly perceiver: Perceiver;
  /** Minimum confidence at which this recogniser's answer is trusted. */
  readonly floor: number;
}

export class CompositePerceiver implements Perceiver {
  private readonly recognisers: readonly Recogniser[];

  /** `recognisers` is in try order. */
  constructor(recognisers: readonly Recogniser[]) {
    this.recognisers = recognisers;
  }

  async observe(frame: Frame): Promise<Observation> {
    const shared = decodeOnce(frame);
    for (const { perceiver, floor } of this.recognisers) {
      const observation = await perceiver.observe(shared);
      if (observation.screen !== 'unknown' && observation.confidence >= floor) return observation;
    }
    return { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
  }
}

/** A `Frame` that decodes at most once, however many recognisers ask. */
function decodeOnce(frame: Frame): Frame {
  let image: Promise<RgbaImage> | undefined;
  return {
    atMs: frame.atMs,
    width: frame.width,
    height: frame.height,
    toRgba: () => (image ??= frame.toRgba()),
  };
}
