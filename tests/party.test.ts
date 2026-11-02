import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import { PARTY_CARDS, PARTY_MEMBERS, activePartyMember, partyGoldScores } from '../src/perception/party.ts';

const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const OLDER = new URL('../testdata/screens/2026-10-25-live/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const WORLD = new URL('../testdata/worldmap/2026-11-01/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

describe('the battle party panel', () => {
  it('holds the operator roster in the panel order', () => {
    expect(PARTY_MEMBERS).toEqual(['艾莉赛', '本杰明', '拉纳维尔', 'DragonSlayer', '爱丽丝', '薇薇安娜DEX6']);
    expect(PARTY_CARDS).toHaveLength(PARTY_MEMBERS.length);
  });

  it('reads the turn card off the command phase', async () => {
    const image = await imageAt(BATTLE, 'command-phase.jpg');
    expect(activePartyMember(image)).toBe('DragonSlayer');
    const scores = partyGoldScores(image);
    expect(scores).not.toBeNull();
    // Measured 2026-11-02: the turn card's face 53.7, every other face at most 3.5.
    expect(scores![3]!).toBeGreaterThan(50);
    expect(Math.max(...scores!.filter((_, index) => index !== 3))).toBeLessThan(5);
  });

  it('reads the turn card off an older command phase', async () => {
    const image = await imageAt(OLDER, 'combat-command.jpg');
    expect(activePartyMember(image)).toBe('DragonSlayer');
    // Measured 2026-11-02 on the 2026-10-25 frame: 33.9, against 3.3 at most on the others.
    expect(partyGoldScores(image)![3]!).toBeGreaterThan(30);
  });

  it('answers nothing while the skill panel dims the cards', async () => {
    // The World reads at the command phase; a dimmed panel is not a reading (measured 5.5 at most).
    expect(activePartyMember(await imageAt(BATTLE, 'slot-panel-opening.jpg'))).toBeNull();
    expect(activePartyMember(await imageAt(BATTLE, 'slot-panel-slow-attack.jpg'))).toBeNull();
  });

  it('answers nothing off a battle screen', async () => {
    // A 3-D map frame whose glow scores 18.6 in the card rects: the battle HUD is not up.
    expect(activePartyMember(await imageAt(NAV, 'third-floor-glow.jpg'))).toBeNull();
    // The world map's faces are uniformly gold — 49.8 against 42.8 — so no card leads.
    expect(activePartyMember(await imageAt(WORLD, 'center-in-2.jpg'))).toBeNull();
  });

  it('answers nothing off a frame the rects were not measured at', async () => {
    const tiny: RgbaImage = { data: new Uint8Array(4 * 4 * 4), width: 4, height: 4 };
    expect(partyGoldScores(tiny)).toBeNull();
    expect(activePartyMember(tiny)).toBeNull();
  });
});
