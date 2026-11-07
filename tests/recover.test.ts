import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/contracts.ts';
import { PARTY_PANEL_COLLAPSE, recoverStep } from '../src/policy/recover.ts';

const at = { x: 960, y: 540 };
function observation(screen: Observation['screen'], extra: Record<string, unknown> = {}): Observation {
  return { screen, atMs: 0, confidence: 1, ...extra } as Observation;
}

describe('the recovery policy', () => {
  it('takes a page by its own exit', () => {
    expect(recoverStep(observation('ui-menu', { page: 'missions', title: '每日任务', exit: at }))).toEqual({
      kind: 'exit-page', at, page: 'missions', label: 'its exit',
    });
  });

  it('uses the catalogue exit for a page with its own screen id', () => {
    const step = recoverStep(observation('character-page'));
    expect(step.kind).toBe('exit-page');
    if (step.kind !== 'exit-page') return;
    expect(step.page).toBe('character-page');
  });

  it('reveals the world map on the town page', () => {
    expect(recoverStep(observation('town'))).toEqual({ kind: 'collapse-party-panel', at: PARTY_PANEL_COLLAPSE });
  });

  it('collapses the panel on the chevron the live client draws, not the screenshot point', () => {
    // Measured: the 34x26 sample in `src/perception/town-template.ts` sits at (679,789) on
    // `testdata/screens/2026-11-07-town-live/town-1920.jpg`, so the control's centre is (696,802).
    const box = { x: 679, y: 789, width: 34, height: 26 };
    const step = recoverStep(observation('town'));
    expect(step.kind).toBe('collapse-party-panel');
    if (step.kind !== 'collapse-party-panel') return;
    expect(step.at.x).toBeGreaterThanOrEqual(box.x);
    expect(step.at.x).toBeLessThan(box.x + box.width);
    expect(step.at.y).toBeGreaterThanOrEqual(box.y);
    expect(step.at.y).toBeLessThan(box.y + box.height);
    expect(step.at).toEqual({ x: 696, y: 802 });
  });

  it('takes one Esc on an unnamed screen', () => {
    expect(recoverStep(observation('unknown'))).toEqual({ kind: 'back' });
  });

  it('is done on a screen the route can act on', () => {
    for (const screen of ['dungeon', 'dungeonmap', 'worldmap', 'dungeon-select'] as const) {
      expect(recoverStep(observation(screen)).kind).toBe('done');
    }
  });

  it('is done when a screen has no recorded exit', () => {
    expect(recoverStep(observation('harken-menu')).kind).toBe('done');
  });
});
