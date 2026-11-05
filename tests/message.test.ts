import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { MESSAGE_TAP, MessagePerceiver, messageFacts } from '../src/perception/message.ts';

const MESSAGE = new URL('../testdata/screens/2026-11-06-message/', import.meta.url);
const INN = new URL('../testdata/screens/2026-11-06-inn/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const DEATH = new URL('../testdata/screens/2026-11-05-main-character-death/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const HARKEN = new URL('../testdata/screens/2026-11-03-harken-menu/', import.meta.url);
const LOOT = new URL('../testdata/chest/2026-10-31-loot/', import.meta.url);
const LIST = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);
const PAGE = new URL('../testdata/screens/2026-11-03-character-page/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

describe("the game's one-off message box", () => {
  it('is named by the panel, the caption and the yellow continue mark (1920 and its 1280 copy)', async () => {
    for (const name of ['message-1920.jpg', 'message-1280.jpg']) {
      const facts = messageFacts(await imageAt(MESSAGE, name));
      // The measured evidence: the panel's border runs, a caption of white ink, and the arrow — the
      // one fact no other recorded screen carries (0.0000 there).
      expect(facts.topBorder, name).toBeGreaterThan(0.24);
      expect(facts.bottomBorder, name).toBeGreaterThan(0.24);
      expect(facts.captionInk, name).toBeGreaterThan(0.002);
      expect(facts.arrow, name).toBeGreaterThan(0.002);
      const answer = await new MessagePerceiver().observe(await frameAt(MESSAGE, name));
      expect(answer.screen, name).toBe('message');
      if (answer.screen !== 'message') throw new Error('unreachable');
      expect(answer.confidence).toBeGreaterThanOrEqual(0.5);
      expect(answer.at).toEqual({ x: Math.round((name === 'message-1920.jpg' ? 1920 : 1280) * MESSAGE_TAP.x), y: Math.round((name === 'message-1920.jpg' ? 1080 : 720) * MESSAGE_TAP.y) });
    }
  });

  it('does not fire on the screens around it', async () => {
    const perceiver = new MessagePerceiver();
    for (const [dir, name] of [
      [INN, 'inn-service-1920.jpg'],
      [INN, 'inn-rooms-1280.jpg'],
      [INN, 'inn-confirm-1920.jpg'],
      [BATTLE, 'command-phase.jpg'],
      [DEATH, 'death.jpeg'],
      [NAV, 'third-floor.jpg'],
      [HARKEN, 'harken-2f-1920.jpg'],
      [LOOT, 'loot-00.jpg'],
      [LIST, 'dungeon-select.jpg'],
      [PAGE, 'benjamin-page.jpeg'],
    ] as const) {
      const answer = await perceiver.observe(await frameAt(dir, name));
      expect(answer.screen, name).toBe('unknown');
    }
  });

  it('is the composite\'s answer on the message frame', async () => {
    const composite = new CompositePerceiver([{ perceiver: new MessagePerceiver(), floor: 0.5 }]);
    const answer = await composite.observe(await frameAt(MESSAGE, 'message-1920.jpg'));
    expect(answer.screen).toBe('message');
  });
});
