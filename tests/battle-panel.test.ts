/**
 * The battle skill panel's 確定 is **located on the frame**, not a constant (operator rule 2026-11-07:
 * *read the panel and tap the confirmation once you see it*). The sample is the live client's own
 * button, and the frames here are the live ones: the panel frame the two failed runs sat on, a battle
 * command phase without it, and the town — the score gap is what the floor stands on.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { RgbaImage } from '../src/contracts.ts';
import {
  BATTLE_PANEL_CONFIRM, BATTLE_PANEL_CONFIRM_MIN_SCORE, battlePanelBand, locateSkillPanelConfirm,
} from '../src/perception/battle-panel.ts';

const dir = new URL('../testdata/', import.meta.url);

function loadJpeg(relative: string): RgbaImage {
  const decoded = jpeg.decode(readFileSync(new URL(relative, dir)), { useTArray: true, formatAsRGBA: true });
  return { width: decoded.width, height: decoded.height, data: decoded.data };
}

/** The live panel frame (拉巴迪奥斯的秘术, 取消 / 確定) the runs of 2026-11-07 22:00 and 22:13 sat on. */
const panel = (): RgbaImage => loadJpeg('screens/2026-11-07-battle-panel/panel-1920.jpg');

describe('the battle skill panel', () => {
  it('finds 確定 on the live panel, at the button it was measured on', () => {
    const found = locateSkillPanelConfirm(panel());
    expect(found).not.toBeNull();
    // The button's centre: 取消 spans x 781–946 and 確定 x 971–1135, the row is y 976–1037.
    expect(found!.at.x).toBeGreaterThanOrEqual(1_050);
    expect(found!.at.x).toBeLessThanOrEqual(1_056);
    expect(found!.at.y).toBeGreaterThanOrEqual(1_003);
    expect(found!.at.y).toBeLessThanOrEqual(1_009);
    expect(found!.score).toBeGreaterThanOrEqual(0.95);
  });

  it('says nothing about a battle that is not showing the panel', () => {
    // A press here would land on the command phase — a lost turn, and the cast still owed.
    expect(locateSkillPanelConfirm(loadJpeg('battle-2026-11-02/command-phase.jpg'))).toBeNull();
    expect(locateSkillPanelConfirm(loadJpeg('screens/2026-11-07-town-live/town-1920.jpg'))).toBeNull();
  });

  it('searches the frame\'s lower middle, by proportion, and keeps the sample in that band', () => {
    const band = battlePanelBand(1_920, 1_080);
    expect(band.x).toBeGreaterThan(0);
    expect(band.y).toBeGreaterThan(1_080 / 2);
    expect(band.x + band.width).toBeLessThanOrEqual(1_920);
    expect(band.y + band.height).toBeLessThanOrEqual(1_080);
    expect(BATTLE_PANEL_CONFIRM.gray).toHaveLength(BATTLE_PANEL_CONFIRM.width * BATTLE_PANEL_CONFIRM.height);
    // The floor sits between the measured hits (1.000) and the best false positive (< 0.55).
    expect(BATTLE_PANEL_CONFIRM_MIN_SCORE).toBeGreaterThan(0.55);
    expect(BATTLE_PANEL_CONFIRM_MIN_SCORE).toBeLessThan(0.95);
  });

  it('answers a located point, or nothing: a frame without the panel never becomes a guess', () => {
    const found = locateSkillPanelConfirm(panel());
    expect(found).not.toBeNull();
    expect(Number.isFinite(found!.at.x) && Number.isFinite(found!.at.y)).toBe(true);
  });
});
