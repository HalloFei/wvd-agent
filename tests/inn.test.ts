import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import type { Frame, RgbaImage } from '../src/contracts.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { findInn, InnPerceiver } from '../src/perception/inn.ts';
import { chooseInnRest, INN_DEFAULT_ROOM } from '../src/policy/inn.ts';

const INN = new URL('../testdata/screens/2026-11-06-inn/', import.meta.url);
const BATTLE = new URL('../testdata/battle-2026-11-02/', import.meta.url);
const HARKEN = new URL('../testdata/screens/2026-11-03-harken-menu/', import.meta.url);
const DEATH = new URL('../testdata/screens/2026-11-05-main-character-death/', import.meta.url);
const NAV = new URL('../testdata/nav-2026-10-24-ffxi4f/', import.meta.url);
const CHEST = new URL('../testdata/chest/2026-10-24-opener/', import.meta.url);
const LIST = new URL('../testdata/screens/2026-10-24-ffxi/', import.meta.url);

async function imageAt(dir: URL, name: string): Promise<RgbaImage> {
  const decoded = jpeg.decode(await readFile(new URL(name, dir)), { useTArray: true });
  return { data: decoded.data, width: decoded.width, height: decoded.height };
}

async function frameAt(dir: URL, name: string): Promise<Frame> {
  const image = await imageAt(dir, name);
  return { atMs: 0, width: image.width, height: image.height, toRgba: async () => image };
}

describe('the rest town\'s inn', () => {
  it('names the room list and reads its rows (1280 recording)', async () => {
    const image = await imageAt(INN, 'inn-rooms-1280.jpg');
    const menu = findInn(image);
    expect(menu).not.toBeNull();
    expect(menu!.rows.map((row) => row.label)).toEqual(['马房', '标准房', '返回']);
    // The rows are the measure: each tap point is the row's own text line, inside the button.
    for (const row of menu!.rows) expect(row.at.y).toBeGreaterThan(0);
    const answer = await new InnPerceiver().observe(await frameAt(INN, 'inn-rooms-1280.jpg'));
    expect(answer.screen).toBe('inn');
    if (answer.screen !== 'inn') throw new Error('unreachable');
    expect(answer.rows.map((row) => row.label)).toEqual(['马房', '标准房', '返回']);
    expect(answer.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('names the service menu too (1920 recording)', async () => {
    const menu = findInn(await imageAt(INN, 'inn-service-1920.jpg'));
    expect(menu).not.toBeNull();
    expect(menu!.rows.map((row) => row.label)).toEqual(['住宿', '对话', '离开']);
    const answer = await new InnPerceiver().observe(await frameAt(INN, 'inn-service-1920.jpg'));
    expect(answer.screen).toBe('inn');
  });

  it('names the rest confirmation and the policy answers 确定 (1920 and its 1280 copy)', async () => {
    for (const name of ['inn-confirm-1920.jpg', 'inn-confirm-1280.jpg']) {
      const menu = findInn(await imageAt(INN, name));
      expect(menu, name).not.toBeNull();
      expect(menu!.rows.map((row) => row.label), name).toEqual(['取消', '确定']);
      const answer = await new InnPerceiver().observe(await frameAt(INN, name));
      expect(answer.screen, name).toBe('inn');
    }
    const choice = chooseInnRest([
      { at: { x: 854, y: 675 }, label: '取消' },
      { at: { x: 1062, y: 675 }, label: '确定' },
    ], '标准房');
    expect(choice).toMatchObject({ kind: 'confirm', label: '确定' });
  });

  it('does not fire on the screens around it', async () => {
    const perceiver = new InnPerceiver();
    for (const [dir, name] of [
      [BATTLE, 'command-phase.jpg'],
      [HARKEN, 'harken-2f-1920.jpg'],
      [DEATH, 'death.jpeg'],
      [NAV, 'third-floor.jpg'],
      [CHEST, 'prompt-ffxi.jpg'],
      [LIST, 'dungeon-select.jpg'],
    ] as const) {
      const answer = await perceiver.observe(await frameAt(dir, name));
      expect(answer.screen, name).toBe('unknown');
    }
  });

  it('is the composite\'s answer on the inn frame', async () => {
    const composite = new CompositePerceiver([{ perceiver: new InnPerceiver(), floor: 0.5 }]);
    const answer = await composite.observe(await frameAt(INN, 'inn-rooms-1280.jpg'));
    expect(answer.screen).toBe('inn');
  });
});

describe('the inn\'s room choice', () => {
  const roomList = [
    { at: { x: 1120, y: 550 }, label: '马房' },
    { at: { x: 1120, y: 606 }, label: '标准房' },
    { at: { x: 1120, y: 662 }, label: '返回' },
  ];
  const service = [
    { at: { x: 1120, y: 488 }, label: '住宿' },
    { at: { x: 1120, y: 578 }, label: '对话' },
    { at: { x: 1120, y: 641 }, label: '离开' },
  ];

  it('takes the configured room when the inn offers it', () => {
    const choice = chooseInnRest(roomList, '马房');
    expect(choice).toMatchObject({ kind: 'rest', label: '马房', why: 'configured', at: roomList[0]!.at });
  });

  it('falls back to the default room when the configured one is not offered', () => {
    const choice = chooseInnRest(roomList, '上等房');
    expect(choice).toMatchObject({ kind: 'rest', label: INN_DEFAULT_ROOM, why: 'default' });
  });

  it('rests in the first room when neither the configured nor the default room is offered', () => {
    const choice = chooseInnRest([
      { at: { x: 1, y: 2 }, label: '马房' },
      { at: { x: 1, y: 3 }, label: '上等房' },
      { at: { x: 1, y: 4 }, label: '返回' },
    ], '豪華房');
    expect(choice).toMatchObject({ kind: 'rest', label: '马房', why: 'first-room' });
  });

  it('takes 住宿 from the service menu', () => {
    expect(chooseInnRest(service, '标准房')).toMatchObject({ kind: 'stay', label: '住宿' });
  });

  it('backs out of a room list with no usable room', () => {
    expect(chooseInnRest([{ at: { x: 1, y: 2 }, label: '返回' }], '标准房'))
      .toMatchObject({ kind: 'leave', label: '返回' });
  });

  it('backs out instead of resting again once the visit has rested', () => {
    // Operator rule 2026-11-06: the inn heals once a visit; a menu that reopens after the rest is the
    // way out, not a second rest (the live 01:53 loop rested five times in 25 s).
    expect(chooseInnRest(roomList, '标准房', true)).toMatchObject({ kind: 'leave', label: '返回' });
    expect(chooseInnRest(service, '标准房', true)).toMatchObject({ kind: 'leave', label: '离开' });
    expect(chooseInnRest([
      { at: { x: 854, y: 675 }, label: '取消' },
      { at: { x: 1062, y: 675 }, label: '确定' },
    ], '标准房', true)).toMatchObject({ kind: 'leave', label: '取消' });
    expect(chooseInnRest([], '标准房', true)).toBeNull();
  });

  it('makes no decision on a dialog with nothing it can use', () => {
    expect(chooseInnRest([], '标准房')).toBeNull();
    expect(chooseInnRest([{ at: { x: 1, y: 2 }, label: '对话' }], '标准房')).toBeNull();
  });
});
