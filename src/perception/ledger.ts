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
import { deflateSync, inflateSync } from 'node:zlib';
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

/**
 * The inverse of {@link encodePng}, so a filed refusal can be **re-read** — by the triage script, by a
 * test, by a reader run by hand.
 *
 * This is the function the lossless ledger was for: the frame production refused was raw BGRA, and a
 * q75 JPEG snapshot of it hides the very detail the gate measured (2026-11-08, twice). A PNG of that
 * frame carries the same bytes, so re-classifying it with the production chain answers the same
 * question the loop asked — which is what a stall diagnosis needs.
 *
 * 8-bit RGB/RGBA, non-interlaced: what this project writes, and what every screenshot tool here emits.
 * Anything else is refused by name rather than decoded into a lie.
 */
export function decodePng(file: Buffer): RgbaImage {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (file[i] !== signature[i]) throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const data: Buffer[] = [];
  while (offset + 8 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colourType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} is not supported`);
  if (colourType !== 6 && colourType !== 2) throw new Error(`PNG colour type ${colourType} is not supported`);
  if (interlace !== 0) throw new Error('an interlaced PNG is not supported');
  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start]!, line, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from]!;
      out[to + 1] = line[from + 1]!;
      out[to + 2] = line[from + 2]!;
      out[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    previous = line;
  }
  return { data: out, width, height };
}

/** The PNG filter types, in place (§9.2 of the format): 0 none, 1 sub, 2 up, 3 average, 4 paeth. */
function unfilter(filter: number, line: Buffer, previous: Buffer, channels: number): void {
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= channels ? line[i - channels]! : 0;
    const up = previous[i]!;
    switch (filter) {
      case 0: break;
      case 1: line[i] = (line[i]! + left) & 0xff; break;
      case 2: line[i] = (line[i]! + up) & 0xff; break;
      case 3: line[i] = (line[i]! + ((left + up) >> 1)) & 0xff; break;
      case 4: line[i] = (line[i]! + paeth(left, up, i >= channels ? previous[i - channels]! : 0)) & 0xff; break;
      default: throw new Error(`PNG filter ${filter} is not supported`);
    }
  }
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
