import { describe, expect, it } from 'vitest';
import { createSnapshotRequests, SnapshotFailed, SnapshotTimeout } from '../src/engine/snapshot.mjs';

/** A fake encoder port: it records the directives the child posts and can be scripted to answer. */
function fakeEncoder() {
  const sent: Array<Record<string, unknown>> = [];
  return { sent, send: (message: Record<string, unknown>) => sent.push(message) };
}

const FRAME = { jpeg: Uint8Array.of(1, 2, 3), width: 96, height: 54, capturedAt: 10, seq: 7 };

describe('child snapshot waiter queue', () => {
  it('sends a directive per request and settles the matching waiter with the encoded size', async () => {
    const encoder = fakeEncoder();
    const snapshots = createSnapshotRequests({ send: encoder.send, timeoutMs: 1000 });

    const first = snapshots.request(1280);
    const second = snapshots.request(640);
    expect(encoder.sent).toEqual([
      { op: 'snapshot', snapshotId: 1, maxWidth: 1280 },
      { op: 'snapshot', snapshotId: 2, maxWidth: 640 },
    ]);
    expect(snapshots.size).toBe(2);

    // out of order on purpose: the id, not the arrival order, is the correlation
    snapshots.settle({ ...FRAME, snapshotId: 2 });
    expect(await second).toEqual(FRAME);
    snapshots.settle({ ...FRAME, snapshotId: 1, width: 192, height: 108 });
    expect(await first).toMatchObject({ width: 192, height: 108 });
    expect(snapshots.size).toBe(0);
  });

  it('drops a reply for a waiter that is not there, instead of settling a later one', async () => {
    const encoder = fakeEncoder();
    const snapshots = createSnapshotRequests({ send: encoder.send, timeoutMs: 1000 });

    const waiter = snapshots.request(640);
    snapshots.settle({ ...FRAME, snapshotId: 99 });
    expect(snapshots.size).toBe(1);
    snapshots.settle({ ...FRAME, snapshotId: 1 });
    expect(await waiter).toMatchObject({ width: 96 });
  });

  it('rejects a waiter with SnapshotFailed when the encoder cannot scale it', async () => {
    const encoder = fakeEncoder();
    const snapshots = createSnapshotRequests({ send: encoder.send, timeoutMs: 1000 });

    const waiter = snapshots.request(640);
    snapshots.fail({ snapshotId: 1, detail: 'snapshot-failed: boom' });
    await expect(waiter).rejects.toBeInstanceOf(SnapshotFailed);
  });

  it('cancels the encoder directive and rejects when the wait expires', async () => {
    const encoder = fakeEncoder();
    const timers: Array<() => void> = [];
    const snapshots = createSnapshotRequests({
      send: encoder.send,
      timeoutMs: 1000,
      setTimer: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimer: () => {},
    });

    const waiter = snapshots.request(640);
    timers[0]!();
    await expect(waiter).rejects.toBeInstanceOf(SnapshotTimeout);
    // the directive is cancelled so no frame is scaled for nobody, and a late reply is ignored
    expect(encoder.sent).toContainEqual({ op: 'snapshot', snapshotId: null });
    snapshots.settle({ ...FRAME, snapshotId: 1 });
    expect(snapshots.size).toBe(0);
  });

  it('rejects every outstanding waiter on cancelAll, and clears them', async () => {
    const encoder = fakeEncoder();
    const snapshots = createSnapshotRequests({ send: encoder.send, timeoutMs: 1000 });

    const first = snapshots.request(1280);
    const second = snapshots.request(640);
    snapshots.cancelAll('engine-stopped');
    await expect(first).rejects.toMatchObject({ name: 'SnapshotTimeout', detail: 'engine-stopped' });
    await expect(second).rejects.toMatchObject({ name: 'SnapshotTimeout', detail: 'engine-stopped' });
    expect(snapshots.size).toBe(0);
  });
});
