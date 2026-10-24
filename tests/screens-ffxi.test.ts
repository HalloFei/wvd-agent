import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';

const FIXTURES = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);

async function frame(name: string): Promise<Frame> {
  const bytes = await readFile(new URL(name, FIXTURES));
  const decoded = jpeg.decode(bytes, { useTArray: true });
  const image: RgbaImage = { data: decoded.data, width: decoded.width, height: decoded.height };
  return { atMs: 0, width: decoded.width, height: decoded.height, toRgba: async () => image };
}

describe('CombatPerceiver', () => {
  it('names a battle by its 倍速 and 自动 buttons', async () => {
    const observation = await new CombatPerceiver().observe(await frame('combat.jpg'));
    expect(observation.screen).toBe('combat');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('refuses the walking view and the dungeon map', async () => {
    for (const name of ['view.jpg', 'map.jpg']) {
      expect((await new CombatPerceiver().observe(await frame(name))).screen).toBe('unknown');
    }
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
