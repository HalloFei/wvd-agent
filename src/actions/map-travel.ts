/**
 * Travelling to one site on the world map, with the four senses the module now has.
 *
 * The rule (operator, 2026-11-09): a site is found by **its own icon and title**, at any position and
 * any size; the atlas may hint which quadrant we are looking at and must never gate; the map is
 * **coarse at level 0 and fine at level 1**, a site is clickable at levels 1 and 2, and a tap is sent
 * only when the game draws **its white ring** around the icon. The pointer is moved by key holds, and a
 * pointer held at the map's edge pushes the perspective at a rate.
 *
 * That rate is **not** a constant, and it is not fixed per level here either: the same push covers a
 * different amount of map at each zoom, so the loop **measures** it — the displacement of a landmark the
 * finder can see, before and after each push — and plans the next push from what it measured. A learned
 * rate that is wrong for a frame is corrected by the following frame; a constant that is wrong is wrong
 * all night (that is what the 0.49-1.87 gains of the old pan loop were).
 *
 * Every dependency is injected, so the machine is testable without a game: the senses (site, ring,
 * pointer, landmark), the input (hold, tap, zoom) and the clock.
 */
import type { ActionResult, Frame, Point } from '../contracts.ts';

/** What the machine needs to see. The caller binds these to the perception modules. */
export interface MapSenses {
  /** The target on this frame, if it is drawn: `wantTitle` false at the coarse level. */
  site(level: 0 | 1 | 2, wantTitle: boolean): Promise<{ readonly at: Point; readonly confidence: number } | null>;
  /** Whether the game draws its clickable ring around a point. */
  ring(at: Point): Promise<boolean>;
  /** Where the pointer is, or null when the frame does not draw it. */
  pointer(): Promise<Point | null>;
  /** A site the finder can see, to measure how far a push moved the map. */
  landmark(): Promise<{ readonly id: string; readonly at: Point } | null>;
}

/** What the machine needs to do. */
export interface MapInput {
  hold(direction: 'w' | 'a' | 's' | 'd', holdMs: number): Promise<ActionResult>;
  tap(at: Point): Promise<ActionResult>;
  /** One zoom step. Returns false when the press was refused. */
  zoom(direction: 'in' | 'out'): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
}

export interface MapTravelOptions {
  /** The whole travel's bound, ms (operator: 30 s). */
  readonly budgetMs?: number;
  /** The map's measured pan rail: the coarse views are enumerated inside it. */
  readonly railX?: number;
  readonly railY?: number;
  /** The strip the map is drawn in, in client pixels. */
  readonly strip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** How far a coarse view may be from the target's own point and still count. */
  readonly findTolerancePx?: number;
  /** The pointer's travel per hold, measured: 1 px/ms at every level (2026-11-09). */
  readonly pointerPxPerMs?: number;
  /** The longest one push or pointer hold may be, ms. */
  readonly maxHoldMs?: number;
  readonly now?: () => number;
}

export type MapTravelResult =
  | { readonly ok: true; readonly at: Point; readonly pushes: number; readonly level: 1 | 2 }
  | {
    readonly ok: false;
    readonly reason: 'not-found' | 'budget' | 'lost' | 'refused' | 'not-clickable' | 'no-ring';
    readonly detail?: string;
  };

/**
 * A press the engine refused because the game was not the foreground is not a failed travel: it is a
 * window that lost focus. Retry it — **re-taking the foreground** each time — five times, three seconds
 * apart (operator, 2026-11-09), and only then let the refusal stand. The engine itself tries to focus
 * once per press (`sendInput`), and on 2026-11-09 22:05 that attempt failed twice and the travel aborted
 * on a transient focus loss.
 */
export async function withForegroundRetry<T extends ActionResult>(
  send: () => Promise<T>,
  options: {
    readonly sleep: (ms: number) => Promise<void>;
    readonly focus?: () => Promise<boolean>;
    readonly log?: (line: string) => void;
    readonly attempts?: number;
    readonly waitMs?: number;
  },
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const waitMs = options.waitMs ?? 3_000;
  let result = await send();
  for (let tried = 0; !result.ok && lostForeground(result) && tried < attempts; tried += 1) {
    options.log?.('wvd: the press was refused (not-foreground); re-taking the foreground in '
      + Math.round(waitMs / 1000) + ' s (attempt ' + (tried + 1) + ' of ' + attempts + ')');
    await options.sleep(waitMs);
    await options.focus?.();
    result = await send();
  }
  return result;
}

/** Whether a refusal was the window's focus rather than the game's answer. */
export function lostForeground(result: ActionResult): boolean {
  if (result.ok) return false;
  const detail = (result as { detail?: string }).detail ?? '';
  return detail.includes('not-foreground');
}

const DEFAULTS = {
  budgetMs: 30_000,
  railX: 400,
  railY: 416,
  strip: { x: 480, y: 0, width: 960, height: 1_080 },
  findTolerancePx: 40,
  pointerPxPerMs: 1,
  maxHoldMs: 900,
} as const;

/** The coarse views: the pan rail is only 400 × 416 px, so four corners are the whole map. */
const VIEWS: ReadonlyArray<{ readonly x: number; readonly y: number }> = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

/**
 * The travel. Order: reset to level 0, look; on a hit, level 1 and the ring; on a miss, one push and
 * look again. A push is sent **only** with the pointer at the map's edge, and its distance is planned
 * from the rate the previous push measured.
 */
export async function travelToSite(
  senses: MapSenses,
  input: MapInput,
  options: MapTravelOptions = {},
): Promise<MapTravelResult> {
  const budgetMs = options.budgetMs ?? DEFAULTS.budgetMs;
  const railX = options.railX ?? DEFAULTS.railX;
  const railY = options.railY ?? DEFAULTS.railY;
  const strip = options.strip ?? DEFAULTS.strip;
  const pointerRate = options.pointerPxPerMs ?? DEFAULTS.pointerPxPerMs;
  const maxHold = options.maxHoldMs ?? DEFAULTS.maxHoldMs;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + budgetMs;
  const overBudget = (): boolean => now() >= deadline;

  // The push rate this travel has measured, px of map per ms. Null until the first push is measured:
  // a constant would be a guess, and the old loop's gains (0.49-1.87) are what a guess costs.
  let pushPxPerMs: number | null = null;
  let view = 0;
  let pushes = 0;

  // **Everything happens at level 1** (operator, 2026-11-09): at level 1 every title is drawn and every
  // site is clickable, so the pair is the identification and the ring is the confirmation — no level-0
  // icons-only stage, which is where the first two live runs found nothing. The caller puts the map at
  // level 1 before calling.
  for (;;) {
    if (overBudget()) return { ok: false, reason: 'budget', detail: 'the travel exceeded its ' + budgetMs + ' ms' };

    const found = await senses.site(1, true);
    if (found !== null) {
      // The pointer to the icon, then the game's own ring — the only evidence a tap may rest on.
      const moved = await moveCursorTo(senses, input, found.at, pointerRate, maxHold);
      if (!moved.ok) return { ok: false, reason: 'lost', detail: moved.detail };
      if (!(await senses.ring(found.at))) {
        return { ok: false, reason: 'no-ring', detail: 'the icon is not clickable on this frame' };
      }
      const tapped = await input.tap(found.at);
      if (!tapped.ok) return { ok: false, reason: 'refused', detail: tapped.reason };
      return { ok: true, at: found.at, pushes, level: 1 };
    }

    // 4. Not on this view: push one view along, and measure what that push actually did.
    const target = VIEWS[(view + 1) % VIEWS.length]!;
    const distance = view === 0 || view === 3 ? railX : railY;
    void target;
    const holdMs = Math.min(
      maxHold,
      Math.max(80, Math.round(distance / Math.max(0.05, pushPxPerMs ?? 1))),
    );
    // The push needs the cursor **at the wall**, but failing to get it there is not fatal: the hold below
    // still moves the cursor toward the wall, and the next look decides. (Making this fatal aborted every
    // travel whose cursor was already at the wall — 2026-11-09 02:10.)
    await moveCursorTo(senses, input, { x: strip.x + strip.width - 40, y: Math.round(strip.height / 2) }, pointerRate, maxHold);
    const before = await senses.landmark();
    const held = await input.hold(pushes % 2 === 0 ? 'd' : 's', holdMs);
    if (!held.ok) return { ok: false, reason: 'refused', detail: held.reason };
    await input.sleep(420);
    const after = await senses.landmark();
    pushes += 1;
    if (before !== null && after !== null && before.id === after.id) {
      const movedBy = Math.abs(after.at.x - before.at.x) + Math.abs(after.at.y - before.at.y);
      // The landmark's own movement is the map's, and it is measured on the frame the push produced.
      if (movedBy >= 4) pushPxPerMs = clampRate(movedBy / Math.max(1, holdMs));
    }
    view = (view + 1) % VIEWS.length;
    input.log?.('wvd: map view ' + view + ' (pushed ' + pushes + ' times, rate '
      + (pushPxPerMs === null ? 'not measured' : pushPxPerMs.toFixed(2)) + ' px/ms)');
  }
}

/** The rate the next push is planned from: a real measurement, bounded to what a pointer can do. */
function clampRate(value: number): number {
  return Math.min(4, Math.max(0.05, value));
}

/**
 * Put the cursor **on** a point of the frame, then stop. That is the whole job: the target is a place,
 * never a distance, and the answer is "done" or "the cursor cannot be read".
 *
 * The loop exists for one reason only: one blind hold cannot be sized exactly (1 px/ms measured, but the
 * game's own frame pacing makes a millisecond of error a pixel of error, and a 900 ms hold crosses most
 * of the strip), so the move is re-read and corrected rather than trusted.
 *
 * It is **not** a navigator: it does not know about the map's edge, the push, or the zoom. A cursor
 * pinned at the strip's wall is a *different job's* business (an edge push), and treating it as a
 * failure here was a bug: the travel aborted with 'lost' whenever the cursor sat at the wall — the very
 * place the push needs it (2026-11-09 02:10).
 */
async function moveCursorTo(
  senses: MapSenses,
  input: MapInput,
  at: Point,
  pxPerMs: number,
  maxHold: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  let pointer = await senses.pointer();
  if (pointer === null) return { ok: false, detail: 'the frame does not draw the pointer' };
  for (let step = 0; step < 16; step += 1) {
    const dx = at.x - pointer.x;
    const dy = at.y - pointer.y;
    if (Math.abs(dx) <= 12 && Math.abs(dy) <= 12) return { ok: true };
    // The longer axis first; one hold per step, then look again.
    const axis: 'w' | 'a' | 's' | 'd' = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w');
    const distance = axis === 'd' || axis === 'a' ? Math.abs(dx) : Math.abs(dy);
    const holdMs = Math.min(maxHold, Math.max(40, Math.round(distance / Math.max(0.1, pxPerMs))));
    const held = await input.hold(axis, holdMs);
    if (!held.ok) return { ok: false, detail: held.reason };
    await input.sleep(80);
    const next = await senses.pointer();
    if (next === null) return { ok: false, detail: 'the pointer left the frame' };
    if (Math.abs(next.x - pointer.x) + Math.abs(next.y - pointer.y) < 2) {
      // A hold that moves nothing is a wall or a swallowed key. Try the other axis once (a cursor on the
      // right wall still needs to go up or down); if that moves nothing either, the cursor is stuck.
      const other: 'w' | 'a' | 's' | 'd' = axis === 'd' || axis === 'a'
        ? (dy > 0 ? 's' : 'w') : (dx > 0 ? 'd' : 'a');
      const second = await input.hold(other, Math.min(maxHold, 200));
      if (!second.ok) return { ok: false, detail: second.reason };
      await input.sleep(80);
      const again = await senses.pointer();
      if (again === null) return { ok: false, detail: 'the pointer left the frame' };
      if (Math.abs(again.x - pointer.x) + Math.abs(again.y - pointer.y) < 2) {
        return { ok: false, detail: 'the pointer is stuck at ' + again.x + ',' + again.y };
      }
      pointer = again;
      continue;
    }
    pointer = next;
  }
  return { ok: false, detail: 'the pointer did not settle' };
}
