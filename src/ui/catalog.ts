/**
 * The UI knowledge base: the game's pages as a directed graph.
 *
 * The operator's rule (2026-11-06): a page is a set of named buttons, and every button is one of
 * three kinds - enter (it opens a sub-page), exit (it returns to the page that opened this one) and
 * other (it spends, claims or destroys; a probe records it and never presses it). A page that knows
 * its exit can always be left, so a graph of exits answers 'how do I get home from here' for every
 * page at once - which is what the World needs when something it did not expect is on screen.
 *
 * Sections say where a page lives: the title screen, the town, the dungeon, a battle, the world map
 * (operator, 2026-11-06: 'there can be different sections as well, GUI in dungeon, in combat, in
 * worldmap, in town'). A section's root is the page with no exit of its own; every exit chain ends
 * at one.
 *
 * The graph is directed, not a tree: 祝福之日 was measured opening over the trader and over the town,
 * so one page can be a child of more than one parent. It is also not exhaustive: the catalog holds
 * what has been probed and named, and a button whose destination has not been seen carries no child
 * - a named, placed button, never a guessed edge.
 *
 * Every point is client pixels at the game's 1920x1080 client (contracts section 0.5), the space the
 * rest of the package taps in. A point is a measurement from a captured frame; it is never derived
 * from another point.
 */
import type { Point } from '../contracts.ts';

/** Where a page lives. A section is a place in the game, not a menu. */
export type UiSection = 'boot' | 'town' | 'dungeon' | 'combat' | 'worldmap';

/** What pressing a button does to the page stack. */
export type UiButtonKind = 'enter' | 'exit' | 'other';

/** One button as measured: what it says, what pressing it does, and where it is. */
export interface UiButton {
  /** The button's own label, as the page draws it. */
  readonly label: string;
  readonly kind: UiButtonKind;
  /** Tap point, client pixels at 1920x1080. */
  readonly at: Point;
  /**
   * For enter and exit: the page the button leads to. Absent when the destination has not been
   * probed, or when the button leads nowhere that is a page.
   */
  readonly child?: string;
}

/** One page: its own title, the section it lives in, and its buttons. */
export interface UiPage {
  /** Stable id the graph and task files use; the title is for people. */
  readonly id: string;
  /** The page's own title as drawn, transliterated when it draws only an icon. */
  readonly title: string;
  readonly section: UiSection;
  /** Every button measured on the page, in reading order. Exactly one exit, unless this is a root. */
  readonly rows: readonly UiButton[];
  /** What was measured, when, and anything a reader must know to trust the rows. */
  readonly measured: string;
  /** A further note: an observed ambiguity, or how a button was verified. */
  readonly note?: string;
  /**
   * The **screen** that opens this page when no catalogued page does — a loot card, say, which is a
   * perceiver screen rather than one of the catalog's pages. Such a page has no enter edge to reach it,
   * so the validator lets it stand as an entry point instead of calling it unreachable.
   */
  readonly opensFrom?: string;
}

/** The knowledge base. Pages are addressed by id; order is provenance, not meaning. */
export interface UiCatalog {
  readonly pages: readonly UiPage[];
}
