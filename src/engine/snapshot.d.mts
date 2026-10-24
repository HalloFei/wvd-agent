/**
 * Types of the `.mjs` snapshot correlation queue (snapshot.mjs), so the World's TypeScript tests see
 * the same module the child runs. Kept beside the implementation; the two change together.
 */

import type { PixelRect } from '../contracts.ts';

/** A frame variant that did not arrive; the caller turns it into `timeout`. */
export declare class SnapshotTimeout extends Error {
  readonly detail: string;
  constructor(detail?: string);
}

/** The encoder could not produce the variant; only the `maxWidth` path may fall back to the frame. */
export declare class SnapshotFailed extends Error {
  readonly detail: string;
  constructor(detail?: string);
}

/** The value one variant request settles with: what the encoder actually encoded. */
export interface SnapshotFrame {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
  readonly seq: number;
  /** The rectangle the encoder actually copied, present only when it produced a crop. */
  readonly crop?: PixelRect;
}

/** What one variant asks the encoder to do with the next frame: one of the two, never both. */
export interface SnapshotVariant {
  /** Downscale the frame to at most this width (the escalation snapshot). */
  readonly maxWidth?: number;
  /** Copy this rectangle before encoding (a QTE sample). */
  readonly crop?: PixelRect;
}

export interface SnapshotRequests {
  /** Ask for one downscaled frame; resolves with the size the encoder actually encoded. */
  request(maxWidth: number): Promise<SnapshotFrame>;
  /** Ask for one frame variant; the same queue, timeout and cancel semantics as `request`. */
  requestVariant(variant: SnapshotVariant): Promise<SnapshotFrame>;
  /** The encoder's `{ kind: 'snapshot' }` reply. */
  settle(message: { readonly kind?: 'snapshot'; readonly snapshotId: number } & SnapshotFrame): void;
  /** The encoder's `{ kind: 'snapshot-problem' }` reply. */
  fail(message: { readonly snapshotId: number; readonly detail?: string }): void;
  /** Reject every waiter still pending. */
  cancelAll(detail?: string): void;
  readonly size: number;
}

/** The child's waiter queue; `send` posts a directive to the encoder thread. */
export declare function createSnapshotRequests(options: {
  send(message: {
    readonly op: 'snapshot';
    readonly snapshotId: number | null;
    readonly maxWidth?: number;
    readonly crop?: PixelRect;
  }): void;
  timeoutMs: number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}): SnapshotRequests;
