import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { createDirectorySink, encodePng, refusalName, type RefusalRecord } from '../src/perception/ledger.ts';

const RECORD: RefusalRecord = {
  at: '2026-11-08T14:02:03.412',
  screen: 'unknown',
  gate: 'map-ink',
  confidence: 0,
  measures: { panelInk: 13_047 },
};

describe('the ledger s PNG', () => {
  it('is a lossless PNG whose pixels are the frame bytes, row for row', async () => {
    const image = { data: new Uint8Array(4 * 3 * 4), width: 4, height: 3 };
    for (let index = 0; index < image.data.length; index += 1) image.data[index] = (index * 7) % 256;

    const png = encodePng(image);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);

    // The IDAT decompresses to the filter byte + the frame's own bytes: nothing was re-encoded.
    const at = png.indexOf(Buffer.from('IDAT')) + 4;
    const length = png.readUInt32BE(png.indexOf(Buffer.from('IDAT')) - 4);
    const raw = inflateSync(png.subarray(at, at + length));
    const stride = image.width * 4;
    for (let y = 0; y < image.height; y += 1) {
      expect(raw[y * (stride + 1)]).toBe(0);
      expect(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
        .toEqual(Buffer.from(image.data.subarray(y * stride, (y + 1) * stride)));
    }
  });
});

describe('the ledger s files', () => {
  let root = '';
  afterEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('names a record by its clock and its gate, so a directory listing is a triage', () => {
    expect(refusalName(RECORD)).toBe('refusal-2026-11-08T14-02-03-412-map-ink');
  });

  it('files the frame losslessly beside the measurements', async () => {
    root = await mkdtemp(join(tmpdir(), 'wvd-ledger-'));
    const sink = createDirectorySink(root);
    const image = { data: new Uint8Array(2 * 2 * 4).fill(200), width: 2, height: 2 };

    const written = await sink.record(RECORD, image);

    const png = await readFile(written.png);
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const json = JSON.parse(await readFile(written.json, 'utf8'));
    expect(json).toEqual(RECORD);
    expect(written.png.endsWith('map-ink.png')).toBe(true);
  });
});
