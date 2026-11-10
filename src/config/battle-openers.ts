/**
 * The battle opener list, as **configuration** rather than code (operator rule, 2026-11-10).
 *
 * `src/actions/battle.ts` must not carry the operator's party: which member opens a battle, from which
 * quick slot and at which side is data — it changes with the party, not with the code — and the legacy
 * autoscript keeps it as a script setting for the same reason. This module is the one reader of it, and
 * the composition root (`src/main.ts`) hands the result to the World as `battle.openers`.
 *
 * The switch is `WVD_BATTLE_OPENERS`:
 *
 * - unset, `off`, `none` or `0` — **no opener is loaded**: the battle sequence casts nothing (no 自動
 *   off, no slot, no confirm), exactly as `policy/battle-sequence.ts` behaves with an empty list. This
 *   is the default; the cast is off until the action order is measured (card `t-mw9jlglv-5pivpl`).
 * - `default` — load `config/battle-openers.json` (the shipped file).
 * - anything else — load that path.
 *
 * A file the operator asked for and the reader cannot use is a **refusal**, never an empty list: a
 * typo must not farm with the wrong cast, and it must not silently farm with none. The refusal is a
 * value carrying the path and the reason; the composition root prints it once and runs with no cast.
 */
import { readFileSync } from 'node:fs';
import type { BattleOpener, BattleSlot, BattleTarget } from '../contracts.ts';

/** The file `WVD_BATTLE_OPENERS=default` loads, relative to the package root. */
export const BATTLE_OPENER_FILE = 'config/battle-openers.json';

const SLOTS: readonly BattleSlot[] = ['左上', '右上', '左下', '右下'];
const TARGETS: readonly BattleTarget[] = ['enemy', 'party-front'];

/** Where the switch points: nowhere, or a file. */
export type OpenersSource = { readonly kind: 'off' } | { readonly kind: 'file'; readonly path: string };

/** What the loader answers: a list (possibly empty), or why it could not use the file it was given. */
export type OpenersLoad =
  | { readonly ok: true; readonly source: OpenersSource; readonly openers: readonly BattleOpener[] }
  | { readonly ok: false; readonly source: OpenersSource; readonly reason: string };

/**
 * The switch, as a value. An empty value is `off` — never "the default file": turning the cast off
 * must not depend on a file being absent, and a missing file is reported, not smoothed into silence.
 */
export function openersSource(envValue: string | undefined): OpenersSource {
  const value = (envValue ?? '').trim();
  if (value === '' || value === 'off' || value === 'none' || value === '0') return { kind: 'off' };
  if (value === 'default') return { kind: 'file', path: BATTLE_OPENER_FILE };
  return { kind: 'file', path: value };
}

/**
 * Parse the file's text. Total: every failure is a value. `members` is the only key read, so a file
 * may carry its own `_comment`; a member's name is trimmed, and an unknown `slot`/`target` is refused
 * with the member's index rather than dropped (a config that half-loads is a cast nobody asked for).
 */
export function parseBattleOpeners(
  text: string,
): { readonly ok: true; readonly openers: readonly BattleOpener[] } | { readonly ok: false; readonly reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not JSON (${(error as Error).message})` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the file is not a JSON object' };
  }
  const members = (parsed as { members?: unknown }).members;
  if (!Array.isArray(members)) return { ok: false, reason: 'no "members" array' };

  const openers: BattleOpener[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index] as Record<string, unknown> | null;
    if (member === null || typeof member !== 'object') {
      return { ok: false, reason: `member ${index} is not an object` };
    }
    const name = typeof member.name === 'string' ? member.name.trim() : '';
    if (name === '') return { ok: false, reason: `member ${index} has no "name"` };
    const slot = member.slot as BattleSlot;
    if (!SLOTS.includes(slot)) {
      return { ok: false, reason: `member ${index} (${name}) has no valid "slot" (${SLOTS.join('|')})` };
    }
    const target = member.target as BattleTarget;
    if (!TARGETS.includes(target)) {
      return { ok: false, reason: `member ${index} (${name}) has no valid "target" (${TARGETS.join('|')})` };
    }
    openers.push({ name, slot, target });
  }
  return { ok: true, openers };
}

/**
 * Load what the switch names. `read` is injected so the switch and the parser are testable without a
 * file; the default reads from the current directory, which is the package root the harness runs from.
 */
export function loadBattleOpeners(
  envValue: string | undefined,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): OpenersLoad {
  const source = openersSource(envValue);
  if (source.kind === 'off') return { ok: true, source, openers: [] };
  let text: string;
  try {
    text = read(source.path);
  } catch (error) {
    return { ok: false, source, reason: `cannot read ${source.path} (${(error as Error).message})` };
  }
  const parsed = parseBattleOpeners(text);
  return parsed.ok ? { ok: true, source, openers: parsed.openers } : { ok: false, source, reason: `${source.path}: ${parsed.reason}` };
}
