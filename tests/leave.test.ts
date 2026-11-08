import { describe, expect, it } from 'vitest';
import type { MapState, Observation, Point, ScreenId } from '../src/contracts.ts';
import { nextLeaveStep, type LeaveContext } from '../src/policy/leave.ts';

/**
 * The leave's decision table (contracts §10, the goal form).
 *
 * Every case is one frame state, and the answer is what **that frame** allows: the exit is not a
 * cursor through a script, so an interrupted action is re-derived instead of assumed. The operator's
 * rule (2026-11-09) is the frame's kind: the farm floor may not take the harken's 归还; another site
 * floor may; a floor the site does not know stops the session instead of guessing.
 */

const FARM = '000000007f3ffe007ffeff00220bb600';
const ENTRY = '0c0280000deff0000d7ffc0008c37000';

const context = (floor: string | null): LeaveContext => ({
  to: 'vnh',
  farmFloor: FARM,
  knownFloors: [FARM, ENTRY],
  floor,
});

const screen = (id: ScreenId, confidence = 0.9): Observation => ({ screen: id, atMs: 0, confidence } as Observation);

const mapOf = (titleKey: string): Observation => ({
  screen: 'dungeonmap',
  atMs: 0,
  confidence: 0.85,
  map: { floorTitle: '', titleKey, player: { x: 10, y: 10 }, origin: { x: 960, y: 540 }, icons: [] } as MapState,
});

const harken = (rows: readonly { at: Point; label: string | null }[]): Observation => ({
  screen: 'harken-menu', atMs: 0, confidence: 0.947, rows,
} as Observation);

describe('nextLeaveStep', () => {
  it('is arrived on the town: the rest gate takes over', () => {
    expect(nextLeaveStep(screen('town'), context(null))).toEqual({ kind: 'arrived' });
  });

  it('travels to the destination from the world map and from Dungeon Select', () => {
    for (const id of ['worldmap', 'dungeon-select'] as const) {
      expect(nextLeaveStep(screen(id), context(null)), id)
        .toEqual({ kind: 'command', command: { kind: 'travel', to: 'vnh' } });
    }
  });

  it('opens the map from the 3-D view: the map prints the floor', () => {
    expect(nextLeaveStep(screen('dungeon'), context(null)))
      .toEqual({ kind: 'command', command: { kind: 'open-map' } });
  });

  it('exits from the farm floor with F, never with the harken', () => {
    // The farm floor's own exit is the stair; 归还 here would leave the party where no route measured.
    expect(nextLeaveStep(mapOf(FARM), context(FARM)))
      .toEqual({ kind: 'command', command: { kind: 'exit' } });
    // A noisy live read of the same floor (9 bits, R27b) is still the farm floor.
    expect(nextLeaveStep(mapOf('600004007f3ffe007ffefe0002032200'), context(FARM)))
      .toEqual({ kind: 'command', command: { kind: 'exit' } });
  });

  it('exits from another floor of the site: the floor chooses the order, not a step number', () => {
    expect(nextLeaveStep(mapOf(ENTRY), context(ENTRY)))
      .toEqual({ kind: 'command', command: { kind: 'exit' } });
  });

  it('stops on a floor the site does not know instead of guessing a way off it', () => {
    const decision = nextLeaveStep(mapOf('ffffffffffffffffffffffffffffffff'), context(null));
    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') return;
    expect(decision.reason).toContain('no measured way off it');
  });

  it('taps the matched 归还 row on a floor that may return', () => {
    const at = { x: 960, y: 679 };
    const decision = nextLeaveStep(harken([
      { at: { x: 960, y: 470 }, label: '第一区-城外-' },
      { at, label: '归还' },
      { at: { x: 960, y: 807 }, label: null },
    ]), context(ENTRY));
    // The tap is the row the reader matched — not a fixed coordinate.
    expect(decision).toEqual({ kind: 'command', command: { kind: 'tap-row', at, label: '归还' } });
  });

  it('backs out of the harken page on the farm floor: the party may not leave the floor it farms', () => {
    for (const floor of [FARM, null]) {
      expect(nextLeaveStep(harken([{ at: { x: 960, y: 679 }, label: '归还' }]), context(floor)), String(floor))
        .toEqual({ kind: 'command', command: { kind: 'back' } });
    }
  });

  it('stops when the harken page offers no 归还 row, naming what it did offer', () => {
    const decision = nextLeaveStep(harken([{ at: { x: 960, y: 470 }, label: '第一区-城外-' }]), context(ENTRY));
    expect(decision.kind).toBe('stop');
    if (decision.kind !== 'stop') return;
    expect(decision.reason).toContain('第一区-城外-');
  });

  it('waits out a transition and yields every screen the loop owns', () => {
    expect(nextLeaveStep(screen('loading'), context(ENTRY))).toEqual({ kind: 'wait', reason: 'loading' });
    expect(nextLeaveStep(screen('unknown', 0.2), context(ENTRY))).toEqual({ kind: 'wait', reason: 'unnamed' });
    for (const id of [
      'combat', 'chest-prompt', 'chest-open', 'chest-qte', 'chest-opening', 'drop-item-claim',
      'character-page', 'inn', 'inn-rest', 'message', 'ui-menu', 'skill-panel',
    ] as const) {
      expect(nextLeaveStep(screen(id), context(ENTRY)), id).toEqual({ kind: 'yield' });
    }
  });

  it('is a frame function, not a cursor: the same frame always gets the same order', () => {
    const frames: Observation[] = [
      mapOf(FARM), screen('dungeon'), mapOf(ENTRY), screen('loading'),
      harken([{ at: { x: 960, y: 679 }, label: '归还' }]), screen('dungeon-select'), screen('town'),
    ];
    const floors: (string | null)[] = [FARM, ENTRY, ENTRY, ENTRY, ENTRY, null, null];
    // The walk the World would make from the farm floor to the town; each answer depends only on its
    // own frame and floor. An interrupted walk re-enters at whatever frame the game is on.
    const first = frames.map((frame, index) => nextLeaveStep(frame, context(floors[index]!)));
    const second = frames.map((frame, index) => nextLeaveStep(frame, context(floors[index]!)));
    expect(second).toEqual(first);
    expect(first.map((decision) => decision.kind === 'command' ? decision.command.kind : decision.kind))
      .toEqual(['exit', 'open-map', 'exit', 'wait', 'tap-row', 'travel', 'arrived']);
  });
});
