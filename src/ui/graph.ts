/**
 * What the knowledge base can answer: a page's exit, a section's root, and the taps that walk a page
 * home.
 *
 * The walk is advisory, not a script: the World sends one command per tick and re-reads the frame
 * after it, so a route is recomputed from whatever page is actually on screen. That is also what
 * makes a non-tree safe - 祝福之日 measured over the trader closes onto whichever page it covered,
 * and the next observation picks the true parent.
 *
 * Nothing here ever returns an 'other' button: a route through a purchase is not a route home.
 */
import type { UiButton, UiCatalog, UiPage } from './catalog.ts';

/** The page with this id, or null. */
export function pageById(catalog: UiCatalog, id: string): UiPage | null {
  return catalog.pages.find((page) => page.id === id) ?? null;
}

/** The page's single exit row, or null for a section root. */
export function exitOf(page: UiPage): UiButton | null {
  return page.rows.find((row) => row.kind === 'exit') ?? null;
}

/** A page with no exit: the place an exit chain ends. */
export function isRoot(page: UiPage): boolean {
  return exitOf(page) === null;
}

/**
 * The taps that leave this page and everything above it, nearest first. Null when the page is
 * unknown or an exit chain is broken (a cycle, or a child that is not in the catalog).
 */
export function routeToRoot(catalog: UiCatalog, id: string): readonly UiButton[] | null {
  const route: UiButton[] = [];
  const seen = new Set<string>();
  let current = pageById(catalog, id);
  if (current === null) return null;
  while (current !== null) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const exit = exitOf(current);
    if (exit === null) return route;
    route.push(exit);
    if (exit.child === undefined) return null;
    current = pageById(catalog, exit.child);
  }
  return null;
}

/** The section root this page's exit chain ends at, or null. */
export function rootOf(catalog: UiCatalog, id: string): UiPage | null {
  let current = pageById(catalog, id);
  const seen = new Set<string>();
  while (current !== null && exitOf(current) !== null) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const exit = exitOf(current)!;
    if (exit.child === undefined) return null;
    current = pageById(catalog, exit.child);
  }
  return current;
}

/** Every button that leads into this page (enter edges only). */
export function entriesTo(catalog: UiCatalog, id: string): readonly { readonly page: string; readonly row: UiButton }[] {
  const entries: { page: string; row: UiButton }[] = [];
  for (const page of catalog.pages) {
    for (const row of page.rows) {
      if (row.kind === 'enter' && row.child === id) entries.push({ page: page.id, row });
    }
  }
  return entries;
}

/**
 * The catalog's structural problems, as one line each. Empty means the graph is sound: unique ids,
 * one exit per non-root, every exit naming a child that exists, every exit chain ending at a root,
 * every page reachable from a root, and no 'other' button carrying an edge. An enter row without a
 * child is legal: the button was found and placed, but what it opens has not been probed yet.
 */
export function validateCatalog(catalog: UiCatalog): readonly string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const page of catalog.pages) {
    if (ids.has(page.id)) problems.push('duplicate page id ' + page.id);
    ids.add(page.id);
  }
  const roots = catalog.pages.filter(isRoot);
  if (roots.length === 0) problems.push('the catalog has no root: every page has an exit');
  for (const page of catalog.pages) {
    const exits = page.rows.filter((row) => row.kind === 'exit');
    if (exits.length > 1) problems.push(page.id + ' has ' + exits.length + ' exits; a page has at most one');
    for (const row of page.rows) {
      if (row.at.x < 0 || row.at.x > 1_920 || row.at.y < 0 || row.at.y > 1_080) {
        problems.push(page.id + ' / ' + row.label + ' points outside the 1920x1080 client');
      }
      if (row.child !== undefined && !ids.has(row.child)) {
        problems.push(page.id + ' / ' + row.label + ' leads to ' + row.child + ', which is not in the catalog');
      }
      if (row.kind === 'other' && row.child !== undefined) {
        problems.push(page.id + ' / ' + row.label + ' is other but carries a child edge');
      }
      // An enter row may be located only: the button is named and placed, its destination unseen.
      // An exit must lead somewhere, or the page could never be left by the graph's own advice.
      if (row.kind === 'exit' && row.child === undefined) {
        problems.push(page.id + ' / ' + row.label + ' is an exit with no child');
      }
    }
    if (exitOf(page) !== null && rootOf(catalog, page.id) === null) {
      problems.push(page.id + ' has an exit chain that never reaches a root');
    }
  }
  if (roots.length > 0) {
    const reachable = new Set<string>(roots.map((root) => root.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const page of catalog.pages) {
        if (reachable.has(page.id)) continue;
        if (entriesTo(catalog, page.id).some((entry) => reachable.has(entry.page))) {
          reachable.add(page.id);
          grew = true;
        }
      }
    }
    for (const page of catalog.pages) {
      if (!reachable.has(page.id)) problems.push(page.id + ' is not reachable from a root');
    }
  }
  return problems;
}
