import { describe, expect, it } from 'vitest';
import { nextPageCloseTries } from '../src/policy/page-episode.ts';

/**
 * The close budget is per page **episode**: a frame the page was not named on does not end it, because the
 * game animates the page in (live 2026-11-07 22:42 and 22:54: the counter reset on every flicker, so the
 * cap never fired and the Esc never went out).
 */
describe('the character page episode', () => {
  it('keeps the budget while the page, or a frame it was not named on, is on screen', () => {
    expect(nextPageCloseTries('character-page', 2)).toBe(2);
    expect(nextPageCloseTries('unknown', 2)).toBe(2);
    expect(nextPageCloseTries('loading', 2)).toBe(2);
  });

  it('ends the episode when another screen is named', () => {
    expect(nextPageCloseTries('dungeon', 2)).toBe(0);
    expect(nextPageCloseTries('combat', 2)).toBe(0);
    expect(nextPageCloseTries('dungeonmap', 2)).toBe(0);
    expect(nextPageCloseTries('inn', 3)).toBe(0);
  });
});
