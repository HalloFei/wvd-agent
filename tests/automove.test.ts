import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, Actuator, Point } from '../src/contracts.ts';
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
  };
}

/** A foreground refusal, the failure the chain must never swallow. */
const REJECTED: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };

/** The tile the route picked, in screen pixels, as `tileOnScreen` hands it over. */
const TILE: Point = { x: 1_000, y: 400 };

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
    const walking = automoveToTile(actuator, TILE);

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
    await expect(automoveToTile(actuator, TILE)).resolves.toBe(REJECTED);
    expect(actuator.calls).toEqual([{ kind: 'key', scan: SCAN.pointer, holdMs: PRESS_MS }]);
  });

  it('returns a rejected tile tap unchanged and never taps the popup', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator({ ok: true }, REJECTED);
    const walking = automoveToTile(actuator, TILE);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(walking).resolves.toBe(REJECTED);
    // One tap only: the popup is not drawn, and a second blind tap would be a different gesture.
    expect(actuator.taps).toEqual([TILE]);
  });

  it('returns a rejected popup tap unchanged', async () => {
    vi.useFakeTimers();
    const actuator = fakeActuator({ ok: true }, { ok: true }, REJECTED);
    const walking = automoveToTile(actuator, TILE);
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
    const tileWalk = automoveToTile(actuator, TILE, configured);
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
