import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/contracts.ts';
import { advanceMode, INITIAL_MODE, MODE_EXIT_FRAMES, modeOf, type ModeMemory } from '../src/policy/mode.ts';

/** A frame with only the screen named: the mode machine reads nothing else. */
const at = (screen: Observation['screen'], confidence = 0.9): Observation => ({ screen, atMs: 0, confidence } as Observation);

describe('the mode a named screen belongs to', () => {
  it('reads the six modes out of the screens', () => {
    expect(modeOf(at('combat'))).toBe('battle');
    for (const screen of ['chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'loot'] as const) {
      expect(modeOf(at(screen))).toBe('chest');
    }
    expect(modeOf(at('dungeon'))).toBe('dungeon');
    expect(modeOf(at('dungeonmap'))).toBe('dungeon');
    expect(modeOf(at('worldmap'))).toBe('travel');
    expect(modeOf(at('dungeon-select'))).toBe('travel');
    expect(modeOf(at('town'))).toBe('town');
  });

  it('is no evidence on an unnamed or a loading frame', () => {
    // The revive QTE frame (2026-11-03) is exactly this: nothing named it, and the battle is still on.
    expect(modeOf(at('unknown', 0.8))).toBeNull();
    expect(modeOf(at('loading'))).toBeNull();
  });
});

describe('the mode memory', () => {
  it('enters a mode on its first named frame', () => {
    expect(advanceMode(INITIAL_MODE, at('combat'))).toEqual({ mode: 'battle', streak: 0 });
    expect(advanceMode(INITIAL_MODE, at('dungeon'))).toEqual({ mode: 'dungeon', streak: 0 });
  });

  it('holds a battle through the unnamed frames inside it', () => {
    const battle: ModeMemory = { mode: 'battle', streak: 0 };
    expect(advanceMode(battle, at('unknown', 0.8))).toBe(battle);
    expect(advanceMode(battle, at('loading'))).toBe(battle);
    // A chest owns its QTE bar's fades the same way.
    const chest: ModeMemory = { mode: 'chest', streak: 0 };
    expect(advanceMode(chest, at('unknown', 0.3))).toBe(chest);
  });

  it('needs two named frames to leave a modal mode', () => {
    let memory: ModeMemory = { mode: 'battle', streak: 0 };
    memory = advanceMode(memory, at('dungeon'));
    expect(memory).toEqual({ mode: 'battle', streak: 1 });
    // A fade in between neither leaves the mode nor resets the count.
    memory = advanceMode(memory, at('unknown', 0.5));
    expect(memory).toEqual({ mode: 'battle', streak: 1 });
    memory = advanceMode(memory, at('dungeon'));
    expect(memory).toEqual({ mode: 'dungeon', streak: 0 });
    expect(MODE_EXIT_FRAMES).toBe(2);
  });

  it('leaves a non-modal mode on its first named frame', () => {
    expect(advanceMode({ mode: 'dungeon', streak: 0 }, at('town'))).toEqual({ mode: 'town', streak: 0 });
    expect(advanceMode({ mode: 'travel', streak: 0 }, at('dungeonmap'))).toEqual({ mode: 'dungeon', streak: 0 });
  });

  it('resets the streak when the frame agrees with the mode again', () => {
    let memory: ModeMemory = { mode: 'battle', streak: 0 };
    memory = advanceMode(memory, at('dungeon'));
    memory = advanceMode(memory, at('combat'));
    expect(memory).toEqual({ mode: 'battle', streak: 0 });
  });
});
