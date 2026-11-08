/**
 * The refusal ledger: what a reader refused, filed so it can be learned from.
 *
 * Every stall this project paid for had the same shape — a frame the readers refused, a gate that named
 * itself in one log line, and then nothing: the frame was a q75 JPEG (the encode smoothing the very
 * detail that caused the refusal, 2026-11-08 twice) and the numbers were prose in a report. The corpus
 * grew only when a human remembered to add a fixture.
 *
 * This module is the sink. A refusal is filed as **PNG, lossless**, because the crash course of
 * 2026-11-08 is that a lossy snapshot cannot reproduce the refusal it documents; beside it goes a JSON
 * record with the screen, the gate, the confidence and every measured value, so a triage pass can sort
 * refusals by why they happened instead of by looking at images.
 *
 * It writes bytes and nothing else: no game, no loop, no policy. `scripts/triage-refusals.ts` is what
 * promotes a record to a fixture and a test.
 */
import { deflateSync } from 'node:zlib';
import type { RgbaImage } from '../contracts.ts';

/** What the reader refused, and what it measured. */
export interface RefusalRecord {
  /** Local ISO stamp, the file's own clock (the caller's, not this module's). */
  readonly at: string;
  /** The screen the loop fell back to — 'unknown' for a frame nothing named. */
  readonly screen: string;
  /** The gate (anchor) or reason that refused it, as the reader names it. */
  readonly gate: string;
  /** The confidence the frame answered with (0 when nothing was named). */
  readonly confidence: number;
  /** Every measurement the readers took on the frame, by name — the data a re-measure needs. */
  readonly measures: Readonly<Record<string, number>>;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    let value = (crc ^ bytes[index]!) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crc = (crc >>> 8) ^ value;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A lossless PNG of an RGBA frame (filter 0, one zlib stream). The one encoder in the project, because
 * the evidence that outlives a run must not be re-encoded: a q75 JPEG hid the exact ink column that made
 * the map parser refuse (2026-11-08), and the run's own snapshot could not reproduce it.
 */
export function encodePng(image: RgbaImage): Buffer {
  const { data, width, height } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;                                  // filter type: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;                                                // bit depth
  header[9] = 6;                                                // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A file name for one record: sortable, and it names the gate so a directory listing is a triage. */
export function refusalName(record: RefusalRecord): string {
  const stamp = record.at.replaceAll(':', '-').replaceAll('.', '-');
  const gate = record.gate.replaceAll(/[^a-z0-9-]/gi, '-');
  return `refusal-${stamp}-${gate}`;
}

/** Where a refusal goes. The directory is the caller's (the run's, or `.tmp/refusals`). */
export interface RefusalSink {
  record(entry: RefusalRecord, frame: RgbaImage): Promise<{ readonly png: string; readonly json: string }>;
}

/** Files a refusal as `<name>.png` + `<name>.json` under `root`. */
export function createDirectorySink(root: string): RefusalSink {
  return {
    async record(entry, frame) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await mkdir(root, { recursive: true });
      const name = refusalName(entry);
      const png = join(root, name + '.png');
      const json = join(root, name + '.json');
      await writeFile(png, encodePng(frame));
      await writeFile(json, JSON.stringify(entry, null, 2) + '\n');
      return { png, json };
    },
  };
}
