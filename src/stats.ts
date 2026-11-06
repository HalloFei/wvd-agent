/**
 * The run's own log: how many chests were opened, how long each took, how many battles ran and how
 * long they took (operator, 2026-11-07: *a logging module, like the legacy wvd — how many chest
 * opened during cycles, how long each chest open takes from start to finish in average, how many
 * battle took, how long each battle took in averages*).
 *
 * Fed the game's own **mode** once per tick, not the screen: `policy/mode.ts` already holds a modal
 * mode through the frames that do not name it (a battle's resolution, a fade, the loot card after the
 * bar), so a chest and a battle are one interval each, not a dozen fragments.
 *
 * A **chest** is the chest mode's span: the 打開 prompt (or the walk's arrival at it) to the loot
 * card leaving — walking up, opening, the QTE, the lid and the claim are one interval, which is what
 * the operator means by "start to finish". A **battle** is the battle mode's span: the command
 * phase to the last combat frame. Both are summed per cycle and over the run.
 *
 * Pure: no clock, no I/O, no logging — the World hands it `now` and reads `summary()`.
 */
import type { GameMode } from './contracts.ts';

/** One counted thing: how many, and how long they took in total. */
export interface StatSpan {
  readonly count: number;
  readonly totalMs: number;
}

/** One cycle's counts. */
export interface CycleStats {
  readonly cycle: number;
  readonly chests: StatSpan;
  readonly battles: StatSpan;
}

/** The run so far: every finished cycle, the totals, and the two averages. */
export interface RunStatsSummary {
  readonly cycles: readonly CycleStats[];
  readonly chests: StatSpan;
  readonly battles: StatSpan;
  /** Mean chest time, null until one chest has been seen. */
  readonly chestAvgMs: number | null;
  /** Mean battle time, null until one battle has been seen. */
  readonly battleAvgMs: number | null;
}

/** The mean of one span, or null when nothing was counted. */
export function averageOf(span: StatSpan): number | null {
  return span.count === 0 ? null : span.totalMs / span.count;
}

/** A span as one log fragment: `2 (avg 41.2 s)`, or `0`. */
export function formatSpan(span: StatSpan): string {
  const avg = averageOf(span);
  return avg === null ? '0' : `${span.count} (avg ${(avg / 1000).toFixed(1)} s)`;
}

const EMPTY: StatSpan = { count: 0, totalMs: 0 };

export class RunStats {
  #cycle = 1;
  #cycles: CycleStats[] = [];
  #chests: StatSpan = EMPTY;
  #battles: StatSpan = EMPTY;
  #totalChests: StatSpan = EMPTY;
  #totalBattles: StatSpan = EMPTY;
  #chestSinceMs: number | null = null;
  #battleSinceMs: number | null = null;

  /** One tick's mode and time. `null` is a frame that named nothing; it holds an open interval. */
  observe(mode: GameMode | null, now: number): void {
    const chest = mode === 'chest';
    if (chest && this.#chestSinceMs === null) this.#chestSinceMs = now;
    else if (!chest && this.#chestSinceMs !== null) {
      this.#chests = add(this.#chests, now - this.#chestSinceMs);
      this.#chestSinceMs = null;
    }
    const battle = mode === 'battle';
    if (battle && this.#battleSinceMs === null) this.#battleSinceMs = now;
    else if (!battle && this.#battleSinceMs !== null) {
      this.#battles = add(this.#battles, now - this.#battleSinceMs);
      this.#battleSinceMs = null;
    }
  }

  /** Close the cycle at `now` and start the next one's counters. */
  endCycle(now: number): CycleStats {
    this.observe(null, now);
    const cycle: CycleStats = { cycle: this.#cycle, chests: this.#chests, battles: this.#battles };
    this.#cycles = [...this.#cycles, cycle];
    this.#totalChests = combine(this.#totalChests, this.#chests);
    this.#totalBattles = combine(this.#totalBattles, this.#battles);
    this.#chests = EMPTY;
    this.#battles = EMPTY;
    this.#cycle += 1;
    return cycle;
  }

  /** The run so far. A cycle still in progress is not in `cycles`; its counts are in the totals. */
  summary(): RunStatsSummary {
    const chests = combine(this.#totalChests, this.#chests);
    const battles = combine(this.#totalBattles, this.#battles);
    return {
      cycles: this.#cycles,
      chests,
      battles,
      chestAvgMs: averageOf(chests),
      battleAvgMs: averageOf(battles),
    };
  }

  /** The cycle in progress, for a log line that must not wait for the boundary. */
  get cycle(): number {
    return this.#cycle;
  }
}

function add(span: StatSpan, ms: number): StatSpan {
  return { count: span.count + 1, totalMs: span.totalMs + Math.max(0, ms) };
}

function combine(a: StatSpan, b: StatSpan): StatSpan {
  return { count: a.count + b.count, totalMs: a.totalMs + b.totalMs };
}
