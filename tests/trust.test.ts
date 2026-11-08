import { describe, expect, it } from 'vitest';
import { createTrust } from '../src/policy/trust.ts';

/**
 * Verification by action (2026-11-08): the loop's own outcome evidence decides how strictly a screen's
 * next read is held. It never decides *what* is on screen — the readers do — and it never overrides an
 * anchor veto; it only scales the floor a graded read must clear.
 */
describe('the trust book', () => {
  it('has no opinion until the screen has a record', () => {
    const trust = createTrust();
    expect(trust.factor('dungeonmap')).toBe(1);
    expect(trust.snapshot()).toEqual([]);
  });

  it('eases a screen that has been confirmed three times in a row, never below the ceiling', () => {
    const trust = createTrust();
    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(1);
    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(1);
    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(0.85);
  });

  it('demands more from a screen the loop just contradicted, until a confirmation returns it', () => {
    const trust = createTrust();
    trust.confirmed('dungeonmap');
    trust.confirmed('dungeonmap');
    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(0.85);

    trust.contradicted('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(1.25);

    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(1);      // back to neutral, not yet eased
    trust.confirmed('dungeonmap');
    trust.confirmed('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(0.85);   // earned again
  });

  it('keeps one record per screen', () => {
    const trust = createTrust();
    trust.contradicted('dungeonmap');
    expect(trust.factor('dungeonmap')).toBe(1.25);
    expect(trust.factor('character-page')).toBe(1);
    expect(trust.snapshot()).toEqual([{ screen: 'dungeonmap', streak: 0, factor: 1.25 }]);
  });

  it('stays inside its bounds whatever the caller passes', () => {
    const wild = createTrust({ eased: 0.1, strict: 99, successesToEase: 0 });
    expect(wild.factor('town')).toBe(1);
    const trust = createTrust({ successesToEase: 0 });
    trust.confirmed('town');
    expect(trust.factor('town')).toBeLessThanOrEqual(1);
    expect(trust.factor('town')).toBeGreaterThanOrEqual(0.5);
  });
});
