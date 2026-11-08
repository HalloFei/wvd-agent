import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { RING_RADIUS, isClickable, whiteRing } from '../src/perception/map-ring.ts';

/** A 400×400 frame of one luma, with a ring or a disc drawn on it. */
function frame(luma = 40): RgbaImage {
  const data = new Uint8Array(400 * 400 * 4);
  for (let index = 0; index < 400 * 400; index += 1) {
    data[index * 4] = luma;
    data[index * 4 + 1] = luma;
    data[index * 4 + 2] = luma;
    data[index * 4 + 3] = 255;
  }
  return { data, width: 400, height: 400 };
}

function draw(image: RgbaImage, at: { x: number; y: number }, radius: number, ring: boolean, luma = 240): void {
  for (let y = at.y - radius - 2; y <= at.y + radius + 2; y += 1) {
    for (let x = at.x - radius - 2; x <= at.x + radius + 2; x += 1) {
      const distance = Math.hypot(x - at.x, y - at.y);
      const inside = ring ? Math.abs(distance - radius) <= 1.6 : distance <= radius;
      if (!inside) continue;
      const to = (y * image.width + x) * 4;
      image.data[to] = luma;
      image.data[to + 1] = luma;
      image.data[to + 2] = luma;
    }
  }
}

const AT = { x: 200, y: 200 };

describe('the white ring', () => {
  it('reads the game s clickable ring around an icon', () => {
    const image = frame();
    draw(image, AT, 22, true);
    const reading = whiteRing(image, AT);
    expect(reading).not.toBeNull();
    expect(reading!.radius).toBeGreaterThanOrEqual(RING_RADIUS.min);
    expect(reading!.radius).toBeLessThanOrEqual(RING_RADIUS.max);
    expect(reading!.ringLuma - reading!.innerLuma).toBeGreaterThan(100);
    expect(isClickable(image, AT)).toBe(true);
  });

  it('is not a lit disc, and not an empty patch', () => {
    // A solid bright disc (a building, a mountain) has an interior as bright as its edge.
    const disc = frame();
    draw(disc, AT, 26, false);
    expect(whiteRing(disc, AT)).toBeNull();
    // Nothing drawn at all.
    expect(whiteRing(frame(), AT)).toBeNull();
    // A ring drawn where the caller is not looking is not that icon's ring.
    const elsewhere = frame();
    draw(elsewhere, { x: 80, y: 80 }, 22, true);
    expect(whiteRing(elsewhere, AT)).toBeNull();
  });
});
