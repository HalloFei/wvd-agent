import { describe, expect, it } from 'vitest';
import {
  BATTLE_OPENER_FILE, loadBattleOpeners, openersSource, parseBattleOpeners,
} from '../src/config/battle-openers.ts';

/**
 * The battle opener list is configuration, not code (operator rule 2026-11-10): `src/actions/battle.ts`
 * must not carry a member's name. These tests pin the switch, the parser's refusals and the shipped
 * file — the composition root only forwards the answer to the World.
 */

describe('the opener switch', () => {
  it('is off when unset, empty, off, none or 0 — and never silently the default file', () => {
    for (const value of [undefined, '', '  ', 'off', 'none', '0']) {
      expect(openersSource(value)).toEqual({ kind: 'off' });
    }
  });

  it('names the shipped file for "default" and treats any other value as a path', () => {
    expect(openersSource('default')).toEqual({ kind: 'file', path: BATTLE_OPENER_FILE });
    expect(openersSource('config/party-a.json')).toEqual({ kind: 'file', path: 'config/party-a.json' });
  });

  it('off reads no file at all', () => {
    let read = false;
    const load = loadBattleOpeners(undefined, () => { read = true; return ''; });
    expect(load).toEqual({ ok: true, source: { kind: 'off' }, openers: [] });
    expect(read).toBe(false);
  });
});

describe('the opener file', () => {
  it('reads the members and ignores keys it does not know (the file is self-documenting)', () => {
    const parsed = parseBattleOpeners(JSON.stringify({
      _comment: ['the party'],
      members: [{ name: ' 爱丽丝 ', slot: '左下', target: 'enemy' }],
    }));
    expect(parsed).toEqual({ ok: true, openers: [{ name: '爱丽丝', slot: '左下', target: 'enemy' }] });
  });

  it('refuses a member the cast could not use, naming its index — it does not drop it', () => {
    const badSlot = parseBattleOpeners(JSON.stringify({ members: [{ name: '爱丽丝', slot: '上', target: 'enemy' }] }));
    expect(badSlot).toMatchObject({ ok: false });
    expect(badSlot.ok ? '' : badSlot.reason).toContain('member 0 (爱丽丝)');
    const badTarget = parseBattleOpeners(JSON.stringify({ members: [{ name: '本杰明', slot: '右上', target: 'all' }] }));
    expect(badTarget).toMatchObject({ ok: false });
    const noName = parseBattleOpeners(JSON.stringify({ members: [{ slot: '右上', target: 'enemy' }] }));
    expect(noName).toMatchObject({ ok: false });
  });

  it('refuses a file that is not the shape, as a value', () => {
    expect(parseBattleOpeners('not json').ok).toBe(false);
    expect(parseBattleOpeners('[]').ok).toBe(false);
    expect(parseBattleOpeners('{}').ok).toBe(false);
    expect(parseBattleOpeners(JSON.stringify({ members: 'none' })).ok).toBe(false);
  });

  it('loads the shipped file, which ships no opener (the cast is off until the order is measured)', () => {
    const load = loadBattleOpeners('default');
    expect(load.ok).toBe(true);
    expect(load.ok ? load.openers : null).toEqual([]);
    expect(load.ok ? load.source : null).toEqual({ kind: 'file', path: BATTLE_OPENER_FILE });
  });

  it('a file the operator asked for and the reader cannot use is a refusal with its path', () => {
    const load = loadBattleOpeners('config/does-not-exist.json', () => { throw new Error('ENOENT'); });
    expect(load.ok).toBe(false);
    expect(load.ok ? '' : load.reason).toContain('config/does-not-exist.json');
    expect(load.ok ? '' : load.reason).toContain('ENOENT');
  });

  it('a file that parses badly keeps the path in the reason', () => {
    const load = loadBattleOpeners('config/x.json', () => '{ "members": [] }');
    expect(load.ok).toBe(true);
    const bad = loadBattleOpeners('config/x.json', () => '{');
    expect(bad.ok).toBe(false);
    expect(bad.ok ? '' : bad.reason).toContain('config/x.json');
  });
});
