#!/usr/bin/env node
/**
 * The margins report: every committed frame, every reader's verdict, and the distance of each metric to
 * its band.
 *
 * The rule it serves is the operator's own — *no unmeasured constants*. A bound may only change with a
 * report like this in the commit: which frames sit inside their band, which sit outside it and are still
 * accepted (the band is too tight for that site), and which are vetoed by an anchor (nothing to do with
 * the band).
 *
 *   node scripts/margins.ts [--check] [<frame.jpg> ...]
 *
 * Without arguments it walks `testdata` for the map fixtures the reader can read. `--check` exits 1 when
 * an **accepted** frame's metric sits outside its band by more than `--slack` (default 0): that is the
 * signal that the site's descriptor needs its own band.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { readMapDetailed } from '../src/perception/map.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const explicit = args.filter((arg) => !arg.startsWith('--'));
const slackIndex = args.indexOf('--slack');
const slack = slackIndex >= 0 ? Number(args[slackIndex + 1]) : 0;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith('.jpg')) out.push(path);
  }
}

const frames = explicit.length > 0
  ? explicit
  : (() => {
    const found: string[] = [];
    for (const dir of ['testdata/nav-2026-11-01-maps', 'testdata/nav-1024-0213', 'testdata/screens']) walk(dir, found);
    return found;
  })();

let failures = 0;
console.log('frame'.padEnd(58) + 'verdict'.padEnd(24) + 'confidence  metrics');
for (const file of frames) {
  let decoded;
  try {
    decoded = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true });
  } catch {
    console.log(file.padEnd(58) + 'undecodable');
    continue;
  }
  const image = { data: decoded.data, width: decoded.width, height: decoded.height };
  const parsed = await readMapDetailed({ atMs: 0, width: image.width, height: image.height, toRgba: async () => image });
  const name = file.length > 56 ? '…' + file.slice(-55) : file;
  if (!parsed.ok) {
    console.log(name.padEnd(58) + ('veto:' + parsed.gate).padEnd(24) + '—'.padStart(10));
    continue;
  }
  const metrics = parsed.evidence.metrics.map((metric) => `${metric.name} ${metric.value} penalty ${metric.penalty.toFixed(4)}`).join(', ');
  console.log(name.padEnd(58) + 'ok'.padEnd(24) + parsed.confidence.toFixed(3).padStart(10) + '  ' + metrics);
  for (const metric of parsed.evidence.metrics) {
    if (metric.penalty < 1 - slack) {
      failures += 1;
      console.log('  ^ ' + metric.name + ' is outside its band and the frame is still accepted: re-measure the band for this site');
    }
  }
}

console.log('');
console.log(frames.length + ' frames, ' + failures + ' metric(s) outside their band while accepted');
if (check && failures > 0) process.exit(1);
