/**
 * The QTE recorder's file sink (operator rule 2026-11-05): the chest path records its own bar, so the
 * data a future band model needs is collected on the run that produced it.
 *
 * One JSONL line per event — every accepted reading, the plan, the press with its send/ack timing and
 * the child's `inputMs`, and the rest with the carry time measured from the park. The events are the
 * samples the timing loop already took, so the sink costs an append each and no extra capture. A
 * failed write is swallowed: the recording must never cost the bar.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import type { QteRecordEvent, QteRecordSink } from './qte.ts';

/** A sink writing `<dir>/qte.jsonl`; the directory is created when the recorder starts. */
export function createQteFileRecorder(dir: string): QteRecordSink {
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/qte.jsonl`;
  return (event: QteRecordEvent): void => {
    try {
      appendFileSync(file, `${JSON.stringify(event)}\n`);
    } catch {
      // scratch only: a failed write changes nothing about the run
    }
  };
}
