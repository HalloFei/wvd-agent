/**
 * The Dungeon Select screen: the unnamed stall between the world map and the dungeon.
 *
 * The pipeline can name it from the same legacy row art the `selectDungeon` action uses. Naming it
 * turns the stage into a normal screen: the task can `expect dungeon-select` instead of sleeping,
 * the world-map action can see the stage it is on, and a frame that is still the select is no longer
 * an `unknown` that the session has to escalate or the entry has to guess at.
 *
 * The evidence is the three FFXI zone rows in the list band: measured live (2026-10-24) at 0.781
 * (第三区 @0.70), 0.762 (第一区 @0.66) and similar; the list band is the same one `selectDungeon`
 * matches in. A frame without any row is not this screen. The recogniser runs last in the composite,
 * after the town and world map, so those screens never pay for it.
 */
import type { Frame, Observation, Perceiver, RgbaImage } from '../contracts.ts';
import { LOCATIONS } from './locations.ts';
import { findTemplate } from './match.ts';

const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

/** The Dungeon Select rows, the same band and scales the action's row match uses. */
export const DUNGEON_SELECT_AREA = { x: 850, y: 300, width: 500, height: 400 } as const;
export const DUNGEON_SELECT_SCALES = [0.64, 0.66, 0.68, 0.70] as const;
export const DUNGEON_SELECT_FLOOR = 0.72;

const ROW_IDS = ['ffxi-zone1', 'ffxi-zone2', 'ffxi-zone3'] as const;

export class DungeonSelectPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    if (frame.width !== REFERENCE_WIDTH || frame.height !== REFERENCE_HEIGHT) return unnamed(frame.atMs);
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unnamed(frame.atMs);
    }
    let best = 0;
    for (const id of ROW_IDS) {
      const match = findTemplate(image, DUNGEON_SELECT_AREA, LOCATIONS.get(id)!.template, {
        scales: DUNGEON_SELECT_SCALES,
        minScore: DUNGEON_SELECT_FLOOR,
      });
      if (match !== null && match.score > best) best = match.score;
    }
    if (best === 0) return unnamed(frame.atMs);
    const earned = (best - DUNGEON_SELECT_FLOOR) / (1 - DUNGEON_SELECT_FLOOR);
    return {
      screen: 'dungeon-select',
      atMs: frame.atMs,
      confidence: Math.min(1, 0.5 + 0.5 * earned),
    };
  }
}

/** A frame this perceiver refuses: confidence 0, so a flat frame can still stop a session. */
function unnamed(atMs: number): Observation {
  return { screen: 'unknown', atMs, confidence: 0 };
}
