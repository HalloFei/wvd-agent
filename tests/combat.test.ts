import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { BUTTON_INK_MIN, readFacts, SHOP_BAND_INK_MIN } from '../src/perception/facts.ts';
import { screenStandings, settlesAgainst } from '../src/perception/screens.ts';

const TOWN_LIVE = new URL('../testdata/screens/2026-11-07-town-live/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const LIVE = new URL('../testdata/screens/2026-10-25-live/', import.meta.url);
const FFXI = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);
const NAV_4F = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const NAV = new URL('../testdata/nav-1024-0213/', import.meta.url);

/** The five committed frames the old measurement named combat, on both HUD layouts. */
const BATTLES = [
  [BATTLE, 'command-phase.jpg'],
  [BATTLE, 'alice-command-phase.jpg'],
  [LIVE, 'combat-command.jpg'],
  [FFXI, 'combat.jpg'],
  [NAV_4F, 'combat.jpg'],
] as const;

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

describe('CombatPerceiver and the live town page (2026-11-07 21:14)', () => {
  it('lights both button windows on the town, so the ink gate alone cannot separate it', async () => {
    // Measured on the live client's own capture: 0.0239 on the speed window and 0.0288 on the auto
    // window, both over BUTTON_INK_MIN, and inside the recorded battle range (0.0086-0.0314 and
    // 0.0107-0.0153). The party panel's sparkle and the sunlit street sit in the two windows.
    const facts = readFacts(await imageAt(TOWN_LIVE, 'town-1920.jpg'));
    expect(facts.speedInk).toBeGreaterThanOrEqual(BUTTON_INK_MIN);
    expect(facts.autoInk).toBeGreaterThanOrEqual(BUTTON_INK_MIN);
    expect(facts.shopBandInkPx).toBeGreaterThanOrEqual(SHOP_BAND_INK_MIN);
  });

  it('refuses the town page instead of naming it a battle at confidence 1.0', async () => {
    // Live consequence: named combat at 1.0, the World pressed 自動 and 倍速 on the town, and the
    // presses opened 每日任务 and the character page - two stalls the same night.
    const frame = await frameAt(TOWN_LIVE, 'town-1920.jpg');
    const image = await frame.toRgba();
    expect(settlesAgainst(screenStandings(readFacts(image)), 'combat')).toBe(true);
    expect((await new CombatPerceiver().observe(frame)).screen).toBe('unknown');
  });

  it('still names the five committed battle frames', async () => {
    for (const [dir, name] of BATTLES) {
      const observation = await new CombatPerceiver().observe(await frameAt(dir, name));
      expect(observation.screen, name).toBe('combat');
      expect(observation.confidence, name).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('still refuses a map whose walls fill both button windows', async () => {
    const observation = await new CombatPerceiver().observe(await frameAt(NAV, 'popup.jpg'));
    expect(observation.screen).toBe('unknown');
  });
});
