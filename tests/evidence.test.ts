import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { anchor, penaltyFor, scoreMetric, settle } from '../src/perception/evidence.ts';
import { readMapDetailed } from '../src/perception/map.ts';

/**
 * Graded evidence (2026-11-08). The readers used to be a chain of absolute gates, so one constant set
 * by the wrong corpus vetoed a parse every other fact supported — the 第二区-城内1F map that stalled the
 * run parsed its readout, its title and its lattice and was refused for drawing 13 047 px of white ink
 * against a floor of 15 000.
 *
 * The rule the engine encodes: **anchors veto, metrics weigh**, and the composite's floor decides what
 * a weighted answer is worth. Never act on a missing anchor; always act on a sufficient number.
 */
describe('anchors veto', () => {
  it('refuses when a structural fact is missing, whatever the metrics say', () => {
    const verdict = settle([anchor('readout', true), anchor('chevron', false)], [scoreMetric('panelInk', 40_000, { kind: 'range', good: [15_000, 200_000], soft: 6_000 })]);

    expect(verdict.ok).toBe(false);
    expect(verdict.veto).toBe('chevron');
    expect(verdict.confidence).toBe(0);
  });

  it('carries the measurement behind each anchor for the ledger', () => {
    const verdict = settle([anchor('title', true, 985), anchor('no-title', false, 0)], []);
    expect(verdict.anchors).toEqual([{ name: 'title', ok: true, measured: 985 }, { name: 'no-title', ok: false, measured: 0 }]);
  });
});

describe('metrics weigh', () => {
  it('costs nothing inside the band and everything at the soft edge', () => {
    const shape = { kind: 'range', good: [15_000, 200_000], soft: 6_000 } as const;
    expect(penaltyFor(20_597, shape)).toBe(1);
    expect(penaltyFor(15_000, shape)).toBe(1);
    expect(penaltyFor(12_000, shape)).toBeCloseTo(0.5);
    expect(penaltyFor(13_047, shape)).toBeCloseTo(0.6745, 4);
    expect(penaltyFor(9_000, shape)).toBe(0);
  });

  it('reads "at least" and "at most" bands the same way', () => {
    expect(penaltyFor(0.35, { kind: 'min', good: 0.2, soft: 0.2 })).toBe(1);
    expect(penaltyFor(0.1, { kind: 'min', good: 0.2, soft: 0.2 })).toBeCloseTo(0.5);
    expect(penaltyFor(2.5, { kind: 'max', good: 2, soft: 1 })).toBeCloseTo(0.5);
  });

  it('multiplies independent weights into one confidence', () => {
    const verdict = settle(
      [anchor('readout', true)],
      [
        scoreMetric('panelInk', 13_047, { kind: 'range', good: [15_000, 200_000], soft: 6_000 }),
        scoreMetric('chevronResidual', 2.5, { kind: 'max', good: 2, soft: 1 }),
      ],
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.6745 * 0.5, 4);
  });

  it('keeps the 第二区 canvas above the composite floor: 0.85 x 0.6745 = 0.57', () => {
    // The number that matters (operator rule 2026-11-08: the map page must be read, not sat on): the
    // parse's own 0.85 weighted by the sparse canvas is 0.57 — above the 0.5 the composite acts on.
    const ink = scoreMetric('panelInk', 13_047, { kind: 'range', good: [15_000, 200_000], soft: 6_000 });
    expect(0.85 * ink.penalty).toBeGreaterThan(0.5);
  });
});

describe('the map parse is wired to the engine', () => {
  const FIXTURE = new URL('../testdata/nav-2026-11-01-maps/fourth-2f.jpg', import.meta.url);

  it('publishes its anchors and its ink metric with the parse', async () => {
    const decoded = jpeg.decode(await readFile(FIXTURE), { useTArray: true, formatAsRGBA: true });
    const image = { data: decoded.data, width: decoded.width, height: decoded.height };
    const parsed = await readMapDetailed({ atMs: 0, width: image.width, height: image.height, toRgba: async () => image });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.evidence.anchors.map((entry) => entry.name)).toEqual(expect.arrayContaining(['readout', 'title', 'lattice', 'chevron']));
    expect(parsed.evidence.metrics).toEqual([{ name: 'panelInk', value: 20_597, penalty: 1 }]);
    expect(parsed.confidence).toBe(0.85);
  });
});
