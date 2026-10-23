/**
 * The recorder's bounded ring: the last `maxFrames` frames pushed, oldest first. It holds the
 * caller's `Frame` references — it never decodes, inspects or clones one — and the caller owns
 * their lifetime. The capacity is a constructor argument; the composition root decides it
 * (contracts §0: no module reaches for config).
 */
import type { Frame } from '../contracts.ts';

export class FrameRing {
  #frames: Frame[];
  readonly #capacity: number;
  #next = 0;
  #size = 0;

  constructor(maxFrames: number) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) {
      throw new RangeError(`FrameRing capacity must be a positive integer, got ${maxFrames}`);
    }
    this.#capacity = maxFrames;
    this.#frames = new Array<Frame>(maxFrames);
  }

  push(frame: Frame): void {
    this.#frames[this.#next] = frame;
    this.#next = (this.#next + 1) % this.#capacity;
    if (this.#size < this.#capacity) this.#size += 1;
  }

  /** The live frames, oldest first, in a fresh array: the caller may keep or mutate it. */
  dump(): Frame[] {
    const oldest = (this.#next - this.#size + this.#capacity) % this.#capacity;
    const frames: Frame[] = [];
    for (let i = 0; i < this.#size; i += 1) {
      frames.push(this.#frames[(oldest + i) % this.#capacity]);
    }
    return frames;
  }

  /** Drops every reference the ring holds; the next push starts the session over. */
  clear(): void {
    this.#frames = new Array<Frame>(this.#capacity);
    this.#next = 0;
    this.#size = 0;
  }
}
