import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, Observation, Perceiver, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { readFacts, type FrameFacts } from '../src/perception/facts.ts';
import { SCREENS, screenStandings, settlesAgainst } from '../src/perception/screens.ts';

const FFXI = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);
const NAV = new URL('../testdata/nav-1024-0213/', import.meta.url);
const LIVE = new URL('../testdata/screens/2026-10-25-live/', import.meta.url);
const FRAMES = new URL('../testdata/frames/', import.meta.url);
const GMENU = new URL('../testdata/screens/2026-11-03-gmenu/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

const factsAt = async (dir: URL, name: string): Promise<FrameFacts> => readFacts(await imageAt(dir, name));

class Fixed implements Perceiver {
  constructor(private readonly answer: Observation) {}

  async observe(): Promise<Observation> {
    return this.answer;
  }
}

describe('the screen table', () => {
  it('stands every screen on every frame', async () => {
    const standings = screenStandings(await factsAt(FFXI, 'combat.jpg'));
    expect(standings.map((standing) => standing.screen).sort()).toEqual([...SCREENS].sort());
  });

  it('supports a battle on both battle layouts, and rules it out nowhere', async () => {
    for (const [dir, name] of [[LIVE, 'combat-command.jpg'], [FFXI, 'combat.jpg']] as const) {
      const standings = screenStandings(await factsAt(dir, name));
      expect(settlesAgainst(standings, 'combat')).toBe(false);
      expect(standings.find((standing) => standing.screen === 'combat')?.support)
        .toBeGreaterThanOrEqual(0.8);
    }
  });

  it('rules a battle out on a map whose walls light both button windows', async () => {
    const facts = await factsAt(NAV, 'popup.jpg');
    expect(facts.speedInk).toBeGreaterThan(0.004);
    expect(facts.autoInk).toBeGreaterThan(0.004);
    expect(settlesAgainst(screenStandings(facts), 'combat')).toBe(true);
  });

  it('rules a battle out on the 3-D view and supports the dungeon', async () => {
    const standings = screenStandings(await factsAt(FFXI, 'view-empty-minimap.jpg'));
    expect(settlesAgainst(standings, 'combat')).toBe(true);
    expect(standings.find((standing) => standing.screen === 'dungeon')?.support).toBeGreaterThan(0.5);
  });

  it('rules the dungeon and the battle out on a map and on a titled screen', async () => {
    // A title is characters: only real title text rules the 3-D view out (2026-11-03). The town's
    // band is bright paint, not a title, and the town draws no minimap either.
    for (const [dir, name] of [[FFXI, 'map.jpg'], [NAV, 'popup.jpg'], [FFXI, 'dungeon-select.jpg']] as const) {
      const standings = screenStandings(await factsAt(dir, name));
      expect(settlesAgainst(standings, 'dungeon')).toBe(true);
      expect(settlesAgainst(standings, 'combat')).toBe(true);
    }
  });
});

describe('CompositePerceiver over the table', () => {
  it('drops an answer for a screen the frame rules out', async () => {
    const select = await frameAt(FFXI, 'dungeon-select.jpg');
    const liar = new Fixed({ screen: 'dungeon', atMs: 0, confidence: 0.95 });
    const classification = await new CompositePerceiver([{ perceiver: liar, floor: 0.5 }])
      .classify(select);
    expect(classification.answer.screen).toBe('unknown');
  });

  it('reads the battle toggles from their highlight', async () => {
    // Measured 2026-11-03: a toggle that is on is drawn gold (warmth 39.5–56.4 in its window), one that
    // is off white/grey (1.0–2.3). The battle order needs the two states before it presses anything.
    const bothOff = await new CombatPerceiver().observe(await frameAt(BATTLE, 'alice-command-phase.jpg'));
    expect(bothOff).toMatchObject({ screen: 'combat', speedOn: false, autoOn: false });
    const speedOn = await new CombatPerceiver().observe(await frameAt(BATTLE, 'command-phase.jpg'));
    expect(speedOn).toMatchObject({ screen: 'combat', speedOn: true, autoOn: false });
  });

  it('returns a survivor that clears its floor, and reports the standings it applied', async () => {
    const battle = await frameAt(LIVE, 'combat-command.jpg');
    const classification = await new CompositePerceiver([
      { perceiver: new CombatPerceiver(), floor: 0.5 },
    ]).classify(battle);
    expect(classification.answer.screen).toBe('combat');
    expect(classification.standings.some((standing) => standing.screen === 'combat'
      && !standing.ruledOut)).toBe(true);
  });

  it('names the 3-D view with its menu legend, whose band is bright paint and not a title', async () => {
    // t-mvy23qe2, operator rule 2026-11-03: the minimap is the dungeon's own evidence, and a title is
    // characters. This frame's band carries 5 227 bright pixels of glowing wall and not one stroke, so
    // no title is drawn and the arrow stands: the frame is the 3-D view, not an unnamed one.
    const frame = await frameAt(GMENU, 'gmenu-3d-view.jpg');
    const facts = readFacts(await imageAt(GMENU, 'gmenu-3d-view.jpg'));
    expect(facts.minimapArrowPx).toBeGreaterThanOrEqual(8);
    expect(facts.titleBarInkPx).toBe(0);
    expect(settlesAgainst(screenStandings(facts), 'dungeon')).toBe(false);
    expect((await new HudPerceiver().observe(frame)).screen).toBe('dungeon');
    const classification = await new CompositePerceiver([{ perceiver: new HudPerceiver(), floor: 0.5 }])
      .classify(frame);
    expect(classification.answer.screen).toBe('dungeon');
  });

  it('refuses a ruled-out answer but keeps its confidence as evidence of a drawn frame', async () => {
    // The screen is wrong; the frame is not empty. `unknown` at 0 would stop the session (§2).
    const select = await frameAt(FFXI, 'dungeon-select.jpg');
    const liar = new Fixed({ screen: 'combat', atMs: 0, confidence: 1 });
    const classification = await new CompositePerceiver([{ perceiver: liar, floor: 0.5 }])
      .classify(select);
    expect(classification.answer).toEqual({ screen: 'unknown', atMs: 0, confidence: 1 });
    expect(settlesAgainst(classification.standings, 'combat')).toBe(true);
  });
});
