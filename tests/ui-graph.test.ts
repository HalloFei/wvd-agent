import { describe, expect, it } from 'vitest';
import type { UiCatalog } from '../src/ui/catalog.ts';
import { entriesTo, exitOf, isRoot, pageById, rootOf, routeToRoot, validateCatalog } from '../src/ui/graph.ts';
import { UI_CATALOG, UI_PAGE_IDS } from '../src/ui/pages.ts';

describe('the knowledge base', () => {
  it('is structurally sound', () => {
    expect(validateCatalog(UI_CATALOG)).toEqual([]);
  });

  it('roots every section at a page with no exit', () => {
    expect(UI_CATALOG.pages.filter(isRoot).map((page) => page.id).sort()).toEqual(['dungeon', 'town']);
    for (const page of UI_CATALOG.pages) {
      expect(rootOf(UI_CATALOG, page.id)?.id).toBe(page.section === 'town' ? 'town' : 'dungeon');
    }
  });

  it('knows the page that stopped the 99-cycle run', () => {
    const records = pageById(UI_CATALOG, 'records');
    expect(records?.title).toContain('记录');
    expect(exitOf(records!)).toMatchObject({ label: '关闭', at: { x: 960, y: 870 }, child: 'dungeon' });
    expect(routeToRoot(UI_CATALOG, 'records')).toEqual([exitOf(records!)]);
  });

  it('walks a nested page home one exit at a time', () => {
    const route = routeToRoot(UI_CATALOG, 'inn-confirm');
    expect(route?.map((row) => row.label)).toEqual(['取消', '返回', '离开']);
    expect(route?.map((row) => row.child)).toEqual(['inn-rooms', 'inn-service', 'town']);
  });

  it('never routes through a button that spends or claims', () => {
    for (const page of UI_CATALOG.pages) {
      for (const row of routeToRoot(UI_CATALOG, page.id) ?? []) expect(row.kind).toBe('exit');
    }
  });

  it('names who opens each page, and only pages that exist', () => {
    expect(entriesTo(UI_CATALOG, 'records').map((entry) => entry.page)).toEqual(['dungeon']);
    expect(entriesTo(UI_CATALOG, 'inn-confirm').map((entry) => entry.page)).toEqual(['inn-rooms']);
    for (const id of UI_PAGE_IDS) expect(pageById(UI_CATALOG, id)).not.toBeNull();
  });
});

describe('the graph', () => {
  const catalog = (pages: UiCatalog['pages']): UiCatalog => ({ pages });
  const root = { id: 'r', title: 'root', section: 'town' as const, measured: 'test', rows: [] };
  const page = (id: string, child?: string): UiCatalog['pages'][number] => ({
    id,
    title: id,
    section: 'town',
    measured: 'test',
    rows: [{ label: '离开', kind: 'exit', at: { x: 1, y: 1 }, ...(child === undefined ? {} : { child }) }],
  });

  it('refuses an unknown page', () => {
    expect(routeToRoot(catalog([root]), 'nowhere')).toBeNull();
    expect(rootOf(catalog([root]), 'nowhere')).toBeNull();
  });

  it('refuses a cycle of exits', () => {
    const looped = catalog([root, page('a', 'b'), page('b', 'a')]);
    expect(routeToRoot(looped, 'a')).toBeNull();
    expect(validateCatalog(looped)).toContain('a has an exit chain that never reaches a root');
  });

  it('reports every structural fault in one pass', () => {
    const broken = catalog([
      root,
      {
        ...page('a', 'missing'),
        rows: [
          { label: '离开', kind: 'exit', at: { x: 9_999, y: 1 }, child: 'missing' },
          { label: '关闭', kind: 'exit', at: { x: 1, y: 1 } },
        ],
      },
      { id: 'dup', title: 'dup', section: 'town', measured: 'test', rows: [{ label: '买', kind: 'other', at: { x: 1, y: 1 }, child: 'r' }] },
      page('dup', 'r'),
      page('orphan', 'r'),
    ]);
    const problems = validateCatalog(broken);
    expect(problems).toContain('duplicate page id dup');
    expect(problems.some((line) => line.includes('points outside the 1920x1080 client'))).toBe(true);
    expect(problems.some((line) => line.includes('2 exits'))).toBe(true);
    expect(problems.some((line) => line.includes('which is not in the catalog'))).toBe(true);
    expect(problems.some((line) => line.includes('is other but carries a child edge'))).toBe(true);
    expect(problems.some((line) => line.includes('is not reachable from a root'))).toBe(true);
  });
});
