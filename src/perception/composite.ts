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
 * The fallback keeps the confidences apart, because the session classifier stops at 0 and escalates
 * above it (contracts §2, Task 10 review Critical 1). When no recogniser clears its floor the
 * composite answers `unknown` at **the strongest positive confidence any of them offered** — a
 * recogniser that saw a busy frame it could not name said "something is drawn", and that evidence
 * outranks the empty answer. `unknown` at 0 survives only when every recogniser offered nothing,
 * which is what a black or uniform frame earns and the only frame a session may be stopped on.
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
    // The strongest "something is drawn, but not at my floor" answer seen, if any. A named screen
    // below its own floor is not trusted for acting, but it is still evidence of a drawn frame.
    let seen = 0;
    for (const { perceiver, floor } of this.recognisers) {
      const observation = await perceiver.observe(shared);
      if (observation.screen !== 'unknown' && observation.confidence >= floor) return observation;
      if (observation.confidence > seen) seen = observation.confidence;
    }
    return { screen: 'unknown', atMs: frame.atMs, confidence: seen };
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
