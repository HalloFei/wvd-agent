/** Types of the `.mjs` gesture rules (gestures.mjs). */

export declare class Refused extends Error {
  readonly detail: string;
}

/** The shortest press the game sees; exported for tests. */
export declare const PRESS_MS: number;

/** The longest drag the World sends (contracts §4); the protocol codec validates against it. */
export declare const MAX_DRAG_MS: number;

export interface GestureDevice {
  isForeground(hwnd: number): boolean;
  moveToClient(hwnd: number, x: number, y: number): void;
  mouseDown(): void;
  mouseUp(): void;
  keyDown(scan: number): void;
  keyUp(scan: number): void;
  sleep(ms: number): Promise<void>;
}

export interface Gestures {
  tap(hwnd: number, x: number, y: number, count: number): Promise<void>;
  drag(hwnd: number, fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void>;
  holdKey(hwnd: number, scan: number, holdMs: number): Promise<void>;
  releaseHeld(): void;
  heldButtons(): { mouse: number; keys: number[] };
}

export declare function createGestures(device: GestureDevice): Gestures;

/** The `{ inputMs }` value of a successful tap/key reply; `now` is injectable for tests. */
export declare function inputAcknowledgement(receivedAt: number, now?: () => number): { inputMs: number };
