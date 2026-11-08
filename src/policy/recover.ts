/**
 * The recovery policy: from wherever the loop is, take the next step towards a screen the route
 * can act on — a page exits by its own control, an unnamed screen takes one `Esc`, and the town page
 * first reveals its world map (the party panel covers it; its collapse control unhides it).
 *
 * Operator, 2026-11-07: "when at unknown page or somewhere, try to go with exit path to main town
 * page, with party panel hide". This is that policy, pure: the caller owns the clock, the press and
 * the stopping; this owns which control is the next one and why. It never presses blindly: a screen it
 * does not know is one `Esc` (a transition may clear on its own), and a screen it cannot leave is
 * `done` — the caller's route decides from there.
 */
import type { Observation, Point, RecoveryStep } from '../contracts.ts';
import { UI_CATALOG } from '../ui/pages.ts';

/** The step union is contracts §6's, because §6's `recover` intent carries it. */
export type { RecoveryStep };

/**
 * The town page's party-panel collapse control: pressing it reveals the world map the panel covers
 * (operator, 2026-11-07: "in town page the worldmap can be hide from party panel, press here to
 * unhide").
 *
 * Measured 2026-11-07 on the live camera: the chevron is the 34x26 sample in
 * `src/perception/town-template.ts` at (679, 789) of
 * `testdata/screens/2026-11-07-town-live/town-1920.jpg` (the client redrew the tile; the legacy
 * mobile art scores 0.600 there). Its centre is the press: (696, 802). The sample scores 1.000 on
 * that frame and 0.943-0.956 on the six town frames recorded 2026-10-25, where the legacy template
 * and this point agree within 3 px. The operator screenshot's (1577, 669) is a different control:
 * it does not hit the chevron.
 */
export const PARTY_PANEL_COLLAPSE: Point = { x: 696, y: 802 };

/** The screens the route can act from: a walk, a map, a travel, a fight. */
const NAVIGABLE: ReadonlySet<Observation['screen']> = new Set<Observation['screen']>([
  'dungeon', 'dungeonmap', 'worldmap', 'dungeon-select', 'combat', 'chest-prompt', 'chest-open',
  'chest-qte', 'chest-opening', 'drop-item-claim', 'harken-menu', 'inn', 'inn-rest', 'loading',
  'skill-panel',
]);

/** The next control towards a screen the route can act on. */
export function recoverStep(observation: Observation): RecoveryStep {
  if (observation.screen === 'ui-menu') {
    return { kind: 'exit-page', at: observation.exit, page: observation.page, label: 'its exit' };
  }
  if (observation.screen === 'town') {
    return { kind: 'collapse-party-panel', at: PARTY_PANEL_COLLAPSE };
  }
  if (observation.screen === 'unknown') {
    return { kind: 'back' };
  }
  if (NAVIGABLE.has(observation.screen)) {
    return { kind: 'done', why: `the ${observation.screen} screen is one the route can act on` };
  }
  // A page that has its own screen id (character page, item detail, records, missions, ...): its
  // catalogue exit is the control that leaves it.
  const page = UI_CATALOG.pages.find((candidate) => candidate.id === observation.screen);
  const exit = page?.rows.find((row) => row.kind === 'exit');
  if (page !== undefined && exit !== undefined) {
    return { kind: 'exit-page', at: exit.at, page: page.id, label: exit.label };
  }
  return { kind: 'done', why: `no exit is recorded for the ${observation.screen} screen` };
}
