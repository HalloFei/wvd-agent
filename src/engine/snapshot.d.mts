/**
 * Types of the `.mjs` snapshot correlation queue (snapshot.mjs), so the World's TypeScript tests see
 * the same module the child runs. Kept beside the implementation; the two change together.
 */

/** A downscaled snapshot that did not arrive; the caller turns it into `timeout`. */
export declare class SnapshotTimeout extends Error {
  readonly detail: string;
  constructor(detail?: string);
}

/** The encoder could not produce the scaled JPEG; the caller may fall back to the native frame. */
export declare class SnapshotFailed extends Error {
  readonly detail: string;
  constructor(detail?: string);
}

/** The value one snapshot request settles with: what the encoder actually encoded. */
export interface SnapshotFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
  readonly seq: number;
}

export interface SnapshotRequests {
  request(maxWidth: number): Promise<SnapshotFrame>;
  /** The encoder's `{ kind: 'snapshot' }` reply. */
  settle(message: { readonly snapshotId: number } & SnapshotFrame): void;
  /** The encoder's `{ kind: 'snapshot-problem' }` reply. */
  fail(message: { readonly snapshotId: number; readonly detail?: string }): void;
  /** Reject every waiter still pending. */
  cancelAll(detail?: string): void;
  readonly size: number;
}

/** The child's waiter queue; `send` posts a directive to the encoder thread. */
export declare function createSnapshotRequests(options: {
  send(message: { readonly op: 'snapshot'; readonly snapshotId: number | null; readonly maxWidth?: number }): void;
  timeoutMs: number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}): SnapshotRequests;
