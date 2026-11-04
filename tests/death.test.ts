import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import {
  DEATH_COLOUR_MAX, MainCharacterDeathPerceiver, greyscaleFacts,
} from '../src/perception/death.ts';

const DEATH = new URL('../testdata/screens/2026-11-05-main-character-death/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const CHEST = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const PAGE = new URL('../testdata/screens/2026-11-03-character-page/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

/** A uniform black frame: the transition the death rule must refuse. */
function blackFrame(width = 1920, height = 1080): Frame {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const image: RgbaImage = { data, width, height };
  return { atMs: 0, width, height, toRgba: async () => image };
}

describe('the main character\'s death', () => {
  it('is named by the greyscale the game renders it in', async () => {
    const image = await imageAt(DEATH, 'death.jpeg');
    const facts = greyscaleFacts(image);
    // The live measurement the rule is built on: 0.000 mean saturation, 0.00 % saturated pixels.
    expect(facts.colourFraction).toBe(0);
    expect(facts.luma).toBeGreaterThan(20);
    expect(facts.luma).toBeLessThan(140);
    const answer = await new MainCharacterDeathPerceiver().observe(await frameAt(DEATH, 'death.jpeg'));
    expect(answer.screen).toBe('main-character-dead');
    expect(answer.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('does not fire on a screen that is drawn in colour', async () => {
    const death = new MainCharacterDeathPerceiver();
    for (const [dir, name] of [
      [BATTLE, 'alice-command-phase.jpg'],
      [BATTLE, 'revive-qte.jpg'],
      [NAV, 'third-floor.jpg'],
      [CHEST, 'prompt-ffxi.jpg'],
      [PAGE, 'benjamin-page.jpeg'],
    ] as const) {
      const answer = await death.observe(await frameAt(dir, name));
      expect(answer.screen, name).toBe('unknown');
      const facts = greyscaleFacts(await imageAt(dir, name));
      expect(facts.colourFraction, name).toBeGreaterThan(DEATH_COLOUR_MAX);
    }
  });

  it('does not fire on a black transition frame', async () => {
    const answer = await new MainCharacterDeathPerceiver().observe(blackFrame());
    expect(answer.screen).toBe('unknown');
    expect(greyscaleFacts({ data: new Uint8Array(1920 * 1080 * 4), width: 1920, height: 1080 }).luma).toBe(0);
  });

  it('is the composite\'s answer on the death frame', async () => {
    const composite = new CompositePerceiver([{ perceiver: new MainCharacterDeathPerceiver(), floor: 0.5 }]);
    const answer = await composite.observe(await frameAt(DEATH, 'death.jpeg'));
    expect(answer.screen).toBe('main-character-dead');
  });
});
