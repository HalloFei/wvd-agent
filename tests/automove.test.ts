import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult, Actuator } from '../src/contracts.ts';
import { SCAN, automoveToChest, automoveToExit, openMap } from '../src/actions/automove.ts';

/** One `holdKey` call, as the fake actuator saw it. */
interface Press { readonly scan: number; readonly holdMs: number }

/** A press held shorter than this is dropped by the game at 30 fps (contracts §4). */
const PRESS_MS = 60;

/**
 * An actuator that records every `holdKey` and answers from `results` in order, defaulting to
 * `{ ok: true }`. A `tap` or `doubleTap` would mean the module had left the key path, so the double
 * fails loudly instead of quietly answering.
 */
function fakeActuator(...results: ActionResult[]): Actuator & { readonly presses: Press[] } {
  const presses: Press[] = [];
  const unsupported = (): Promise<ActionResult> => {
    throw new Error('the automove chain must press keys, not tap');
  };
  return {
    presses,
    holdKey: async (scan, holdMs) => {
      presses.push({ scan, holdMs });
      return results.shift() ?? { ok: true };
    },
    tap: unsupported,
    doubleTap: unsupported,
  };
}

/** A foreground refusal, the failure the chain must never swallow. */
const REJECTED: ActionResult = { ok: false, reason: 'rejected', detail: 'not-foreground' };

afterEach(() => {
  vi.useRealTimers();
});

describe('the automove command chain (navigation §3d)', () => {
  it('names the four keys the dungeon-map legend prints', () => {
    expect(SCAN).toEqual({
      destination: 0x22, // G — 移动至目的地
      mark: 0x10,        // Q — 移动至标记
      exit: 0x21,        // F — 移动至出口
      chest: 0x26,       // L — 移动至宝箱
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

  it('walks to a chest with exactly one L', async () => {
    const actuator = fakeActuator();
    await expect(automoveToChest(actuator)).resolves.toEqual({ ok: true });
    expect(actuator.presses).toEqual([{ scan: SCAN.chest, holdMs: PRESS_MS }]);
  });

  it('returns a rejected chest command unchanged', async () => {
    const actuator = fakeActuator(REJECTED);
    await expect(automoveToChest(actuator)).resolves.toBe(REJECTED);
    expect(actuator.presses).toEqual([{ scan: SCAN.chest, holdMs: PRESS_MS }]);
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
    await automoveToChest(actuator, configured);
    await automoveToExit(actuator, configured);

    expect(actuator.presses).toEqual([
      { scan: SCAN.destination, holdMs: configured },
      { scan: SCAN.destination, holdMs: configured },
      { scan: SCAN.chest, holdMs: configured },
      { scan: SCAN.exit, holdMs: configured },
    ]);
  });
});
