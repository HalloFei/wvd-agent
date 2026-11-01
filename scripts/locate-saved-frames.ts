#!/usr/bin/env tsx
/** Offline: where is each saved corner frame in the atlas? Uses the 8 label banners at scale 1. */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { findTemplate } from '../src/perception/match.ts';
import { LABEL_ANCHORS, MAP_STRIP } from '../src/perception/worldmap-atlas.ts';

const files = process.argv.slice(2);
for (const file of files) {
  const img = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const hits: { id: string; x: number; y: number; score: number }[] = [];
  for (const anchor of LABEL_ANCHORS) {
    const m = findTemplate(img, MAP_STRIP, anchor.template, { scales: [1], minScore: 0.8 });
    if (m !== null) hits.push({ id: anchor.id, x: anchor.at.x - (m.at.x - MAP_STRIP.x), y: anchor.at.y - m.at.y, score: Number(m.score.toFixed(3)) });
  }
  if (hits.length === 0) { console.log(file, '-> no label matched'); continue; }
  let best: { g: typeof hits } | null = null;
  for (const h of hits) {
    const g = hits.filter((o) => Math.abs(o.x - h.x) <= 6 && Math.abs(o.y - h.y) <= 6);
    if (best === null || g.length > best.g.length) best = { g };
  }
  const group = best!.g;
  const x = Math.round(group.reduce((s, o) => s + o.x, 0) / group.length);
  const y = Math.round(group.reduce((s, o) => s + o.y, 0) / group.length);
  const spread = Math.max(...group.map((o) => Math.max(Math.abs(o.x - x), Math.abs(o.y - y))));
  console.log(file.replace(/.*[\\/]/, ''), '-> offset (' + x + ',' + y + ')  anchors', group.length + '/' + hits.length, 'spread', spread, 'ids', group.map((o) => o.id).join(','));
}
