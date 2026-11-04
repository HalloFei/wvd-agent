import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import {
  REVIVE_CLOSE_X_MIN, REVIVE_RING_MIN, ReviveQtePerceiver, reviveFacts,
} from '../src/perception/revive-qte.ts';

const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const REVIVE = new URL('../testdata/screens/2026-11-05-party-revive/', import.meta.url);
const DEATH = new URL('../testdata/screens/2026-11-05-main-character-death/', import.meta.url);
const CHEST = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const LOOT = new URL('../testdata/chest/2026-10-31-loot/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const PAGE = new URL('../testdata/screens/2026-11-03-character-page/', import.meta.url);
const LIST = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

describe("a party member's death (the revive QTE)", () => {
  it('is named by the close X and the violet ring', async () => {
    const image = await imageAt(BATTLE, 'revive-qte.jpg');
    const facts = reviveFacts(image);
    // The live measurements the rule is built on: the X window 0.065, the ring band 3.4 %.
    expect(facts.closeX).toBeGreaterThan(0.05);
    expect(facts.ring).toBeGreaterThan(0.02);
    const answer = await new ReviveQtePerceiver().observe(await frameAt(BATTLE, 'revive-qte.jpg'));
    expect(answer.screen).toBe('revive-qte');
    expect(answer.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('holds at the 1280 escalation width (the same live frame, box-filtered)', async () => {
    const image = await imageAt(REVIVE, 'revive-qte-1280.jpg');
    const facts = reviveFacts(image);
    expect(facts.closeX).toBeGreaterThan(REVIVE_CLOSE_X_MIN);
    expect(facts.ring).toBeGreaterThan(REVIVE_RING_MIN);
    const answer = await new ReviveQtePerceiver().observe(await frameAt(REVIVE, 'revive-qte-1280.jpg'));
    expect(answer.screen).toBe('revive-qte');
  });

  it('does not fire on the screens around it', async () => {
    const perceiver = new ReviveQtePerceiver();
    const negatives = [
      [BATTLE, 'command-phase.jpg'],
      [BATTLE, 'alice-command-phase.jpg'],
      [BATTLE, 'slot-panel-opening.jpg'],
      [BATTLE, 'slot-panel-slow-attack.jpg'],
      [DEATH, 'death.jpeg'],
      [CHEST, 'prompt-ffxi.jpg'],
      [LOOT, 'loot-00.jpg'],
      [NAV, 'third-floor.jpg'],
      [PAGE, 'benjamin-page.jpeg'],
      // The list is the one other frame whose centre band is pale violet; it has no close X, and its
      // own recogniser runs before this one.
      [LIST, 'dungeon-select.jpg'],
    ] as const;
    for (const [dir, name] of negatives) {
      const answer = await perceiver.observe(await frameAt(dir, name));
      expect(answer.screen, name).toBe('unknown');
    }
  });

  it('is the composite\'s answer on the revive frame', async () => {
    const composite = new CompositePerceiver([{ perceiver: new ReviveQtePerceiver(), floor: 0.5 }]);
    const answer = await composite.observe(await frameAt(BATTLE, 'revive-qte.jpg'));
    expect(answer.screen).toBe('revive-qte');
  });
});
