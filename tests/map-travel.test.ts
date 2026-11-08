import { describe, expect, it } from 'vitest';
import type { ActionResult, Point } from '../src/contracts.ts';
import type { MapInput, MapSenses } from '../src/actions/map-travel.ts';
import { travelToSite, withForegroundRetry } from '../src/actions/map-travel.ts';

/**
 * The travel is a state machine over injected senses and input, so its test is a toy map: the target
 * lives at a world point, the view has an offset, a key hold moves the pointer, and a hold with the
 * pointer already at the strip's edge moves the *view* — which is the operator's edge push, and the
 * reason a push has a measurable rate.
 */
const STRIP = { x: 480, y: 0, width: 960, height: 1_080 };
const RATE = 0.9;                       // map px per ms of edge push (the toy map's own rate)

interface Toy {
  offset: Point;
  pointer: Point;
  level: 0 | 1 | 2;
  rings: boolean;
  taps: Point[];
  holds: string[];
}

function toy(target: Point): { senses: MapSenses; input: MapInput; state: Toy } {
  const state: Toy = {
    offset: { x: 0, y: 0 },
    pointer: { x: 900, y: 500 },
    level: 0,
    rings: true,
    taps: [],
    holds: [],
  };
  const screen = (world: Point): Point => ({ x: world.x - state.offset.x, y: world.y - state.offset.y });
  const visible = (at: Point): boolean =>
    at.x >= STRIP.x && at.x <= STRIP.x + STRIP.width && at.y >= 0 && at.y <= STRIP.height;
  const senses: MapSenses = {
    site: async (level, wantTitle) => {
      void level;
      void wantTitle;
      const at = screen(target);
      return visible(at) ? { at, confidence: 0.96 } : null;
    },
    ring: async () => state.rings,
    pointer: async () => state.pointer,
    landmark: async () => {
      const at = screen({ x: 200, y: 200 });
      return visible(at) ? { id: 'landmark', at } : null;
    },
  };
  const input: MapInput = {
    hold: async (direction, holdMs): Promise<ActionResult> => {
      state.holds.push(direction + ' ' + holdMs);
      const step = Math.round(holdMs * 1);            // the pointer: 1 px/ms at every level
      const atEdge = state.pointer.x >= STRIP.x + STRIP.width - 60;
      if (direction === 'd' && atEdge) {
        // The edge push: the view moves, the pointer stays where it is.
        state.offset = { x: state.offset.x + Math.round(holdMs * RATE), y: state.offset.y };
        return { ok: true };
      }
      if (direction === 'd') state.pointer = { x: state.pointer.x + step, y: state.pointer.y };
      if (direction === 'a') state.pointer = { x: state.pointer.x - step, y: state.pointer.y };
      if (direction === 's') state.pointer = { x: state.pointer.x, y: state.pointer.y + step };
      if (direction === 'w') state.pointer = { x: state.pointer.x, y: state.pointer.y - step };
      return { ok: true };
    },
    swipe: async (direction): Promise<ActionResult> => {
      // The toy map's view moves by a fixed 400 px, in the direction the view travels.
      state.holds.push('swipe ' + direction);
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
    zoom: async (direction) => {
      if (direction === 'in') state.level = Math.min(2, state.level + 1) as 0 | 1 | 2;
      else state.level = Math.max(0, state.level - 1) as 0 | 1 | 2;
      return true;
    },
    sleep: async () => undefined,
  };
  return { senses, input, state };
}

describe('travelling to a site', () => {
  it('taps the icon only after the ring, on a view where the pair was found', async () => {
    const { senses, input, state } = toy({ x: 700, y: 300 });
    const result = await travelToSite(senses, input, { railX: 400, railY: 416 });
    expect(result.ok).toBe(true);
    // The coarse level found the icon; level 1 confirmed the pair; the tap is on the icon.
    expect(state.taps).toHaveLength(1);
    expect(Math.abs(state.taps[0]!.x - 700)).toBeLessThanOrEqual(12);
    expect(Math.abs(state.taps[0]!.y - 300)).toBeLessThanOrEqual(12);
  });

  it('pushes the view by the measured rate until the target is in sight', async () => {
    // Off the right of the first view (world x 1600 is outside the strip's 480..1440), so the travel
    // must edge-push the map and only then find it.
    const { senses, input, state } = toy({ x: 1_600, y: 300 });
    const result = await travelToSite(senses, input, { railX: 400, railY: 416 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pushes).toBeGreaterThan(0);
    expect(state.holds.some((hold) => hold.startsWith('swipe'))).toBe(true);
    // The tap is on the icon **as drawn after the push**, not on the world coordinate.
    expect(state.taps).toHaveLength(1);
    expect(state.taps[0]!.x).toBeGreaterThanOrEqual(STRIP.x);
    expect(state.taps[0]!.x).toBeLessThanOrEqual(STRIP.x + STRIP.width);
  });

  it('taps the matched icon directly, with no hover and no ring gate', async () => {
    // Operator, 2026-11-09: we do not need hover + ring at all. The click places the cursor, exactly as
    // the legacy navigator presses the matched coordinate; a hover step is a dependency on reading the
    // pointer, and that is where the live travel failed.
    const { senses, input, state } = toy({ x: 700, y: 300 });
    state.rings = false;
    const result = await travelToSite(senses, input, { railX: 400, railY: 416 });
    expect(result.ok).toBe(true);
    expect(state.taps).toHaveLength(1);
    expect(Math.abs(state.taps[0]!.x - 700)).toBeLessThanOrEqual(12);
  });
});


describe('a refused press', () => {
  it('re-takes the foreground and retries five times before giving up, three seconds apart', async () => {
    // Operator, 2026-11-09: a window that lost focus is not a failed travel. The engine tries to focus
    // once per press; this is the travel's own retry, with a pause long enough for the window to come back.
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
    expect(sent).toBe(6);      // the first press, then five retries
  });
});
