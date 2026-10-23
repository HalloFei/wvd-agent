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

  return { tap, holdKey, releaseHeld, heldButtons };
}

/**
 * The `{ inputMs }` value of a successful tap/key reply (contracts §5): request receipt to the final
 * SendInput completing, on the child's clock. `now` is injectable so the arithmetic is testable.
 */
export function inputAcknowledgement(receivedAt, now = () => performance.now()) {
  return { inputMs: now() - receivedAt };
}
