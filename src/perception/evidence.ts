/**
 * Graded evidence: the one place a frame's facts become a decision.
 *
 * The readers used to be a chain of absolute gates — every check an `if (!x) return refuse` — so one
 * constant set by the wrong corpus vetoed a parse that every other fact supported. Live 2026-11-08:
 * the 第二区-城内1F map parsed its readout, found its title and its lattice, and was refused because its
 * canvas draws 13 047 px of white ink against a floor of 15 000.
 *
 * The distinction this module encodes is the one the loop needs:
 *
 * - **Anchors veto.** A structural fact either is there or is not (a readout line, a title, a lattice,
 *   a close tile). Its absence is not "less sure" — it is another screen, and acting on it is unsafe.
 * - **Metrics weigh.** A measurement is always on a continuum (ink, margins, residuals, scores). Inside
 *   its measured band it costs nothing; outside it *reduces the confidence*, and the confidence is what
 *   the composite's floor acts on. A metric that is far enough out drags the answer below the floor, so
 *   the evidence still decides — it just decides with a number instead of a veto.
 *
 * **Never act on a screen whose anchors veto** (operator rule, and the reason today's failures were
 * refusals rather than wrong presses). Weighting is for metrics only.
 */

/** One structural fact about a frame. `ok === false` vetoes the screen outright. */
export interface AnchorResult {
  readonly name: string;
  readonly ok: boolean;
  /** The measurement behind it, when there is one (px, luma, count) — for the log and the ledger. */
  readonly measured?: number;
}

/**
 * How a metric's value relates to its measured band:
 *
 * - `range`: good between `good[0]` and `good[1]`;
 * - `min`: good at or above `good`;
 * - `max`: good at or below `good`.
 *
 * `soft` is the distance outside the band at which the metric's weight reaches 0: a value `soft` beyond
 * the band costs the whole weight, one halfway costs half.
 */
export type MetricShape =
  | { readonly kind: 'range'; readonly good: readonly [number, number]; readonly soft: number }
  | { readonly kind: 'min'; readonly good: number; readonly soft: number }
  | { readonly kind: 'max'; readonly good: number; readonly soft: number };

/** One measured fact, with the weight its value earns (1 inside the band, 0 at `soft` beyond it). */
export interface MetricResult {
  readonly name: string;
  readonly value: number;
  readonly penalty: number;
}

/** What a frame's facts add up to: a veto, or a confidence. */
export interface Evidence {
  /** False when an anchor is missing — the screen is not this one, whatever the metrics say. */
  readonly ok: boolean;
  /** The product of the metrics' weights, 0…1. Only meaningful when `ok`. */
  readonly confidence: number;
  /** The first anchor that vetoed. */
  readonly veto?: string;
  readonly anchors: readonly AnchorResult[];
  readonly metrics: readonly MetricResult[];
}

export function anchor(name: string, ok: boolean, measured?: number): AnchorResult {
  return measured === undefined ? { name, ok } : { name, ok, measured };
}

/** How far outside its band a value is, and the weight that distance earns. */
export function penaltyFor(value: number, shape: MetricShape): number {
  // A soft margin may be a fraction (a digit's NCC margin is 0…1), so only a non-positive one is a bug.
  const soft = shape.soft > 0 ? shape.soft : 1;
  if (shape.kind === 'range') {
    const [low, high] = shape.good;
    if (value >= low && value <= high) return 1;
    const distance = value < low ? low - value : value - high;
    return Math.max(0, 1 - distance / soft);
  }
  if (shape.kind === 'min') {
    if (value >= shape.good) return 1;
    return Math.max(0, 1 - (shape.good - value) / soft);
  }
  if (value <= shape.good) return 1;
  return Math.max(0, 1 - (value - shape.good) / soft);
}

export function scoreMetric(name: string, value: number, shape: MetricShape): MetricResult {
  return { name, value, penalty: penaltyFor(value, shape) };
}

/** Fold a frame's facts into one verdict. The anchors' order is the order they are checked in. */
export function settle(
  anchors: readonly AnchorResult[],
  metrics: readonly MetricResult[],
): Evidence {
  const failed = anchors.find((entry) => !entry.ok);
  const confidence = metrics.reduce((product, entry) => product * entry.penalty, 1);
  return failed === undefined
    ? { ok: true, confidence, anchors, metrics }
    : { ok: false, confidence: 0, veto: failed.name, anchors, metrics };
}
