/**
 * The child's snapshot correlation (contracts §5 `capture { maxWidth }`), plain ESM like the child.
 *
 * One waiter per outstanding downscaled capture. The encoder's reply settles the waiter with the same
 * id; a reply for a timed-out request is dropped; a timeout rejects the waiter *and* tells the encoder
 * to cancel the directive, so a frame nobody is waiting for is not scaled. The queue is FIFO and
 * keyed by id rather than a single slot: the protocol queue serializes capture requests today, but a
 * future parallel queue must not let one waiter overwrite another into a silent hang.
 */

/** A downscaled snapshot that did not arrive; the caller turns it into `timeout`. */
export class SnapshotTimeout extends Error {
  constructor(detail = 'snapshot-timeout') {
    super(detail);
    this.name = 'SnapshotTimeout';
    this.detail = detail;
  }
}

/** The encoder could not produce the scaled JPEG; the caller may fall back to the native frame. */
export class SnapshotFailed extends Error {
  constructor(detail = 'snapshot-failed') {
    super(detail);
    this.name = 'SnapshotFailed';
    this.detail = detail;
  }
}

/**
 * @param {object} options
 * @param {(message: object) => void} options.send posts a directive to the encoder thread
 * @param {number} options.timeoutMs how long one snapshot may wait
 * @param {(callback: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createSnapshotRequests({ send, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {Array<{ snapshotId: number, resolve: (value: object) => void, reject: (error: Error) => void, timer: unknown }>} */
  const waiters = [];
  let nextId = 0;

  const take = (snapshotId) => {
    const index = waiters.findIndex((entry) => entry.snapshotId === snapshotId);
    return index < 0 ? null : waiters.splice(index, 1)[0];
  };

  return {
    /** Ask the encoder for one downscaled frame; resolves with the size it actually encoded. */
    request(maxWidth) {
      return new Promise((resolve, reject) => {
        const snapshotId = ++nextId;
        const timer = setTimer(() => {
          if (!take(snapshotId)) return;
          send({ op: 'snapshot', snapshotId: null }); // do not burn a scale nobody will read
          reject(new SnapshotTimeout());
        }, timeoutMs);
        waiters.push({ snapshotId, resolve, reject, timer });
        send({ op: 'snapshot', snapshotId, maxWidth });
      });
    },

    /** The encoder's `{ kind: 'snapshot' }` reply; an unknown id is a reply for a timed-out request. */
    settle(message) {
      const entry = take(message.snapshotId);
      if (!entry) return;
      clearTimer(entry.timer);
      entry.resolve({
        jpeg: message.jpeg,
        width: message.width,
        height: message.height,
        capturedAt: message.capturedAt,
        seq: message.seq,
      });
    },

    /** The encoder's `{ kind: 'snapshot-problem' }` reply. */
    fail(message) {
      const entry = take(message.snapshotId);
      if (!entry) return;
      clearTimer(entry.timer);
      entry.reject(new SnapshotFailed(message.detail ?? 'snapshot-failed'));
    },

    /** Reject every waiter still pending; teardown uses this instead of waiting out a timer. */
    cancelAll(detail = 'engine-stopped') {
      for (const entry of waiters.splice(0)) {
        clearTimer(entry.timer);
        entry.reject(new SnapshotTimeout(detail));
      }
    },

    /** How many waiters are outstanding. */
    get size() {
      return waiters.length;
    },
  };
}
