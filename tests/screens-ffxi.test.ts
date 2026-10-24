import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';

const FIXTURES = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);
const LIVE = new URL('../testdata/screens/2026-10-25-live/', import.meta.url);
const NAV = new URL('../testdata/nav-1024-0213/', import.meta.url);

async function frameFrom(dir: URL, name: string): Promise<Frame> {
  const bytes = await readFile(new URL(name, dir));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

const frame = (name: string): Promise<Frame> => frameFrom(FIXTURES, name);

describe('CombatPerceiver', () => {
  it('names a battle by its 倍速 and 自动 buttons', async () => {
    const observation = await new CombatPerceiver().observe(await frame('combat.jpg'));
    expect(observation.screen).toBe('combat');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.8);
  });

  // A live capture of the command phase (B1F -巨坑-, 2026-10-25 01:2x), padded from 1920×1077 to the
  // client's 1920×1080 with a copy of its last row: the chat attachment had cropped three rows.
  it('names a battle in its command phase, before anyone has acted', async () => {
    const observation = await new CombatPerceiver()
      .observe(await frameFrom(LIVE, 'combat-command.jpg'));
    expect(observation.screen).toBe('combat');
  });

  it('refuses the walking view and the dungeon map', async () => {
    for (const name of ['view.jpg', 'map.jpg']) {
      expect((await new CombatPerceiver().observe(await frame(name))).screen).toBe('unknown');
    }
  });

  it('refuses a map whose walls fill both button windows', async () => {
    // 0.0355 / 0.0212 on the two windows, both over the 0.004 gate: the windows alone named this
    // B1F map a battle at 1.0, and the route pressed 倍速 and 自动 twice a tick on it.
    const observation = await new CombatPerceiver().observe(await frameFrom(NAV, 'popup.jpg'));
    expect(observation.screen).toBe('unknown');
  });
});

describe('ChestPromptPerceiver', () => {
  it('names the 打开 / 什么也不做 prompt', async () => {
    const observation = await new ChestPromptPerceiver().observe(await frame('prompt.jpg'));
    expect(observation.screen).toBe('chest-prompt');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('refuses the walking view, the map and a battle', async () => {
    for (const name of ['view.jpg', 'map.jpg', 'combat.jpg']) {
      expect((await new ChestPromptPerceiver().observe(await frame(name))).screen).toBe('unknown');
    }
  });
});
