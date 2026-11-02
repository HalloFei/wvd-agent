/**
 * The operator console's wire surface: the panel's id and read-only methods, the snapshot the panel
 * renders, and the one legal shape of a method's answer.
 *
 * Browser and Node sides share this file and nothing else, so it imports nothing and carries no
 * DOM types. The World answers it; `src/webui/client.ts` draws it.
 */

/** The panel id inside the World's page; ids are lowercase and carry no World prefix. */
export const CONSOLE_PANEL_ID = 'wvd-console';

/** The methods a GET may call. Start and stop change state, so they stay POST-only. */
export const CONSOLE_GET_METHODS = ['status', 'log'] as const;

/** The log keeps the last 50 transitions: a night is diagnosable without growing without bound. */
export const CONSOLE_LOG_LIMIT = 50;

/** The six states the design fixes. Exactly one is true at a time. */
export type ConsoleState = 'offline' | 'idle' | 'running' | 'escalating' | 'stopped' | 'error';

/** The World's own component lamp: online (including idle), loading, error, offline. */
export type ConsoleLamp = 'online' | 'loading' | 'error' | 'offline';

/** Why `start` is refused right now; absent means it is allowed. */
export type ConsoleStart = { ok: true } | { ok: false; reason: string };

/** The question an `escalating` snapshot carries, as the panel's card shows it. */
export interface ConsoleQuestion {
  readonly id: string;
  readonly text: string;
  /** The loop's clock when the verdict fired; the panel ages it against `nowMs`. */
  readonly askedAtMs: number;
  readonly timeoutMs: number;
}

/** One snapshot: the state word plus everything the live strip reads. */
export interface ConsoleStatus {
  readonly state: ConsoleState;
  readonly lamp: ConsoleLamp;
  /** One sentence on why the state is this one, or what the operator can fix. */
  readonly detail: string | null;
  readonly nowMs: number;
  readonly screen: string | null;
  /** The game's mode — the pipeline that owns the screen (contracts §6, `policy/mode.ts`). */
  readonly mode: string;
  /** The last map read, kept while the loop is on another screen: the party's own account of where it is. */
  readonly floor: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly chestsLeft: number | null;
  /** The last intent the loop executed, and how long ago: together with the frame age, tick health. */
  readonly intent: string | null;
  readonly intentAgeMs: number | null;
  /** Age of the last frame perception read, on the loop's clock. */
  readonly frameAgeMs: number | null;
  readonly escalationsThisHour: number;
  readonly escalateMaxPerHour: number;
  readonly question: ConsoleQuestion | null;
  readonly canStart: ConsoleStart;
  readonly canCancel: boolean;
}

/** What happened, in the words the morning-after reader needs. */
export type ConsoleLogKind =
  | 'started'
  | 'escalated'
  | 'answered'
  | 'timed-out'
  | 'undelivered'
  | 'cancelled'
  | 'stopped'
  | 'error';

/** One transition in the loop's bounded log. */
export interface ConsoleLogEntry {
  /** Wall-clock time, for a session that ended hours ago. */
  readonly at: string;
  /** The loop's monotonic clock, for ageing against `nowMs`. */
  readonly atMs: number;
  readonly kind: ConsoleLogKind;
  readonly text: string;
}

/** Every method answers this shape; a failure is rendered, never thrown at the page. */
export type ConsoleResult<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

/** One stream frame: a whole snapshot, so a dropped frame never leaves the strip half-updated. */
export interface ConsoleFrame {
  readonly type: 'status';
  readonly value: ConsoleStatus;
}
