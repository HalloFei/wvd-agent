/**
 * The inn's one decision (operator, 2026-11-06): which row of the dialog to take.
 *
 * The operator's order:
 *
 * 1. the room the World is configured for (worlds.wvd.innRoom);
 * 2. when the inn does not offer it, the default **标准房**;
 * 3. when it offers no room this loop knows, the first room it does offer (the cheapest is drawn
 *    first — the operator's "other room types" still rest the party);
 * 4. the **确定** row that confirms the rest the room tap opened (the 住宿 confirmation dialog);
 * 5. the **住宿** row that leads from the service menu to the room list;
 * 6. the **返回** / **离开** / **取消** row that backs out of a dialog with no usable room.
 *
 * A dialog with none of those is no decision: the caller waits, and the stall clock owns it.
 */
import type { Point } from '../contracts.ts';

/** One row of the dialog, as the perceiver named it. */
export interface InnOption {
  readonly at: Point;
  readonly label: string;
}

/** The rest to take: the room the policy chose, or the row that leads to / confirms / out of it. */
export type InnRest =
  | {
      readonly kind: 'rest';
      readonly at: Point;
      readonly label: string;
      readonly why: 'configured' | 'default' | 'first-room';
    }
  | { readonly kind: 'stay'; readonly at: Point; readonly label: string }
  | { readonly kind: 'confirm'; readonly at: Point; readonly label: string }
  | { readonly kind: 'leave'; readonly at: Point; readonly label: string };

/** The room types the library names today; a new one is one more measured entry. */
export const INN_ROOM_LABELS: readonly string[] = ['马房', '标准房'];
/** The row that opens the room list from the innkeeper's service menu. */
export const INN_STAY_LABEL = '住宿';
/** The row that answers the rest confirmation. */
export const INN_CONFIRM_LABEL = '确定';
/** The rows that are not rooms: the service menu's other two, the confirmation pair, and the way out. */
export const INN_NOT_ROOM_LABELS: readonly string[] = ['住宿', '对话', '离开', '返回', '取消', '确定'];
/** The operator's default when the configured room is not offered. */
export const INN_DEFAULT_ROOM = '标准房';

/** The row to take, or null when the dialog offers nothing this loop can use. */
export function chooseInnRest(options: readonly InnOption[], wanted: string): InnRest | null {
  // A room option is any row that is not one of the dialog's known non-room rows: that is what makes
  // a room type the library has never seen still a room the party may take.
  const rooms = options.filter((option) => !INN_NOT_ROOM_LABELS.includes(option.label));
  const configured = wanted.trim() === '' ? null : rooms.find((option) => option.label === wanted) ?? null;
  if (configured !== null) return { kind: 'rest', at: configured.at, label: configured.label, why: 'configured' };
  const fallback = rooms.find((option) => option.label === INN_DEFAULT_ROOM) ?? null;
  if (fallback !== null) return { kind: 'rest', at: fallback.at, label: fallback.label, why: 'default' };
  if (rooms.length > 0) {
    const first = rooms[0]!;
    return { kind: 'rest', at: first.at, label: first.label, why: 'first-room' };
  }
  const confirm = options.find((option) => option.label === INN_CONFIRM_LABEL) ?? null;
  if (confirm !== null) return { kind: 'confirm', at: confirm.at, label: confirm.label };
  const stay = options.find((option) => option.label === INN_STAY_LABEL) ?? null;
  if (stay !== null) return { kind: 'stay', at: stay.at, label: stay.label };
  const leave = options.find((option) => option.label === '返回' || option.label === '离开' || option.label === '取消') ?? null;
  if (leave !== null) return { kind: 'leave', at: leave.at, label: leave.label };
  return null;
}
