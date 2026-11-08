import { describe, expect, it } from 'vitest';
import type { ActionResult, Point } from '../src/contracts.ts';
import type { MapInput, MapSenses } from '../src/actions/map-travel.ts';
import { travelToSite, withForegroundRetry } from '../src/actions/map-travel.ts';

/**
 * The travel is four steps over injected senses and input — find, tap, swipe-and-look, budget — so its
 * test is a toy map: the target lives at a world point, the view has an offset, and a swipe moves the view
 * by a fixed amount. There is no cursor in this model at all: the tap places it.
 */
const STRIP = { x: 480, y: 0, width: 960, height: 1_080 };

interface Toy {
  offset: Point;
  taps: Point[];
  swipes: string[];
}

function toy(target: Point): { senses: MapSenses; input: MapInput; state: Toy } {
  const state: Toy = { offset: { x: 0, y: 0 }, taps: [], swipes: [] };
  const screen = (world: Point): Point => ({ x: world.x - state.offset.x, y: world.y - state.offset.y });
  const visible = (at: Point): boolean =>
    at.x >= STRIP.x && at.x <= STRIP.x + STRIP.width && at.y >= 0 && at.y <= STRIP.height;
  const senses: MapSenses = {
    site: async () => {
      const at = screen(target);
      return visible(at) ? { at, confidence: 0.96 } : null;
    },
  };
  const input: MapInput = {
    swipe: async (direction): Promise<ActionResult> => {
      state.swipes.push(direction);
      if (direction === 'd') state.offset = { x: state.offset.x + 400, y: state.offset.y };
      if (direction === 'a') state.offset = { x: state.offset.x - 400, y: state.offset.y };
      if (direction === 's') state.offset = { x: state.offset.x, y: state.offset.y + 400 };
      if (direction === 'w') state.offset = { x: state.offset.x, y: state.offset.y - 400 };
      return { ok: true };
    },
    tap: async (at): Promise<ActionResult> => {
      state.taps.push(at);
      return { ok: true };
    },
    sleep: async () => undefined,
  };
  return { senses, input, state };
}

describe('travelling to a site', () => {
  it('taps the matched icon directly — no hover, no ring, no cursor move', async () => {
    const { senses, input, state } = toy({ x: 700, y: 300 });
    const result = await travelToSite(senses, input);
    expect(result.ok).toBe(true);
    expect(state.taps).toHaveLength(1);
    expect(Math.abs(state.taps[0]!.x - 700)).toBeLessThanOrEqual(4);
    expect(state.swipes).toHaveLength(0);
  });

  it('swipes and looks again until the target is in view', async () => {
    // Off the right of the first view (world x 1600 is outside 480..1440).
    const { senses, input, state } = toy({ x: 1_600, y: 300 });
    const result = await travelToSite(senses, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.swipes).toBeGreaterThan(0);
    expect(state.swipes.every((direction) => direction === 'd')).toBe(true);
    expect(state.taps).toHaveLength(1);
    expect(state.taps[0]!.x).toBeGreaterThanOrEqual(STRIP.x);
    expect(state.taps[0]!.x).toBeLessThanOrEqual(STRIP.x + STRIP.width);
  });

  it('gives up at its budget instead of swiping for ever', async () => {
    // The target is nowhere: the travel must stop at the bound and say so, not loop.
    const { senses, input, state } = toy({ x: -50_000, y: 300 });
    const result = await travelToSite(senses, input, { budgetMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('budget');
    expect(state.taps).toHaveLength(0);
  });
});

describe('a refused press', () => {
  it('re-takes the foreground and retries five times, three seconds apart', async () => {
    const sleeps: number[] = [];
    let focuses = 0;
    let sent = 0;
    const refused: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };
    const outcome = await withForegroundRetry(async () => {
      sent += 1;
      return sent <= 3 ? refused : { ok: true };
    }, {
      sleep: async (ms) => { sleeps.push(ms); },
      focus: async () => { focuses += 1; return true; },
    });
    expect(outcome.ok).toBe(true);
    expect(focuses).toBe(3);
    expect(sleeps).toEqual([3_000, 3_000, 3_000]);
  });

  it('stops at the fifth attempt and returns the refusal unchanged', async () => {
    let sent = 0;
    const outcome = await withForegroundRetry(async () => {
      sent += 1;
      return { ok: false, reason: 'rejected', detail: 'not-foreground' };
    }, { sleep: async () => undefined });
    expect(outcome.ok).toBe(false);
    expect(sent).toBe(6);
  });
});
