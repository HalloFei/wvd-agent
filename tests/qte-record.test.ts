import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createQteFileRecorder } from '../src/actions/qte-record.ts';

/**
 * The chest path records its own bar (operator rule 2026-11-05): the sink writes one JSONL line per
 * event, so a later band model has the readings, the plan, the press timing and the carry without a
 * separate probe run.
 */
describe('the QTE recorder sink', () => {
  it('writes one JSON line per event, and never throws on a bad directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wvd-qte-record-'));
    try {
      const record = createQteFileRecorder(join(dir, 'nested'));
      record({ kind: 'reading', atMs: 33, markerX: 720, zones: [{ from: 696, to: 920 }], enabled: true });
      record({ kind: 'press', sentAtMs: 100, ackAtMs: 140, ok: true, inputMs: 76, delayActualMs: 52.2, target: 808, v: 606 });
      const lines = (await readFile(join(dir, 'nested', 'qte.jsonl'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).kind).toBe('reading');
      const press = JSON.parse(lines[1]!);
      expect(press.inputMs).toBe(76);
      expect(press.delayActualMs).toBeCloseTo(52.2, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
