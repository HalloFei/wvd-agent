/**
 * Pacing: a tap is one primitive of game control, and the loop sends one only on a frame that has
 * stopped moving.
 *
 * The operator's rule (2026-11-03): *make tap or operations modular — that's one primitive operation
 * in game control. Each operation has to be done with stable frames or animations, with 0.5 to 1 second
 * pacing.* Live 2026-11-03 20:23 the character page's close was tapped eight times in four seconds
 * while the page animated, and the tap that landed after the page left opened *another* member's page
 * from the 3-D view — the loop fought itself. The same rule covers the chest: a tap sent into an
 * animation is a tap the game may read as a different command.
 *
 * The primitive: an observation key (the screen, so a transition restarts the count), a count of
 * consecutive frames carrying that key, and the time of the last tap. An operation is allowed when the
 * key has held for `STABLE_FRAMES` frames **and** `OPERATION_PACE_MS` has passed since the previous
 * one. The pacer does not replace a command's own bookkeeping: a command whose effect is answered by
 * arrival or stillness (`World#press`) still waits for that answer — the pacer only decides when an
 * operation may be sent at all. It gates the direct ones: the character page's close, the battle's
 * toggles and opener cast, the harken's rows and the orientation's commands, the chest's opener card
 * and its loot claim.
 */
export const OPERATION_PACE_MS = 700;
/** Frames with the same screen before an operation may be sent: the first frame of a transition is not stable. */
export const STABLE_FRAMES = 2;

export class Pacer {
  #key: string | null = null;
  #frames = 0;
  #lastOperationAtMs: number | null = null;

  /** Record this tick's frame key: the screen the loop would act on. */
  observe(key: string): void {
    if (key === this.#key) {
      this.#frames += 1;
      return;
    }
    this.#key = key;
    this.#frames = 1;
  }

  /** True when the frame is stable and the pace has elapsed: an operation may be sent now. */
  ready(nowMs: number): boolean {
    if (this.#frames < STABLE_FRAMES) return false;
    return this.#lastOperationAtMs === null || nowMs - this.#lastOperationAtMs >= OPERATION_PACE_MS;
  }

  /**
   * Record that an operation was just sent: the next one waits the pace. The frame's stability count
   * is *not* reset — the screen did not change — and a screen that does change starts its own count
   * again, which is what keeps the loop off a transition.
   */
  act(nowMs: number): void {
    this.#lastOperationAtMs = nowMs;
  }

  /** A new session (or a new screen the caller owns) starts the count over. */
  reset(): void {
    this.#key = null;
    this.#frames = 0;
    this.#lastOperationAtMs = null;
  }
}
