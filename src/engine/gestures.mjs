/**
 * The input gesture rules (contracts §4, R21), with the Win32 device injected so they can be tested
 * without a window and without sending a single byte of real input.
 *
 * The rule: guard the press, always complete the gesture. The foreground is asserted immediately
 * before every down; the matching up is always sent, because a stuck button or key is worse than a
 * refused one. A gesture whose window moved mid-press reports `rejected` after the release.
 *
 * `releaseHeld()` is the last resort for a process that is going away mid-gesture (holdKey
 * cancellation): it sends the releases for anything still down, synchronously.
 */

/** A refusal the child turns into `{ ok:false, error:'rejected', detail:'not-foreground' }`. */
export class Refused extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'Refused';
    this.detail = detail;
  }
}

/** The shortest press the game sees: a 0 ms press is dropped at 30 fps (contracts §4). */
export const PRESS_MS = 60;

/**
 * The longest drag a caller may ask for (contracts §4). The button is down for the whole drag, so
 * the same teardown rule as a key hold applies: the ceiling must stay below `TEARDOWN_GRACE_MS`.
 * `tests/engine.test.ts` asserts that against the World's copy of the constant.
 */
export const MAX_DRAG_MS = 500;

/**
 * The drag's move cadence: one move per 10 ms, clamp 4..60. The game samples the pointer at its own
 * 30 fps and reads the world-map pan from the motion it sees between samples; at 25 ms per move it
 * saw about one event per frame and the pan was not repeatable (measured 2026-11-01). A finer
 * cadence, and a press held for PRESS_MS before the first move, makes the gesture look like a human
 * drag instead of a click that ends somewhere else.
 */
const DRAG_MOVE_MS = 10;
const DRAG_MIN_MOVES = 4;
const DRAG_MAX_MOVES = 60;

/**
 * `device` is the Win32 surface:
 *   isForeground(hwnd), moveToClient(hwnd, x, y), mouseDown(), mouseUp(), keyDown(scan),
 *   keyUp(scan), sleep(ms).
 */
export function createGestures(device) {
  const held = { mouse: 0, keys: new Set() };

  async function tap(hwnd, x, y, count) {
    let refused = false;
    for (let index = 0; index < count; index++) {
      if (!device.isForeground(hwnd)) {
        refused = true;
        break;
      }
      device.moveToClient(hwnd, x, y);
      device.mouseDown();
      held.mouse++;
      try {
        await device.sleep(PRESS_MS);
      } finally {
        // the matching up is unconditional; skip it only when releaseHeld already sent it
        if (held.mouse > 0) {
          held.mouse--;
          device.mouseUp();
        }
      }
      if (!device.isForeground(hwnd)) {
        refused = true;
        break;
      }
      if (index < count - 1) await device.sleep(PRESS_MS);
    }
    if (refused) throw new Refused('not-foreground');
  }

  /**
   * A press at the start point, a straight-line move through the destination, then the release.
   * The foreground is asserted before the down and after the release, exactly as for a tap; the
   * release is unconditional, so a refused or torn-down drag never leaves the button down.
   * Intermediate moves are what the game sees as a drag — one jump is a click that happens to end
   * somewhere else.
   */
  async function drag(hwnd, fromX, fromY, toX, toY, durationMs) {
    if (!device.isForeground(hwnd)) throw new Refused('not-foreground');
    const total = Math.min(MAX_DRAG_MS, Math.max(1, Math.round(durationMs)));
    const steps = Math.min(DRAG_MAX_MOVES, Math.max(DRAG_MIN_MOVES, Math.ceil(total / DRAG_MOVE_MS)));
    device.moveToClient(hwnd, fromX, fromY);
    device.mouseDown();
    held.mouse++;
    try {
      // Hold the press a beat before moving: the map reads a press that is already down as a drag,
      // and a press-then-immediate-move as a click.
      await device.sleep(PRESS_MS);
      for (let step = 1; step <= steps; step += 1) {
        await device.sleep(total / steps);
        device.moveToClient(
          hwnd,
          fromX + ((toX - fromX) * step) / steps,
          fromY + ((toY - fromY) * step) / steps,
        );
      }
    } finally {
      // the matching up is unconditional, exactly as for a tap
      if (held.mouse > 0) {
        held.mouse--;
        device.mouseUp();
      }
    }
    if (!device.isForeground(hwnd)) throw new Refused('not-foreground');
  }

  async function holdKey(hwnd, scan, holdMs) {
    if (!device.isForeground(hwnd)) throw new Refused('not-foreground');
    device.keyDown(scan);
    held.keys.add(scan);
    try {
      await device.sleep(Math.max(PRESS_MS, Math.round(holdMs)));
    } finally {
      if (held.keys.delete(scan)) device.keyUp(scan);
    }
    if (!device.isForeground(hwnd)) throw new Refused('not-foreground');
  }

  /** Sends the releases for anything still down; safe to call more than once. */
  function releaseHeld() {
    while (held.mouse > 0) {
      held.mouse--;
      try {
        device.mouseUp();
      } catch {
        // the process is going away; keep releasing the rest
      }
    }
    for (const scan of [...held.keys]) {
      held.keys.delete(scan);
      try {
        device.keyUp(scan);
      } catch {
        // as above
      }
    }
  }

  /** What is still down, for tests and diagnostics. */
  function heldButtons() {
    return { mouse: held.mouse, keys: [...held.keys] };
  }

  return { tap, drag, holdKey, releaseHeld, heldButtons };
}

/**
 * The `{ inputMs }` value of a successful tap/key reply (contracts §5): request receipt to the final
 * SendInput completing, on the child's clock. `now` is injectable so the arithmetic is testable.
 */
export function inputAcknowledgement(receivedAt, now = () => performance.now()) {
  return { inputMs: now() - receivedAt };
}
