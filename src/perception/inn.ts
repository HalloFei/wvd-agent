/**
 * The rest town's inn (operator, 2026-11-06): the 旅店 dialog — the innkeeper's service menu
 * (住宿 / 对话 / 离开) and the room list behind it (马房 / 标准房 / 返回, the room rows carrying a
 * price on the right).
 *
 * The operator's rule is what makes it a screen: **the room options identify it** — a dialog that
 * offers rooms (or the 住宿 row that leads to them) is the inn, whatever the room types are. So the
 * recogniser reads the dialog's rows against the measured library (`inn-library.ts`): a row whose
 * label the library knows is a row, and two named rows are the floor — one stray match is never a
 * dialog.
 *
 * The dialog is the game's fixed UI, so the rows are **measured positions**, not a text-line scan
 * (the labels' dark outlines split a scan into fragments on the live frame — measured 2026-11-06):
 *
 * - the room list (`inn-rooms-1280.jpg`): 马房 / 标准房 / 返回 at y 0.5083 / 0.5611 / 0.6111;
 * - the service menu (`inn-service-1920.jpg`): 住宿 / 对话 / 离开 at y 0.4519 / 0.5352 / 0.5935.
 *
 * Each row is read in the band the library was sampled in (x 0.50..0.615, ±0.014 of the height), and
 * the tap point is x 0.58 of the width — the button's interior, left of the room prices — at the
 * row's own text line.
 */
import type { Frame, Observation, Perceiver, Point, RgbaImage } from '../contracts.ts';
import { INN_ROW_LABELS } from './inn-library.ts';
import { StripLibraryReader } from './reader.ts';

/** The label band: x 0.50..0.615 of the width, as the library was sampled. */
const LABEL_BAND = { x0: 0.5, x1: 0.615 } as const;
/** Half a row's text line, as a fraction of the height: the band the library entry was sampled in. */
const ROW_HALF_HEIGHT = 0.014;
/** The label match floor: the recordings answer their own rows at 1.00 and nothing else clears this. */
const LABEL_FLOOR = 0.75;
/** The row's tap point: the button's interior, left of where the room prices are drawn. */
const TAP_X = 0.58;

/** One measured dialog layout: its rows' text-line centres, as fractions of the height. */
interface InnLayout {
  readonly name: string;
  readonly centres: readonly number[];
}

/** The two dialogs the library was measured on (2026-11-06): the room list, and the service menu. */
export const INN_LAYOUTS: readonly InnLayout[] = [
  { name: 'rooms', centres: [0.5083, 0.5611, 0.6111] },
  { name: 'service', centres: [0.4519, 0.5352, 0.5935] },
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
    for (const centre of layout.centres) {
      const region = {
        x0: LABEL_BAND.x0,
        y0: centre - ROW_HALF_HEIGHT,
        x1: LABEL_BAND.x1,
        y1: centre + ROW_HALF_HEIGHT,
      };
      const reader = new StripLibraryReader('inn-row', region, INN_ROW_LABELS, LABEL_FLOOR);
      const answer = reader.read(image);
      if (answer === null) continue;
      rows.push({
        at: { x: Math.round(image.width * TAP_X), y: Math.round(image.height * centre) },
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
