import { describe, expect, it } from 'vitest';
import { OPERATION_PACE_MS, Pacer, STABLE_FRAMES } from '../src/policy/pacing.ts';

/**
 * The pacing primitive (operator rule 2026-11-03): *a tap is one primitive operation in game control;
 * each is done on stable frames or animations, with 0.5 to 1 second pacing.* It exists because the
 * loop tapped the character page's close eight times in four seconds while the page animated, and the
 * tap that landed after the page left opened another member's page from the 3-D view (live 2026-11-03
 * 20:23).
 */
describe('the pacing primitive', () => {
  it('holds an operation until the frame is stable, and one per pace', () => {
    const pacer = new Pacer();
    pacer.observe('combat');
    // The first frame carrying a screen is a transition through it: not stable yet.
    expect(pacer.ready(0)).toBe(false);
    pacer.observe('combat');
    expect(STABLE_FRAMES).toBe(2);
    expect(pacer.ready(0)).toBe(true);

    pacer.act(0);
    expect(pacer.ready(100)).toBe(false);          // inside the pace
    expect(pacer.ready(OPERATION_PACE_MS - 1)).toBe(false);
    expect(pacer.ready(OPERATION_PACE_MS)).toBe(true);
  });

  it('starts the count over when the screen changes', () => {
    const pacer = new Pacer();
    pacer.observe('dungeon');
    pacer.observe('dungeon');
    expect(pacer.ready(0)).toBe(true);

    pacer.observe('character-page');               // the page replaced the view: unstable again
    expect(pacer.ready(5_000)).toBe(false);
    pacer.observe('character-page');
    expect(pacer.ready(5_000)).toBe(true);
  });

  it('resets to a fresh session', () => {
    const pacer = new Pacer();
    pacer.observe('combat');
    pacer.observe('combat');
    pacer.act(0);
    pacer.reset();
    pacer.observe('combat');
    expect(pacer.ready(10_000)).toBe(false);       // a new session proves its first frame too
  });
});
