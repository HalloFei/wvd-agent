#!/usr/bin/env tsx
/** Where are the title and the readout on a live map frame? Compare with the parser's bands. */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

const luma = (d: Uint8Array, i: number): number => (d[i]! * 299 + d[i + 1]! * 587 + d[i + 2]! * 114) / 1000;

for (const file of process.argv.slice(2)) {
  const j = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const { data, width, height } = j;
  // title: bright pixels per row across x 700..1300
  const rows: string[] = [];
  for (let y = 10; y < 90; y += 2) {
    let bright = 0;
    for (let x = 700; x < 1300; x += 1) if (luma(data, (y * width + x) * 4) > 150) bright += 1;
    if (bright > 20) rows.push(y + ':' + bright);
  }
  // readout: lit columns in the parser's band (x 1010..1140, y 898..914) and where ink actually is
  const cols: string[] = [];
  for (let x = 980; x < 1180; x += 1) {
    let dark = 0;
    for (let y = 890; y < 925; y += 1) if (luma(data, (y * width + x) * 4) > 85) dark += 1;
    if (dark >= 3) cols.push(String(x));
  }
  console.log(file.replace(/.*[\\/]/, ''), '| title rows', rows.join(','), '| ink columns', cols.length ? cols[0] + '..' + cols[cols.length - 1] + ' n=' + cols.length : 'none');
}
