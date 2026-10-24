/**
 * The minimap's player arrow, in the frame's top-right corner.
 *
 * It is the smallest read of "a minimap is drawn": R>160, G>130, B<110, R−B>60, G−B>40. Measured
 * 2026-10-24: 35 px on both committed 3-D views, 0 px on the town, the world map, Dungeon Select,
 * the dungeon maps, a battle and the chest prompt. The corner rect is wider and taller than either
 * minimap so a smaller FFXI panel still lands inside. It is a colour match, not a shape: gold UI in
 * that corner scores too (the opener panel 1 537 px, the QTE bar 455 px on one frame), which is why
 * it is evidence for `dungeon` and never a rule-out on its own.
 */
import type { RgbaImage } from '../contracts.ts';

export const MINIMAP_CORNER = { x: 1_700, y: 0, width: 220, height: 220 } as const;
/** Below this the corner holds no arrow. */
export const MINIMAP_ARROW_MIN = 8;

export function minimapArrowInk(image: RgbaImage): number {
  const { data, width } = image;
  let count = 0;
  for (let y = MINIMAP_CORNER.y; y < MINIMAP_CORNER.y + MINIMAP_CORNER.height; y += 1) {
    const row = y * width;
    for (let x = MINIMAP_CORNER.x; x < MINIMAP_CORNER.x + MINIMAP_CORNER.width; x += 1) {
      const offset = (row + x) * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      if (r > 160 && g > 130 && b < 110 && r - b > 60 && g - b > 40) count += 1;
    }
  }
  return count;
}
