/**
 * The character page's close **episode**: which frames keep it alive, and which end it.
 *
 * The page is a screen the loop finishes (operator rule 2026-11-03: *after open and heal there shall be a
 * close of the character panel*). Its close budget is per **episode**: the loop presses the close tile, and
 * a page that takes no close is owed one `Esc` at the cap instead of the stall clock.
 *
 * An episode is ended by another **named** screen, not by the recogniser dropping the page for a frame:
 * the game animates the page in, and while it does the frame reads `unknown` (or `loading`) between page
 * frames. Counting those as "the page left" reset the budget on every flicker, so the cap never reached
 * three and the `Esc` never went out — live 2026-11-07 22:42 (four presses) and again 22:54 (four more).
 *
 * Pure, so the rule is testable without the tick's pacer, its in-flight gate or its escalation path.
 */
import type { ScreenId } from '../contracts.ts';

/** Screens that are the same page episode as the page itself: the page, and a frame it was not named on. */
const SAME_EPISODE: ReadonlySet<ScreenId> = new Set<ScreenId>(['character-page', 'unknown', 'loading']);

/**
 * The close budget after this frame: unchanged while the frame is the page (or a frame the page was not
 * named on), zero once another screen is named.
 */
export function nextPageCloseTries(screen: ScreenId, tries: number): number {
  return SAME_EPISODE.has(screen) ? tries : 0;
}
