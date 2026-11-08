/**
 * Verification by action: how much a screen's read is trusted, learned from whether the action worked.
 *
 * Graded evidence (evidence.ts) lets a reader answer "map, 0.57". The composite's floor decides whether
 * that is enough to act on, and a fixed floor cannot know which screens *earn* their reads: the map has
 * been right frame after frame, while a screen the loop has just contradicted (a click that changed
 * nothing, a walk that arrived nowhere) deserves a stricter floor until it proves itself again.
 *
 * This book is that memory, and it is deliberately small: per screen, a streak of confirmations and
 * one factor in `[eased, strict]`. It never decides what is on screen — the readers do — and it never
 * overrides an anchor veto: a screen whose structural facts are missing is refused whatever this says.
 *
 * - a screen confirmed `successesToEase` times in a row may act from a read **15 % weaker** (factor
 *   0.85): three predictions in a row that came true is a measured property of this screen, not luck;
 * - one contradiction demands **25 % more** (factor 1.25) until a confirmation returns it to 1.
 *
 * The asymmetry is the safety rule: trust is easy to lose and slow to regain.
 */
import type { ScreenId } from '../contracts.ts';

export interface TrustOptions {
  /** Confirmations in a row before the floor eases. Default 3. */
  readonly successesToEase?: number;
  /** The floor multiplier a trusted screen gets. Default 0.85. */
  readonly eased?: number;
  /** The floor multiplier a contradicted screen must clear. Default 1.25. */
  readonly strict?: number;
}

export interface TrustBook {
  /** The multiplier a screen's confidence floor is scaled by. 1 until it has an opinion. */
  factor(screen: ScreenId): number;
  /** The action this screen's read predicted came true. */
  confirmed(screen: ScreenId): void;
  /** The action contradicted the read (it changed nothing). */
  contradicted(screen: ScreenId): void;
  /** What the book believes, for the log: one entry per screen it has an opinion about. */
  snapshot(): ReadonlyArray<{ readonly screen: ScreenId; readonly streak: number; readonly factor: number }>;
}

const DEFAULTS = { successesToEase: 3, eased: 0.85, strict: 1.25 } as const;

export function createTrust(options: TrustOptions = {}): TrustBook {
  const successesToEase = Math.max(1, options.successesToEase ?? DEFAULTS.successesToEase);
  const eased = Math.min(1, Math.max(0.5, options.eased ?? DEFAULTS.eased));
  const strict = Math.max(1, options.strict ?? DEFAULTS.strict);
  const book = new Map<ScreenId, { streak: number; factor: number }>();

  const entryOf = (screen: ScreenId): { streak: number; factor: number } => {
    const entry = book.get(screen);
    if (entry !== undefined) return entry;
    const fresh = { streak: 0, factor: 1 };
    book.set(screen, fresh);
    return fresh;
  };

  return {
    factor(screen) {
      return book.get(screen)?.factor ?? 1;
    },
    confirmed(screen) {
      const entry = entryOf(screen);
      entry.streak += 1;
      // Easing needs a streak; one confirmation after a contradiction only returns the strict factor to 1.
      entry.factor = entry.streak >= successesToEase ? eased : 1;
    },
    contradicted(screen) {
      const entry = entryOf(screen);
      entry.streak = 0;
      entry.factor = strict;
    },
    snapshot() {
      return [...book.entries()].map(([screen, entry]) => ({ screen, streak: entry.streak, factor: entry.factor }));
    },
  };
}
