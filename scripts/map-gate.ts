#!/usr/bin/env tsx
/** readMapDetailed on saved frames: which gate refuses them? */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { readMapDetailed } from '../src/perception/map.ts';

for (const file of process.argv.slice(2)) {
  const j = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const image = { data: j.data, width: j.width, height: j.height };
  const frame = { atMs: 0, width: j.width, height: j.height, toRgba: async () => image };
  const result = await readMapDetailed(frame as never);
  console.log(file.replace(/.*[\\/]/, ''), JSON.stringify(result.ok ? { ok: true, titleKey: result.map.titleKey, player: result.map.player } : { ok: false, gate: result.gate }));
}
