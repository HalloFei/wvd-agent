import { describe, expect, it } from 'vitest';
import type { MapState, Observation, ScreenId, TaskOrient } from '../src/contracts.ts';
import { nextOrientStep } from '../src/policy/orient.ts';

/**
 * The orientation's decision table (contracts §10, the goal form).
 *
 * The party may start on any screen — that is the whole point of the feature: the World used to
 * require a town and stopped when the party was inside the dungeon. Each case here is one row of
 * the table the World drives one command at a time.
 */

const FARM = '000000007f3ffe007ffeff00220bb600';
const CLIMB = '0c0280000d6ff0000d7ffc0008c37000';

const orient: TaskOrient = {
  goal: { site: 'ffxi-gcn', zone: 'ffxi-zone3', climb: { from: CLIMB, script: { timeoutMs: 60_000, steps: [{ op: 'wait', ms: 1 }] } } },
  floor: FARM,
};

const screen = (id: ScreenId, confidence = 0.9): Observation => ({ screen: id, atMs: 0, confidence } as Observation);

const mapOf = (titleKey: string): Observation => ({
  screen: 'dungeonmap',
  atMs: 0,
  confidence: 0.9,
  map: {
    floorTitle: 'B1F',
    titleKey,
    player: { x: 10, y: 10 },
    origin: { x: 960, y: 540 },
    icons: [],
  } as MapState,
});

describe('nextOrientStep', () => {
  it('is arrived on the farm floor, within the floor keys\' tolerance', () => {
    // The live key against the fixture key: three bits apart, the same floor (R27b).
    expect(nextOrientStep(mapOf(FARM), orient)).toEqual({ kind: 'arrived' });
    expect(nextOrientStep(mapOf('000000007f3ffe007f7efe00220ba600'), orient)).toEqual({ kind: 'arrived' });
    // The live 2026-11-02 reading of the same floor, 9 bits from the task's key (R27b).
    expect(nextOrientStep(mapOf('600004007f3ffe007ffefe0002032200'), orient)).toEqual({ kind: 'arrived' });
  });

  it('climbs from the floor that carries the measured stair-up', () => {
    expect(nextOrientStep(mapOf(CLIMB), orient)).toEqual({ kind: 'command', command: { kind: 'climb' } });
  });

  it('stops on a floor it has no measured way off, rather than pressing a blind tile', () => {
    const other = 'ffffffffffffffffffffffffffffffff';
    const decision = nextOrientStep(mapOf(other), orient);
    expect(decision).toMatchObject({ kind: 'stop' });
    if (decision.kind === 'stop') expect(decision.reason).toContain(other);
  });

  it('stops on another floor when the task carries no climb at all', () => {
    const noClimb: TaskOrient = { goal: { site: 'ffxi-gcn' }, floor: FARM };
    expect(nextOrientStep(mapOf(CLIMB), noClimb)).toMatchObject({ kind: 'stop' });
  });

  it('opens the map from the 3-D view: the map is the only surface that prints the floor', () => {
    expect(nextOrientStep(screen('dungeon'), orient)).toEqual({ kind: 'command', command: { kind: 'open-map' } });
  });

  it('travels to the zone from Dungeon Select, and to the site from a town or the world map', () => {
    expect(nextOrientStep(screen('dungeon-select'), orient))
      .toEqual({ kind: 'command', command: { kind: 'travel', to: 'ffxi-zone3' } });
    expect(nextOrientStep(screen('town'), orient))
      .toEqual({ kind: 'command', command: { kind: 'travel', to: 'ffxi-gcn' } });
    expect(nextOrientStep(screen('worldmap'), orient))
      .toEqual({ kind: 'command', command: { kind: 'travel', to: 'ffxi-gcn' } });
  });

  it('travels to the site itself when the goal names no zone', () => {
    const site: TaskOrient = { goal: { site: 'vnh' }, floor: FARM };
    expect(nextOrientStep(screen('dungeon-select'), site))
      .toEqual({ kind: 'command', command: { kind: 'travel', to: 'vnh' } });
  });

  it('waits out a transition and lets the unnamed-screen rule handle the rest', () => {
    expect(nextOrientStep(screen('loading'), orient)).toEqual({ kind: 'wait', reason: 'loading' });
    expect(nextOrientStep(screen('unknown', 0.2), orient)).toEqual({ kind: 'wait', reason: 'unnamed' });
  });

  it('yields every screen the farm owns: a chest or a fight is never abandoned', () => {
    for (const id of ['chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'loot', 'combat'] as const) {
      expect(nextOrientStep(screen(id), orient), id).toEqual({ kind: 'yield' });
    }
  });
});
