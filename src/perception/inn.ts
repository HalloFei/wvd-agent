/**
 * The rest town's inn (operator, 2026-11-06): the 旅店 dialog — the innkeeper's service menu
 * (住宿 / 对话 / 离开), the room list behind it (马房 / 标准房 / 返回, the room rows carrying a price
 * on the right), and the rest confirmation that follows a room (住宿 / 取消 / 确定).
 *
 * The operator's rule is what makes it a screen: **the room options identify it** — a dialog that
 * offers rooms (or the 住宿 row that leads to them) is the inn, whatever the room types are. So the
 * recogniser reads the dialog's rows against the measured library (inn-library.ts): a row whose label
 * the library knows is a row, and two named rows are the floor — one stray match is never a dialog.
 *
 * The dialogs are the game's fixed UI, so the rows are **measured positions**, not a text-line scan
 * (the labels' dark outlines split a scan into fragments on the live frame — measured 2026-11-06):
 *
 * - the room list (inn-rooms-1280.jpg): 马房 / 标准房 / 返回 at y 0.5083 / 0.5611 / 0.6111;
 * - the service menu (inn-service-1920.jpg): 住宿 / 对话 / 离开 at y 0.4519 / 0.5352 / 0.5935;
 * - the rest confirmation (inn-confirm-1920.jpg): 取消 / 确定 side by side at y 0.625.
 *
 * Each row is read in the band the library was sampled in (a layout's band centre ± half-width, and
 * ± 0.014 of the height), and the tap point is the button's interior: x 0.58 of the width for the
 * stacked dialogs (left of the room prices), the button's own centre for the confirmation pair.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';
import { INN_ROW_LABELS } from './inn-library.ts';
import { StripLibraryReader } from './reader.ts';

/** Half a row's text line, as a fraction of the height: the band the library entry was sampled in. */
const ROW_HALF_HEIGHT = 0.014;
/** The label match floor: the recordings answer their own rows at 1.00 and nothing else clears this. */
const LABEL_FLOOR = 0.75;

/** One row of a measured layout: where its label band sits, and where a tap goes. */
export interface InnLayoutRow {
  /** The label band's centre x, fraction of the width. */
  readonly bandX: number;
  /** The row's text line, fraction of the height. */
  readonly y: number;
  /** The tap point's x, fraction of the width. */
  readonly tapX: number;
}

/** One measured dialog: its label band's half-width, and its rows. */
export interface InnLayout {
  readonly name: string;
  /** The label band's half-width, fraction of the width. */
  readonly halfWidth: number;
  readonly rows: readonly InnLayoutRow[];
}

const stacked = (centres: readonly number[]): readonly InnLayoutRow[] =>
  centres.map((y) => ({ bandX: 0.5575, y, tapX: 0.58 }));

/** The three dialogs the library was measured on (2026-11-06). */
export const INN_LAYOUTS: readonly InnLayout[] = [
  { name: 'rooms', halfWidth: 0.0575, rows: stacked([0.5083, 0.5611, 0.6111]) },
  { name: 'service', halfWidth: 0.0575, rows: stacked([0.4519, 0.5352, 0.5935]) },
  {
    name: 'confirm',
    halfWidth: 0.03,
    rows: [
      { bandX: 0.445, y: 0.625, tapX: 0.445 },
      { bandX: 0.553, y: 0.625, tapX: 0.553 },
    ],
  },
];

/** One row of the dialog: where it sits, and the label the library knows. */
export interface InnRow {
  readonly at: Point;
  readonly label: string;
  readonly score: number;
}

/** The rows found, top to bottom. */
export interface InnMenu {
  readonly layout: string;
  readonly rows: readonly InnRow[];
}

/** Finds the inn's dialog on the frame, or null when no measured layout carries two known rows. */
export function findInn(image: RgbaImage): InnMenu | null {
  for (const layout of INN_LAYOUTS) {
    const rows: InnRow[] = [];
    for (const row of layout.rows) {
      const region = {
        x0: row.bandX - layout.halfWidth,
        y0: row.y - ROW_HALF_HEIGHT,
        x1: row.bandX + layout.halfWidth,
        y1: row.y + ROW_HALF_HEIGHT,
      };
      const reader = new StripLibraryReader('inn-row', region, INN_ROW_LABELS, LABEL_FLOOR);
      const answer = reader.read(image);
      if (answer === null) continue;
      rows.push({
        at: { x: Math.round(image.width * row.tapX), y: Math.round(image.height * row.y) },
        label: answer.value.label,
        score: answer.value.score,
      });
    }
    if (rows.length >= 2) return { layout: layout.name, rows };
  }
  return null;
}

/** Names the inn's dialog; unknown when no measured layout carries two known rows. */
export class InnPerceiver implements Perceiver {
  async observe(frame: Frame): Promise<Observation> {
    const unknown: Observation = { screen: 'unknown', atMs: frame.atMs, confidence: 0 };
    let image: RgbaImage;
    try {
      image = await frame.toRgba();
    } catch {
      return unknown;
    }
    const menu = findInn(image);
    if (menu === null) return unknown;
    const confidence = Math.max(...menu.rows.map((row) => row.score));
    return { screen: 'inn', atMs: frame.atMs, confidence, rows: menu.rows.map(({ at, label }) => ({ at, label })) };
  }
}
