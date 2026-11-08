/**
 * Travelling to one site on the world map.
 *
 * Four steps, one job each (operator, 2026-11-09):
 *
 *  1. **find** the site by its own icon and title (perception/site-finder.ts) at level 1, where every
 *     title is drawn and every site is clickable;
 *  2. **tap the matched point** — the click places the cursor, exactly as the legacy navigator's
 *     Press(matched point) does, so there is no hover step, no ring gate and **no cursor move**;
 *  3. on a miss, **swipe and look again** (legacy's mover): a fixed drag, then re-look, cycled through the
 *     four directions. The distance is never used for anything, which is why a non-reproducible drag
 *     (identical drags moved the map 144-264 px) cannot mislead it;
 *  4. **a 30 s budget**, so a travel that cannot find its site stops instead of swiping all night.
 *
 * What is deliberately absent: any dead reckoning of the map's offset, any rate learnt from a drag, any
 * cursor position read. Each was a source of failure and none is needed for these four steps — a swipe
 * parks the pointer where the drag ended, and an earlier version then tried to *move* the cursor from
 * that wall, could not, and called it "lost".
 *
 * Every dependency is injected, so the machine is testable without a game.
 */
import type { ActionResult, Point } from '../contracts.ts';

/** What the machine needs to see. The caller binds it to the site finder. */
export interface MapSenses {
  /** The target on this frame, if it is drawn, at the level the caller has put the map on. */
  site(): Promise<{ readonly at: Point; readonly confidence: number } | null>;
}

/** What the machine needs to do. */
export interface MapInput {
  /** One swipe in the direction the **view** should travel; then look again. */
  swipe(direction: 'w' | 'a' | 's' | 'd'): Promise<ActionResult>;
  /** A tap at a point of the frame: the click itself places the cursor there. */
  tap(at: Point): Promise<ActionResult>;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
}

export interface MapTravelOptions {
  /** The whole travel's bound, ms (operator: 30 s). */
  readonly budgetMs?: number;
  /**
   * Which way the next swipe should go. The atlas may **hint** it (other sites inform, never gate):
   * knowing which quadrant the target is in turns a blind cycle into one swipe in the right direction.
   */
  readonly nextDirection?: (swipe: number) => Promise<'w' | 'a' | 's' | 'd'>;
  readonly now?: () => number;
}

export type MapTravelResult =
  | { readonly ok: true; readonly at: Point; readonly swipes: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'budget' | 'refused'; readonly detail?: string };

const BUDGET_MS = 30_000;
const SWIPE_ORDER: ReadonlyArray<'w' | 'a' | 's' | 'd'> = ['d', 's', 'a', 'w'];
const SWIPE_SETTLE_MS = 600;

/**
 * The travel: look, tap; on a miss swipe and look again until the budget runs out.
 */
export async function travelToSite(
  senses: MapSenses,
  input: MapInput,
  options: MapTravelOptions = {},
): Promise<MapTravelResult> {
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + budgetMs;
  let swipes = 0;
  for (;;) {
    if (now() >= deadline) {
      return { ok: false, reason: 'budget', detail: 'no site found in ' + budgetMs + ' ms' };
    }
    const found = await senses.site();
    if (found !== null) {
      const tapped = await input.tap(found.at);
      if (!tapped.ok) return { ok: false, reason: 'refused', detail: tapped.reason };
      return { ok: true, at: found.at, swipes };
    }
    const direction = options.nextDirection === undefined
      ? SWIPE_ORDER[swipes % SWIPE_ORDER.length]!
      : await options.nextDirection(swipes);
    const swiped = await input.swipe(direction);
    if (!swiped.ok) return { ok: false, reason: 'refused', detail: swiped.reason };
    await input.sleep(SWIPE_SETTLE_MS);
    swipes += 1;
    input.log?.('wvd: swiped ' + direction + ' (no site yet, ' + swipes + ' swipes)');
  }
}

/**
 * A press the engine refused because the game was not the foreground is not a failed travel: it is a
 * window that lost focus. Retry it — **re-taking the foreground each time** — five times, three seconds
 * apart (operator, 2026-11-09), and only then let the refusal stand. The engine tries a focus per press;
 * on 2026-11-09 22:05 and again at 03:24 that attempt failed and a travel aborted on a transient loss.
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
      + Math.round(waitMs / 1_000) + ' s (attempt ' + (tried + 1) + ' of ' + attempts + ')');
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
