import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, Actuator, Frame, Point } from '../src/contracts.ts';
import { SCAN, automoveToExit, automoveToTile, openMap } from '../src/actions/automove.ts';

/** One `holdKey` call, as the fake actuator saw it. */
interface Press { readonly scan: number; readonly holdMs: number }

/** Everything the chain did, in the order it did it: a key press or a tap. */
type Call =
  | { readonly kind: 'key'; readonly scan: number; readonly holdMs: number }
  | { readonly kind: 'tap'; readonly at: Point };

/** A press held shorter than this is dropped by the game at 30 fps (contracts §4). */
const PRESS_MS = 60;

/**
 * The `自动移动` banner's measured rise above the clicked tile: 79–84 px across the instances the
 * operator recorded on 2026-10-24. The test pins the tap point, not the constant, so a re-measured
 * offset has to be re-pinned here.
 */
const POPUP_RISE = 81;

/**
 * An actuator that records every `holdKey` and `tap` and answers from `results` in order,
 * defaulting to `{ ok: true }`. A `doubleTap` would mean the chain had changed gesture, so it
 * fails loudly instead of quietly answering.
 */
function fakeActuator(...results: ActionResult[]): Actuator & { readonly presses: Press[]; readonly taps: Point[]; readonly calls: Call[] } {
  const presses: Press[] = [];
  const taps: Point[] = [];
  const calls: Call[] = [];
  const next = (): ActionResult => results.shift() ?? { ok: true };
  return {
    presses,
    taps,
    calls,
    holdKey: async (scan, holdMs) => {
      presses.push({ scan, holdMs });
      calls.push({ kind: 'key', scan, holdMs });
      return next();
    },
    tap: async (at) => {
      taps.push(at);
      calls.push({ kind: 'tap', at });
      return next();
    },
    doubleTap: () => {
      throw new Error('the automove chain must tap, not double-tap');
    },
    drag: () => {
      throw new Error('the automove chain must not drag');
    },
  };
}

/** A foreground refusal, the failure the chain must never swallow. */
const REJECTED: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };

/** The cell the route picked: the decision's whole decree (the pixel is the map's answer). */
const CELL: Point = { x: 14, y: 18 };

/** The screen point the aim reads for that cell, as `tileOnScreen` hands it over at tap time. */
const TILE: Point = { x: 1_000, y: 400 };

/**
 * An aim that answers with one point and cannot look for the popup: the caller has no frame source,
 * so the walk keeps the measured rise (the module's documented blind path).
 */
const aimAt = (point: Point | null) => ({ locate: async (): Promise<Point | null> => point });

afterEach(() => {
  vi.useRealTimers();
});

describe('the automove command chain (navigation §3d)', () => {
  it('names the keys the dungeon-map legend prints', () => {
    expect(SCAN).toEqual({
      destination: 0x22, // G — 移动至目的地
      mark: 0x10,        // Q — 移动至标记
      exit: 0x21,        // F — 移动至出口
      chest: 0x26,       // L — 移动至宝箱
      pointer: 0x13,     // R — 切换指针模式
    });
  });

  it('opens the map with G, waits for the menu, then presses G again', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator();
    const opening = openMap(actuator);

    // Only the menu press has happened yet: the second G waits for the menu to be drawn.
    await vi.advanceTimersByTimeAsync(0);
    expect(actuator.presses).toEqual([{ scan: SCAN.destination, holdMs: PRESS_MS }]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(opening).resolves.toEqual({ ok: true });
    expect(actuator.presses).toEqual([
      { scan: SCAN.destination, holdMs: PRESS_MS },
      { scan: SCAN.destination, holdMs: PRESS_MS },
    ]);
  });

  it('stops after the first G when the menu press is rejected, and returns it unchanged', async () => {
    const actuator = fakeActuator(REJECTED);
    await expect(openMap(actuator)).resolves.toBe(REJECTED);
    expect(actuator.presses).toEqual([{ scan: SCAN.destination, holdMs: PRESS_MS }]);
  });

  it('returns a rejected map press unchanged instead of retrying', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator({ ok: true }, REJECTED);
    const opening = openMap(actuator);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(opening).resolves.toBe(REJECTED);
    expect(actuator.presses).toHaveLength(2);
  });

  it('walks to a tile in pointer mode: R, the tile, then the popup above it', async () => {
    // navigation §3c/§3d, measured 2026-10-24: a tile click does nothing until R toggles pointer
    // mode, and the 自动移动 element it raises is the second, confirming tap.
    vi.useFakeTimers();
    const actuator = fakeActuator();
    const walking = automoveToTile(actuator, CELL, PRESS_MS, aimAt(TILE));

    // Pointer mode first: a tile click in the default mode is ignored by the game.
    await vi.advanceTimersByTimeAsync(0);
    expect(actuator.presses).toEqual([{ scan: SCAN.pointer, holdMs: PRESS_MS }]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(walking).resolves.toEqual({ ok: true });
    expect(actuator.calls).toEqual([
      { kind: 'key', scan: SCAN.pointer, holdMs: PRESS_MS },
      { kind: 'tap', at: TILE },
      { kind: 'tap', at: { x: TILE.x, y: TILE.y - POPUP_RISE } },
    ]);
  });

  it('stops after R when the pointer toggle is rejected, and returns it unchanged', async () => {
    const actuator = fakeActuator(REJECTED);
    await expect(automoveToTile(actuator, CELL, PRESS_MS, aimAt(TILE))).resolves.toBe(REJECTED);
    expect(actuator.calls).toEqual([{ kind: 'key', scan: SCAN.pointer, holdMs: PRESS_MS }]);
  });

  it('returns a rejected tile tap unchanged and never taps the popup', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator({ ok: true }, REJECTED);
    const walking = automoveToTile(actuator, CELL, PRESS_MS, aimAt(TILE));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(walking).resolves.toBe(REJECTED);
    // One tap only: the popup is not drawn, and a second blind tap would be a different gesture.
    expect(actuator.taps).toEqual([TILE]);
  });

  it('returns a rejected popup tap unchanged', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator({ ok: true }, { ok: true }, REJECTED);
    const walking = automoveToTile(actuator, CELL, PRESS_MS, aimAt(TILE));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(walking).resolves.toBe(REJECTED);
    expect(actuator.taps).toHaveLength(2);
  });

  it('walks to the exit with exactly one F', async () => {
    const actuator = fakeActuator();
    await expect(automoveToExit(actuator)).resolves.toEqual({ ok: true });
    expect(actuator.presses).toEqual([{ scan: SCAN.exit, holdMs: PRESS_MS }]);
  });

  it('presses for the configured hold when one is handed in, on every command', async () => {
    // `worlds.wvd.pressHoldMs` is the operator's value (contracts §8.2). The module used to
    // hardcode 60 ms and silently ignore it (Important 2); a tuned hold must reach the actuator.
    vi.useFakeTimers();
    const configured = 90;
    const actuator = fakeActuator();

    const opening = openMap(actuator, configured);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(opening).resolves.toEqual({ ok: true });
    await automoveToExit(actuator, configured);
    const tileWalk = automoveToTile(actuator, CELL, configured, aimAt(TILE));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(tileWalk).resolves.toEqual({ ok: true });

    expect(actuator.presses).toEqual([
      { scan: SCAN.destination, holdMs: configured },
      { scan: SCAN.destination, holdMs: configured },
      { scan: SCAN.exit, holdMs: configured },
      { scan: SCAN.pointer, holdMs: configured },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The 自動移動 element: the walk looks at it instead of assuming where it is (2026-11-02)
// ---------------------------------------------------------------------------------------------

describe('the 自動移動 element', () => {
  /** A frame from a committed live capture. */
  async function liveFrame(path: string): Promise<Frame> {
    const bytes = await readFile(new URL(path, import.meta.url));
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const image = { data: new Uint8Array(decoded.data), width: decoded.width, height: decoded.height };
    return { atMs: 1_000, width: decoded.width, height: decoded.height, toRgba: async () => image };
  }

  it('taps the pill where the game drew it, not 81 px above the cell', async () => {
    // Live 2026-11-02, the cell north of the party: a tap at (1248,766) raised the pill, whose glyph
    // sits 36 px left of and 78 px above the tap. The old fixed rise would have tapped (1248,685).
    const frame = await liveFrame('../testdata/nav-2026-11-02-automove/element-over-neighbour-cell.jpg');
    const actuator = fakeActuator();
    const tile = { x: 1_248, y: 766 };

    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => tile,
      capture: async () => frame,
      waitMs: 60,
      pollMs: 10,
    });

    expect(result).toEqual({ ok: true });
    expect(actuator.taps).toEqual([tile, { x: 1_212, y: 690 }]);
  });

  it('finds the pill the game clamped below a cell at the top edge', async () => {
    // Live 2026-11-03 21:45: the World walked to the 楼梯-门 at the top of the map, the tap raised the
    // 自動移動 pill **below** the cell instead of above it, the finder's measured band only reached
    // 40 px down, and the walk gave up with "no 自動移動 element" while the prompt was on the screen.
    // The frame is the World's own escalation snapshot of that moment, upscaled to the client size.
    const frame = await liveFrame('../testdata/nav-2026-11-03-stairdoor-pill/pill-below-cell.jpg');
    const actuator = fakeActuator();
    const tile = { x: 960, y: 158 };

    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => tile,
      capture: async () => frame,
      waitMs: 60,
      pollMs: 10,
    });

    expect(result).toEqual({ ok: true });
    // The pill's glyph is 77 px *below* the tap here; the measured chest band cannot reach it.
    expect(actuator.taps).toHaveLength(2);
    expect(actuator.taps[1]).toEqual({ x: 924, y: 235 });
  });

  it('refuses a cell whose tap raised no element, and never taps a second time', async () => {
    // The same map with no pill: the chest cell at (924,154) is 18 rows up, the game has no path.
    const frame = await liveFrame('../testdata/nav-2026-11-02-4f-top-edge/map-player-20-5.jpg');
    const actuator = fakeActuator();
    const tile = { x: 1_248, y: 766 };

    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => tile,
      capture: async () => frame,
      waitMs: 30,
      pollMs: 10,
    });

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    // The cell is tapped twice — once in each pointer mode, because the mode is a toggle the map
    // remembers — but the *rise* is never tapped blind: the refusal is real, and the World skips the
    // cell (live 2026-11-02: a cell 18 rows up the map has no path).
    expect(actuator.taps).toEqual([tile, tile]);
    expect(actuator.presses.filter((press) => press.scan === SCAN.pointer)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The aim is read at tap time, and a walk nobody aimed is not a refused walk (2026-11-06)
// ---------------------------------------------------------------------------------------------

describe('aiming the walk', () => {
  it('refuses without a map reader instead of tapping a point it invented', async () => {
    const actuator = fakeActuator();
    const result = await automoveToTile(actuator, CELL);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(actuator.calls).toEqual([]);
  });

  it('taps nothing when the map could not be read, and says so instead of "no path"', async () => {
    // Live 2026-11-06 02:05: a stale read aimed every tap three cells off, the game raised nothing,
    // and two reachable chests went on the unreachable list. An unaimed walk carries no evidence.
    const actuator = fakeActuator();
    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => null,
      capture: async () => { throw new Error('capture timeout: stale-frame'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect((result as { detail?: string }).detail).toContain('not aimed');
    expect(actuator.taps).toEqual([]);
    // One pointer toggle, never a blind tap of the rise.
    expect(actuator.presses).toEqual([{ scan: SCAN.pointer, holdMs: PRESS_MS }]);
  });

  it('re-locates the point on its one retry instead of re-tapping the stale one', async () => {
    // The map's canvas moves: the retry is aimed again from a frame read then.
    const first = { x: 1_000, y: 400 };
    const second = { x: 1_000, y: 288 };
    const seen: Point[] = [];
    const actuator = fakeActuator();
    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => {
        const next = seen.length === 0 ? first : second;
        seen.push(next);
        return next;
      },
      // A map with no pill: the first aim is refused, so the retry re-aims.
      capture: async () => { throw new Error('capture timeout: stale-frame'); },
    });
    expect(seen).toEqual([first, second]);
    expect(actuator.taps).toEqual([first, second]);
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('never calls a cell unreachable when no frame arrived to look for the element', async () => {
    // The engine's stale-frame bursts must not become a "no path" verdict: nothing was looked at.
    const tile = { x: 1_000, y: 400 };
    const actuator = fakeActuator();
    const result = await automoveToTile(actuator, CELL, PRESS_MS, {
      locate: async () => tile,
      capture: async () => { throw new Error('capture timeout: stale-frame'); },
      waitMs: 30,
      pollMs: 10,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect((result as { detail?: string }).detail).toContain('no frame arrived');
    // Both pointer modes were tried, and no rise was tapped blind.
    expect(actuator.taps).toEqual([tile, tile]);
  });
});
