/**
 * The game's **mode**: which pipeline owns the screen (operator rule 2026-11-03).
 *
 * The loop's perception answers per screen (`ScreenId`), and some things the game does are not screens:
 * a battle is a command phase, a targeting panel, a skill resolution, fades — and, when a member dies,
 * a **revive QTE** (`testdata/battle-2026-11-02/revive-qte.jpg`, `unknown` 0.80). A chest is a prompt,
 * a card panel, a QTE bar, a lid animation and a loot banner. Naming every one of those frames as a
 * screen would be a recogniser per animation; the mode is the smaller fact: *the loop is in a battle*,
 * *the loop is in a chest* — and inside a mode an unnamed frame is that mode's business.
 *
 * `modeOf` reads the named screens (`ScreenId`) into modes; an unnamed or loading frame is no evidence
 * either way, so `advanceMode` **holds** the memory through it. Leaving a modal mode (battle, chest)
 * needs `MODE_EXIT_FRAMES` consecutive named frames of the next mode, so a battle's own fade cannot end
 * the battle; entering one is immediate, because a battle or a chest can start from anywhere.
 */
import type { GameMode, Observation } from '../contracts.ts';

/** Modes that own the screen until their named end: one frame of something else does not leave them. */
const MODAL: ReadonlySet<GameMode> = new Set<GameMode>(['battle', 'chest']);

/** How many consecutive named frames of another mode it takes to leave a modal mode. */
export const MODE_EXIT_FRAMES = 2;

/** The mode and how long something else has been on screen. */
export interface ModeMemory {
  readonly mode: GameMode;
  /** Consecutive named frames that pointed at a mode other than `mode`. */
  readonly streak: number;
}

/** Before any frame is named: no mode, nothing to hold. */
export const INITIAL_MODE: ModeMemory = { mode: 'unknown', streak: 0 };

/** The mode a named screen belongs to; null for a frame that is not evidence either way. */
export function modeOf(observation: Observation): GameMode | null {
  switch (observation.screen) {
    case 'combat':
      // A party member's revive QTE is a battle moment (2026-11-05): the battle keeps owning the
      // screen, so the loop neither leaves the mode nor re-arms the sequence through it.
    case 'revive-qte':
      return 'battle';
    case 'chest-prompt':
    case 'chest-open':
    case 'chest-qte':
    case 'chest-opening':
    case 'drop-item-claim':
      return 'chest';
    case 'dungeon':
    case 'dungeonmap':
      return 'dungeon';
    case 'worldmap':
    case 'dungeon-select':
      return 'travel';
    case 'town':
    // The inn is the rest town's dialog (operator, 2026-11-06): the town pipeline owns it, and the
    // World's inn branch presses its row before the route could treat it as a town to walk out of.
    case 'inn':
      return 'town';
    // The battle's skill detail panel (2026-11-08): a modal over the battle, and the battle is what
    // must act on it — its own 確定. The mode is the battle's, so the frame is never "unnamed".
    case 'skill-panel':
      return 'battle';
    // The main character's death is its own moment, not a frame that changes a pipeline's mode:
    // named so it stops being an unnamed frame inside whatever mode the party died in.
    // Nothing was named: the mode is not this frame's to change.
    case 'main-character-dead':
    case 'message':
    case 'unknown':
    case 'loading':
      return null;
    default:
      return null;
  }
}

/**
 * The mode after one frame. An unnamed frame holds the mode; leaving a modal mode needs
 * `MODE_EXIT_FRAMES` named frames of the next one.
 */
export function advanceMode(memory: ModeMemory, observation: Observation): ModeMemory {
  const candidate = modeOf(observation);
  if (candidate === null) return memory;
  if (candidate === memory.mode) return { mode: memory.mode, streak: 0 };
  const needed = MODAL.has(memory.mode) ? MODE_EXIT_FRAMES : 1;
  const streak = memory.streak + 1;
  return streak >= needed ? { mode: candidate, streak: 0 } : { mode: memory.mode, streak };
}
