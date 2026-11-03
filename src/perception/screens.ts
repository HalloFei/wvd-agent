/**
 * The evidence table: what one frame's cheap facts say about **every** screen.
 *
 * Every screen gets a standing on every frame — the evidence for it, and whether the frame proves it
 * impossible. A ruled-out screen can never be the answer, whatever a recogniser says about it; that
 * is what keeps a map from being fought on when its parser refuses the frame, instead of relying on
 * the order the recognisers happen to be tried in.
 *
 * Each row is a measurement, not a guess (2026-10-25, 1920×1080):
 *
 * | fact | battles | 3-D view | maps | town | Dungeon Select | opener | chest QTE |
 * | --- | --- | --- | --- | --- | --- | --- | --- |
 * | minimap arrow px | 0 | 35 | 0 | 0 | 0 | 1 537 | 0–455 |
 * | title-band **text** ink px | 0–1 | 0 | 1 159–1 854 | 0 | 1 854 | 47 | 31–56 |
 * | both button windows ≥ 0.004 | yes | no | no (speed 0.0008–0.0019) | no | no | no | no |
 *
 * Two consequences are encoded: **a battle draws no title bar and no minimap**, and **the 3-D view is
 * the screen with a minimap**. A title is characters — `map.ts` G4 measures a bright stroke carrying
 * its own dark gap (2026-11-03) — so the 3-D view with its menu legend open draws no title and the
 * arrow alone decides it: the operator's rule, *whenever a minimap, it is the dungeon*. The town's
 * name is white on a bright sky and counts as no title either; the town draws no minimap and has its
 * own recogniser, so no rule-out is needed for it. The support numbers are ordinal — the strongest
 * measured evidence clears 1, and they are not calibrated probabilities (the labelled corpus is ~20
 * screens).
 */
import type { ScreenId } from '../contracts.ts';
import {
  BUTTON_INK_MIN,
  BUTTON_INK_STRONG,
  MINIMAP_ARROW_MIN,
  TITLE_BAR_INK_MIN,
  type FrameFacts,
} from './facts.ts';

/**
 * One screen's standing on one frame (§3). `support` is the evidence for it, 0 (none) to 1 (the
 * strongest measured); `ruledOut` means the frame's own evidence makes the screen impossible.
 */
export interface ScreenStanding {
  readonly screen: ScreenId;
  readonly support: number;
  readonly ruledOut: boolean;
}

/** Every screen this table can speak about. `unknown` is not one: it is the answer when none wins. */
export const SCREENS: readonly ScreenId[] = [
  'combat',
  'dungeon',
  'dungeonmap',
  'town',
  'worldmap',
  'chest-open',
  'chest-prompt',
  'chest-qte',
  'chest-opening',
  'drop-item-claim',
  'loading',
  'dungeon-select',
  'character-page',
  'harken-menu',
];

export function screenStandings(facts: FrameFacts): readonly ScreenStanding[] {
  const arrow = facts.minimapArrowPx >= MINIMAP_ARROW_MIN;
  const title = facts.titleBarInkPx >= TITLE_BAR_INK_MIN;
  const buttons = facts.speedInk >= BUTTON_INK_MIN && facts.autoInk >= BUTTON_INK_MIN;
  const strong = facts.speedInk >= BUTTON_INK_STRONG && facts.autoInk >= BUTTON_INK_STRONG;
  return [
    // A battle draws both buttons and neither a title bar nor a minimap.
    { screen: 'combat', support: buttons ? (strong ? 1 : 0.8) : 0, ruledOut: arrow || title },
    // The 3-D view is the screen with the minimap; it has no title bar of its own.
    { screen: 'dungeon', support: arrow ? 0.8 : 0, ruledOut: title },
    // The map is the screen with a floor title; it draws no minimap.
    { screen: 'dungeonmap', support: title ? 0.5 : 0, ruledOut: arrow },
    { screen: 'town', support: 0, ruledOut: arrow },
    { screen: 'worldmap', support: 0, ruledOut: arrow },
    // The chest screens carry no unique corner ink and no title band; only their own recognisers
    // can speak about them.
    { screen: 'chest-open', support: 0, ruledOut: false },
    // The character page is a menu over the view: its own tile is the only evidence, and no cheap
    // fact rules it in or out (2026-11-03).
    { screen: 'character-page', support: 0, ruledOut: false },
    // The harken's floor menu: a centred list over the 3-D view; only its own reader can speak about it.
    { screen: 'harken-menu', support: 0, ruledOut: false },
    { screen: 'chest-prompt', support: 0, ruledOut: false },
    { screen: 'chest-qte', support: 0, ruledOut: false },
    // The opening (lid lifting, hands reaching, no bar, no HUD): only its own recogniser speaks.
    { screen: 'chest-opening', support: 0, ruledOut: false },
    { screen: 'drop-item-claim', support: 0, ruledOut: false },
    { screen: 'loading', support: 0, ruledOut: false },
    // The Dungeon Select rows are the only evidence; its own recogniser speaks.
    { screen: 'dungeon-select', support: 0, ruledOut: false },
  ];
}

/** Whether the frame's evidence forbids `screen`. Absent rows are possible. */
export function settlesAgainst(standings: readonly ScreenStanding[], screen: ScreenId): boolean {
  return standings.some((standing) => standing.screen === screen && standing.ruledOut);
}
