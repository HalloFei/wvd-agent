/**
 * Moving the cursor: WASD holds, each one measured, to a target or to the map's edge.
 *
 * Operator, 2026-11-09: *WASD controls the pointer, and thus controls the perspective* — so the map has
 * three inputs, and this module owns the two that need the cursor:
 *
 * - **steer**: hold a direction until the pointer is where the caller wants it (re-read every step: the
 *   frame is the only truth about where the arrow is);
 * - **push**: hold a direction with the pointer already at the edge, which scrolls the map at a
 *   constant speed — a *rate*, measured, not the drag's smoothed path.
 *
 * The speed is not assumed: \`pxPerMs\` per direction is handed in, measured by the probe
 * (\`scripts/worldmap-pointer-probe.ts\`). A hold that moves the pointer less than \`stallPx\` is a
 * **stall** (the key was swallowed, or the window lost the foreground), and it is reported as one.
 */
import type { ActionResult, Frame, Point, RgbaImage } from '../contracts.ts';
import { readPointer } from '../perception/pointer.ts';

export type PointerDirection = 'w' | 'a' | 's' | 'd';

export interface PointerEnv {
  readonly capture: () => Promise<Frame>;
  readonly holdKey: (direction: PointerDirection, holdMs: number) => Promise<ActionResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface PointerOptions {
  /** Measured pointer travel per millisecond of hold, per direction. */
  readonly pxPerMs?: Partial<Record<PointerDirection, number>>;
  /** How close to the target counts as there (client pixels). */
  readonly tolerancePx?: number;
  /** The shortest hold that is worth sending. */
  readonly minHoldMs?: number;
  /** The longest hold one step may use. */
  readonly maxHoldMs?: number;
  /** A hold that moves less than this was swallowed. */
  readonly stallPx?: number;
  /** How many holds one steer may spend. */
  readonly maxSteps?: number;
}

export type PointerOutcome =
  | { readonly ok: true; readonly at: Point; readonly steps: number }
  | { readonly ok: false; readonly reason: 'lost' | 'refused' | 'stalled' | 'overshot'; readonly detail?: string };

const DEFAULT_PX_PER_MS = 1;
const DEFAULTS = { tolerancePx: 12, minHoldMs: 40, maxHoldMs: 900, stallPx: 3, maxSteps: 12 } as const;

/** The axes this direction moves, and the sign it moves them by. */
const AXES: Readonly<Record<PointerDirection, Point>> = {
  w: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: 1 },
  d: { x: 1, y: 0 },
};

async function look(env: PointerEnv): Promise<Point | null> {
  const frame = await env.capture();
  const image: RgbaImage = await frame.toRgba();
  return readPointer(image)?.at ?? null;
}

/**
 * Hold whichever axis is further from the target, for as long as the measured speed says, then look
 * again. The caller's target is a **place**, never a distance: every step re-reads the frame.
 */
export async function steerPointer(env: PointerEnv, target: Point, options: PointerOptions = {}): Promise<PointerOutcome> {
  const tolerance = options.tolerancePx ?? DEFAULTS.tolerancePx;
  const minHold = options.minHoldMs ?? DEFAULTS.minHoldMs;
  const maxHold = options.maxHoldMs ?? DEFAULTS.maxHoldMs;
  const stall = options.stallPx ?? DEFAULTS.stallPx;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const speed = (direction: PointerDirection): number => options.pxPerMs?.[direction] ?? DEFAULT_PX_PER_MS;

  let at = await look(env);
  if (at === null) return { ok: false, reason: 'lost', detail: 'the frame does not draw the pointer' };
  for (let step = 0; step < maxSteps; step += 1) {
    const dx = target.x - at.x;
    const dy = target.y - at.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) return { ok: true, at, steps: step };
    // One axis at a time, the longer one first: a diagonal hold is two axes the game may scale.
    const direction: PointerDirection = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
    const distance = direction === 'd' || direction === 'a' ? Math.abs(dx) : Math.abs(dy);
    const holdMs = Math.min(maxHold, Math.max(minHold, Math.round(distance / Math.max(0.05, speed(direction)))));
    env.log?.('wvd: pointer ' + direction + ' ' + holdMs + ' ms for ' + distance + ' px');
    const held = await env.holdKey(direction, holdMs);
    if (!held.ok) return { ok: false, reason: 'refused', detail: held.reason };
    await env.sleep(120);
    const next = await look(env);
    if (next === null) return { ok: false, reason: 'lost', detail: 'the pointer left the frame' };
    const moved = Math.abs(next.x - at.x) + Math.abs(next.y - at.y);
    if (moved < stall) return { ok: false, reason: 'stalled', detail: 'the ' + direction + ' hold moved ' + moved + ' px' };
    at = next;
  }
  return { ok: false, reason: 'overshot', detail: 'the pointer did not settle within ' + maxSteps + ' holds' };
}

/**
 * Push the map by holding one direction with the pointer at the edge. The distance is the caller's own
 * measurement of the map, not this function's: it holds for \`holdMs\` and returns, and the caller
 * reads the map to see how far it went.
 */
export async function pushMap(env: PointerEnv, direction: PointerDirection, holdMs: number): Promise<ActionResult> {
  return env.holdKey(direction, holdMs);
}
