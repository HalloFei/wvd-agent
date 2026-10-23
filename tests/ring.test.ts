import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/contracts.ts';
import { FrameRing } from '../src/frames/ring.ts';

/** A Frame whose encoding is never decoded: the ring only holds the reference. */
const frame = (atMs: number): Frame => ({
  atMs,
  width: 4,
  height: 4,
  toRgba: async () => {
    throw new Error('the ring must never decode a frame');
  },
});

describe('FrameRing', () => {
  it('keeps the last five frames in order when six are pushed into a five-frame ring', () => {
    const ring = new FrameRing(5);
    for (const atMs of [0, 100, 200, 300, 400, 500]) ring.push(frame(atMs));

    expect(ring.dump().map((f) => f.atMs)).toEqual([100, 200, 300, 400, 500]);
  });

  it('returns a copy from dump', () => {
    const ring = new FrameRing(5);
    ring.push(frame(0));

    const dumped = ring.dump();
    dumped.push(frame(100));

    expect(ring.dump().map((f) => f.atMs)).toEqual([0]);
    expect(ring.dump()).not.toBe(dumped);
  });

  it('empties on clear', () => {
    const ring = new FrameRing(5);
    ring.push(frame(0));
    ring.push(frame(100));

    ring.clear();

    expect(ring.dump()).toEqual([]);
  });

  it('rejects a capacity that cannot hold a frame', () => {
    expect(() => new FrameRing(0)).toThrow(RangeError);
  });
});
