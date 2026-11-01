#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
for (const file of process.argv.slice(2)) {
  const j = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const w = j.width, h = j.height;
  const box = (x0: number, x1: number, y0: number, y1: number) => {
    const X0 = Math.round(w * x0), X1 = Math.round(w * x1), Y0 = Math.round(h * y0), Y1 = Math.round(h * y1);
    let bright = 0, over40 = 0, n = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const o = (y * w + x) * 4; const r = j.data[o]!, g2 = j.data[o + 1]!, b = j.data[o + 2]!;
      n += 1;
      if (r > 150 && g2 > 150 && b > 150) bright += 1;
      if ((r + g2 + b) / 3 > 40) over40 += 1;
    }
    return { bright, over40, n };
  };
  const caption = box(0.30, 0.70, 0.78, 0.86);
  const auto = box(0.33, 0.42, 0.91, 0.97);
  console.log(file.split('/').slice(-2).join('/'), 'caption', JSON.stringify(caption), 'auto', JSON.stringify(auto));
}
