import { describe, expect, it } from 'vitest';
import {
  CHANNEL_STALE_MS, createChannel, layoutChannel, latest, publish, readHeader, slotOffset,
} from '../src/engine/vision/frame-channel.ts';

/**
 * The channel is the vision module's contract: a versioned shared-memory buffer with slots, a
 * seqlock, and a staleness clock. These tests drive it over a plain Buffer — the mapping is the same
 * bytes (tests/vision-channel-mapping.test.ts drives the mapping itself).
 */
const WIDTH = 4;
const HEIGHT = 2;

/** Every pixel a distinct, checkable byte. */
function frame(value: number): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT * 4).fill(value);
}

function channel(slots = 2) {
  const layout = layoutChannel({ width: WIDTH, height: HEIGHT, slots });
  return createChannel(Buffer.alloc(layout.bytes), layout);
}

/** Poke a slot's sequence word, as a writer mid-publish does (the layout is the contract). */
function writeSequence(channel0: ReturnType<typeof channel>, slot: number, sequence: bigint): void {
  channel0.buffer.writeBigUInt64LE(sequence, slotOffset(channel0.layout, slot));
}

describe('the frame channel', () => {
  it('serves the newest published frame with its clock and size', () => {
    const channel0 = channel();
    publish(channel0, frame(0x10), { capturedAtMs: 1_000 });
    publish(channel0, frame(0x20), { capturedAtMs: 1_040 });
    const frame0 = latest(channel0, { nowMs: 1_050 });
    expect(frame0).not.toBeNull();
    expect([...frame0!.pixels.slice(0, 4)]).toEqual([0x20, 0x20, 0x20, 0x20]);
    expect(frame0!.capturedAtMs).toBe(1_040);
    expect(frame0!.width).toBe(WIDTH);
    expect(frame0!.height).toBe(HEIGHT);
  });

  it('refuses a frame older than the stale window', () => {
    const channel0 = channel();
    publish(channel0, frame(0x30), { capturedAtMs: 1_000 });
    expect(latest(channel0, { nowMs: 1_000 + CHANNEL_STALE_MS - 1 })).not.toBeNull();
    expect(latest(channel0, { nowMs: 1_000 + CHANNEL_STALE_MS })).toBeNull();
  });

  it('has nothing to serve before the first publish', () => {
    expect(latest(channel(), { nowMs: 1_000 })).toBeNull();
  });

  it('refuses a slot whose writer has begun (an odd sequence)', () => {
    const channel0 = channel();
    publish(channel0, frame(0x40), { capturedAtMs: 1_000 });
    const header = readHeader(channel0);
    const slot = Number(header.latestSeq % BigInt(channel0.layout.slots));
    writeSequence(channel0, slot, header.latestSeq + 1n); // the writer is mid-publish
    expect(latest(channel0, { nowMs: 1_010 })).toBeNull();
    writeSequence(channel0, slot, header.latestSeq); // the writer finished
    expect(latest(channel0, { nowMs: 1_010 })).not.toBeNull();
  });

  it('refuses a buffer written by another version', () => {
    const layout = layoutChannel({ width: WIDTH, height: HEIGHT, slots: 2 });
    const buffer = Buffer.alloc(layout.bytes);
    const channel0 = createChannel(buffer, layout);
    buffer.writeUInt32LE(999, 4); // version
    expect(() => readHeader(channel0)).toThrow(/version/);
  });
});
