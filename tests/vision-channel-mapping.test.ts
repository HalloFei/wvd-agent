import { describe, expect, it } from 'vitest';
import { createChannel, layoutChannel, latest, publish } from '../src/engine/vision/frame-channel.ts';
import { openMapping } from '../src/engine/vision/channel-mapping.ts';

/**
 * The mapping is the real transport: two handles to one name see the same bytes. The channel's
 * contract (slots, seqlock, staleness) is proven over a plain Buffer in
 * tests/vision-frame-channel.test.ts; this file proves the region is actually shared.
 */
const WINDOWS = process.platform === 'win32';

function name(): string {
  return `wvd-channel-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

describe('the channel mapping', () => {
  it.skipIf(!WINDOWS)('carries a published frame between two handles to the same name', () => {
    const layout = layoutChannel({ width: 4, height: 2, slots: 2 });
    const a = openMapping(name(), layout.bytes);
    const b = openMapping(a.name, layout.bytes);
    try {
      const writer = createChannel(a.memory, layout);
      const reader = createChannel(b.memory, layout);
      expect(reader.layout.width).toBe(4);
      publish(writer, new Uint8Array(layout.stride * 2).fill(0x77), { capturedAtMs: 1_000 });
      const frame = latest(reader, { nowMs: 1_010 });
      expect(frame).not.toBeNull();
      expect([...frame!.pixels.slice(0, 4)]).toEqual([0x77, 0x77, 0x77, 0x77]);
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it.skipIf(!WINDOWS)('refuses a region written with another layout', () => {
    const a = openMapping(name(), 4096);
    try {
      const first = layoutChannel({ width: 4, height: 2, slots: 2 });
      createChannel(a.memory, first);
      // A World that expects a different frame refuses the region rather than misreading a slot.
      expect(() => createChannel(a.memory, layoutChannel({ width: 8, height: 2, slots: 2 }))).toThrow(/layout mismatch/);
    } finally {
      a.dispose();
    }
  });
});
