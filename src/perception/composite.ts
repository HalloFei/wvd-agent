/**
 * The composition seam: one `Classifier` over a set of screen recognisers.
 *
 * Contracts §3: every screen gets a standing on every frame, and the frame's own evidence deletes
 * the screens it makes impossible; a recogniser can only win a screen that survived. The standings
 * are computed once from the frame's cheap facts (`screens.ts`), so one contradiction protects
 * every recogniser instead of each re-implementing it — a map whose parser refuses the frame cannot
 * be named a battle because its parchment lights the battle's button windows.
 *
 * Two rules the seam still enforces:
 *
 * - **A recogniser's floor is its own.** Each entry carries the confidence at which its answer is
 *   trusted, because the floors are measured per screen type, not shared. An answer below its floor
 *   is a refusal for this purpose, so the next recogniser gets its turn.
 * - **The frame is decoded once.** Every recogniser reads pixels, and a 1080p JPEG decode is far
 *   more expensive than the whole recogniser chain (`observe()` must fit the 50 ms half-tick,
 *   contracts §0.7). The derived `Frame` memoises the first `toRgba()` and hands every recogniser
 *   the same image; the facts read the same image.
 *
 * The order recognisers are tried in is an optimisation, not the decision: a frame's facts leave at
 * most a few screens standing, and the cheapest decisive recogniser runs first. What the order may
 * never do is overrule a standing — an answer for a ruled-out screen is dropped, not returned.
 *
 * The fallback keeps the confidences apart, because the session classifier stops at 0 and escalates
 * above it (contracts §2, Task 10 review Critical 1). When no recogniser clears its floor the
 * composite answers `unknown` at **the strongest positive confidence any recogniser offered** — a
 * recogniser that saw a busy frame it could not name said "something is drawn", and so did one whose
 * screen the frame's evidence forbade: the screen is wrong, the frame is not empty. That confidence
 * never becomes the answer. `unknown` at 0 survives only when every recogniser offered nothing,
 * which is what a black or uniform frame earns and the only frame a session may be stopped on.
 *
 * A recogniser that throws is not caught here: contracts §0.6 makes that the loop's failure to
 * handle, and swallowing it would hide a bug behind an `unknown`.
 */
import type {
  Classification,
  Classifier,
  Frame,
  Observation,
  Perceiver,
  RgbaImage,
  ScreenId,
} from '../contracts.ts';
import { NO_FACTS, readFacts, type FrameFacts } from './facts.ts';
import { screenStandings } from './screens.ts';

export interface Recogniser {
  readonly perceiver: Perceiver;
  /** Minimum confidence at which this recogniser's answer is trusted. */
  readonly floor: number;
}

export class CompositePerceiver implements Classifier {
  private readonly recognisers: readonly Recogniser[];
  private readonly floorFactor: (screen: ScreenId) => number;

  /**
   * `recognisers` is in try order. `floorFactor` scales a screen's floor by how much that screen has
   * earned (policy/trust.ts: verification by action) — 1 when no book is passed, so the seam's own
   * behaviour is unchanged for a caller that has no memory.
   */
  constructor(recognisers: readonly Recogniser[], options: { readonly floorFactor?: (screen: ScreenId) => number } = {}) {
    this.recognisers = recognisers;
    this.floorFactor = options.floorFactor ?? (() => 1);
  }

  async observe(frame: Frame): Promise<Observation> {
    return (await this.classify(frame)).answer;
  }

  /** Every screen's standing on this frame, and the answer they produced (§3). */
  async classify(frame: Frame): Promise<Classification> {
    const shared = decodeOnce(frame);
    const standings = screenStandings(await factsOf(shared));
    const ruledOut = new Set(standings.filter((standing) => standing.ruledOut).map((standing) => standing.screen));
    // The strongest "something is drawn, but I cannot name it" answer seen; it becomes the refusal.
    let seen = 0;
    for (const { perceiver, floor } of this.recognisers) {
      const observation = await perceiver.observe(shared);
      // The floor is the screen's own, scaled by what that screen has earned (trust.ts). A contradicted
      // screen needs more; a screen with a streak needs less. Never below the reader's own refusal: the
      // answer's screen must still be named and not ruled out.
      const scaled = floor * this.floorFactor(observation.screen);
      if (observation.screen !== 'unknown'
        && !ruledOut.has(observation.screen)
        && observation.confidence >= scaled) {
        return { atMs: frame.atMs, standings, answer: observation };
      }
      if (observation.confidence > seen) seen = observation.confidence;
    }
    // The 3-D view's own corner evidence survives the ruling: a frame with the minimap arrow is the
    // dungeon view with something drawn over it (its menu legend, a bright scene in the title band),
    // and the loop can ask the game's map about it instead of the model (operator rule 2026-11-03).
    const dungeonLike = standings.some((standing) => standing.screen === 'dungeon' && standing.support > 0);
    return {
      atMs: frame.atMs,
      standings,
      answer: {
        screen: 'unknown',
        atMs: frame.atMs,
        confidence: seen,
        // Absent unless true, so an unnamed frame carries the fact only when it has one.
        ...(dungeonLike ? { dungeonLike: true } : {}),
      },
    };
  }
}

/** The frame's facts; a decode failure carries none, so nothing is ruled out. */
async function factsOf(frame: Frame): Promise<FrameFacts> {
  try {
    return readFacts(await frame.toRgba());
  } catch {
    return NO_FACTS;
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
