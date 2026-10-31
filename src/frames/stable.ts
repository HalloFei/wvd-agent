/**
 * Stable-frame guard: a small, game-agnostic settling primitive.
 *
 * The pipeline names screens and nodes as soon as enough pixels are drawn; a recogniser can be right
 * and the UI still be fading, panning or zooming. An action that taps the first matching frame can
 * press a button that is not interactive yet. This module owns only the question 'has this value been
 * the same, on its own clock, for long enough?' — the caller owns the sampler, the key and the
 * action. It has no frame, screen, session or actuator type in it, so the World, the task steps and
 * the map actions can share it without importing each other.
 *
 * The guard is frame-clock based: a sample carries the 'atMs' of the observation it came from, and
 * stability is measured on that clock, not on wall time after the fact (contracts §0.4). The wait is
 * injected for the same reason.
 *
 * A timeout is a normal outcome, not an exception: the caller gets the last value and decides whether
 * to proceed with the retry the action already has, or to stop. Cancellation and a sampler failure are
 * separate outcomes.
 */

export interface StabilityGateOptions<T> {
  /** The value's identity: stability only counts while this string is unchanged. */
  readonly key: (value: T) => string;
  /** How long the key must be unchanged, measured on the samples' own clock, milliseconds. */
  readonly holdMs: number;
}

export interface GateDecision<T> {
  /** True once the current key has held for holdMs (or longer) on the samples' clock. */
  readonly stable: boolean;
  readonly value: T;
  /** How long the current key has held; 0 on the first sample or after a key change. */
  readonly stableForMs: number;
}

/**
 * The pure decision. Feed it samples in order; it remembers the key and its start time. A stale
 * atMs (a frame older than the one already seen) resets the window rather than counting backwards.
 */
export class StabilityGate<T> {
  #key: string | null = null;
  #sinceMs = 0;
  #last: T | null = null;

  constructor(private readonly options: StabilityGateOptions<T>) {}

  /** Drop the remembered key: the next sample starts a fresh window. */
  reset(): void {
    this.#key = null;
    this.#sinceMs = 0;
    this.#last = null;
  }

  push(value: T, atMs: number): GateDecision<T> {
    const key = this.options.key(value);
    const finite = Number.isFinite(atMs);
    const same = finite && this.#key === key && atMs >= this.#sinceMs;
    if (!same) {
      this.#key = key;
      this.#sinceMs = finite ? atMs : 0;
    }
    this.#last = value;
    const stableForMs = same ? atMs - this.#sinceMs : 0;
    return {
      stable: stableForMs >= this.options.holdMs,
      value: this.#last as T,
      stableForMs,
    };
  }
}

/** One sample: a value and the clock of the observation it came from. */
export interface StableSample<T> {
  readonly value: T;
  readonly atMs: number;
}

export interface WaitStableOptions<T> {
  /** Capture/observe one sample. A throw is a sampler failure, reported as a value. */
  readonly sample: () => Promise<StableSample<T>>;
  readonly key: (value: T) => string;
  readonly holdMs: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly abort?: AbortSignal | undefined;
}

export type StableOutcome<T> =
  | {
    readonly stable: true;
    readonly value: T;
    readonly atMs: number;
    readonly waitedMs: number;
  }
  | {
    readonly stable: false;
    readonly reason: 'timeout' | 'cancelled' | 'sample-failed';
    /** The last sample, when one arrived; null if the sampler never produced one. */
    readonly value: T | null;
    readonly waitedMs: number;
    readonly detail?: string;
  };

/**
 * Sample until the key has held for holdMs, the deadline passes, or the caller aborts. The timeout
 * uses now(); the stability window uses each sample's atMs. Both are injected, so a test can drive a
 * frozen clock and a real caller can use the frame's own clock.
 */
export async function waitStable<T>(options: WaitStableOptions<T>): Promise<StableOutcome<T>> {
  const { sample, key, holdMs, timeoutMs, pollMs, wait, now, abort } = options;
  if (!Number.isFinite(holdMs) || holdMs < 0
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(pollMs) || pollMs <= 0) {
    return { stable: false, reason: 'sample-failed', value: null, waitedMs: 0, detail: 'invalid-stable-options' };
  }
  const startedAtMs = now();
  const gate = new StabilityGate<T>({ key, holdMs });
  let last: T | null = null;
  for (;;) {
    if (abort?.aborted) {
      return { stable: false, reason: 'cancelled', value: last, waitedMs: now() - startedAtMs };
    }
    let taken: StableSample<T>;
    try {
      taken = await sample();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { stable: false, reason: 'sample-failed', value: last, waitedMs: now() - startedAtMs, detail };
    }
    last = taken.value;
    const decision = gate.push(taken.value, taken.atMs);
    if (decision.stable) {
      return { stable: true, value: decision.value, atMs: taken.atMs, waitedMs: now() - startedAtMs };
    }
    if (now() - startedAtMs >= timeoutMs) {
      return { stable: false, reason: 'timeout', value: last, waitedMs: now() - startedAtMs };
    }
    await wait(pollMs);
  }
}
