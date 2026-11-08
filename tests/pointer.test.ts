import { describe, expect, it } from 'vitest';
import type { ActionResult, Frame, Point, RgbaImage } from '../src/contracts.ts';
import { readPointer } from '../src/perception/pointer.ts';
import { steerPointer, type PointerDirection, type PointerEnv } from '../src/actions/pointer.ts';

/** A frame with the cursor's white arrow stamped at `at` over a parchment field. */
function frameWith(at: Point | null, ink = 255): RgbaImage {
  const width = 1_920;
  const height = 1_080;
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 150;
    data[index * 4 + 1] = 140;
    data[index * 4 + 2] = 120;
    data[index * 4 + 3] = 255;
  }
  if (at !== null) {
    // The arrow's body: a compact bright wedge, ~16 × 22.
    for (let y = 0; y < 22; y += 1) {
      const width_ = Math.max(2, Math.round(16 * (1 - y / 22)));
      for (let x = 0; x < width_; x += 1) {
        const to = ((at.y + y) * width + (at.x + x)) * 4;
        data[to] = ink;
        data[to + 1] = ink;
        data[to + 2] = ink;
      }
    }
  }
  return { data, width, height };
}

const asFrame = (image: RgbaImage): Frame => ({ atMs: 1, width: image.width, height: image.height, toRgba: async () => image });

describe('the pointer reader', () => {
  it('finds the arrow the frame draws', () => {
    const reading = readPointer(frameWith({ x: 700, y: 400 }));
    expect(reading).not.toBeNull();
    expect(Math.abs(reading!.at.x - 706)).toBeLessThanOrEqual(6);
    expect(Math.abs(reading!.at.y - 408)).toBeLessThanOrEqual(6);
    expect(reading!.confidence).toBeGreaterThan(0.3);
  });

  it('is not a white panel, and not an empty field', () => {
    // A bright block is a panel or a highlight: its span is far wider than the arrow's.
    const panel = frameWith(null);
    for (let y = 300; y < 380; y += 1) {
      for (let x = 600; x < 1_000; x += 1) {
        const to = (y * panel.width + x) * 4;
        panel.data[to] = 255;
        panel.data[to + 1] = 255;
        panel.data[to + 2] = 255;
      }
    }
    expect(readPointer(panel)).toBeNull();
    expect(readPointer(frameWith(null))).toBeNull();
  });
});

/** A pointer that moves `pxPerMs` per held millisecond, and answers its frame. */
function scripted(from: Point, pxPerMs: Partial<Record<PointerDirection, number>> = {}): {
  env: PointerEnv;
  at: () => Point;
  holds: string[];
} {
  let at = { ...from };
  const holds: string[] = [];
  const speed = (direction: PointerDirection): number => pxPerMs[direction] ?? 1;
  const env: PointerEnv = {
    capture: async () => asFrame(frameWith(at)),
    holdKey: async (direction: PointerDirection, holdMs: number): Promise<ActionResult> => {
      holds.push(direction + ' ' + holdMs);
      const step = Math.round(speed(direction) * holdMs);
      if (direction === 'd') at = { x: at.x + step, y: at.y };
      if (direction === 'a') at = { x: at.x - step, y: at.y };
      if (direction === 's') at = { x: at.x, y: at.y + step };
      if (direction === 'w') at = { x: at.x, y: at.y - step };
      return { ok: true };
    },
    sleep: async () => undefined,
  };
  return { env, at: () => at, holds };
}

describe('steering the pointer', () => {
  it('holds one axis at a time until the arrow is on the target', async () => {
    const scriptedEnv = scripted({ x: 700, y: 400 });
    const outcome = await steerPointer(scriptedEnv.env, { x: 1_400, y: 900 }, { tolerancePx: 10, maxSteps: 12 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Math.abs(outcome.at.x - 1_400)).toBeLessThanOrEqual(10);
    expect(Math.abs(outcome.at.y - 900)).toBeLessThanOrEqual(10);
    // It steered to the place, not to a distance: at least one hold per axis.
    expect(scriptedEnv.holds.some((hold) => hold.startsWith('d'))).toBe(true);
    expect(scriptedEnv.holds.some((hold) => hold.startsWith('s'))).toBe(true);
  });

  it('reports a swallowed hold instead of hammering', async () => {
    // The one failure a blind controller cannot see: the key went nowhere (focus, a swallowed press).
    const stuck: PointerEnv = {
      capture: async () => asFrame(frameWith({ x: 700, y: 400 })),
      holdKey: async () => ({ ok: true }),
      sleep: async () => undefined,
    };
    const outcome = await steerPointer(stuck, { x: 1_400, y: 400 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('stalled');
  });
});
