#!/usr/bin/env tsx
/**
 * The scratch cleaner: what the loops' diagnostics left behind, and for how long.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/clean-tmp.ts [--days N] [--root DIR] [--apply]
 *
 * Every run writes a directory under `.tmp/runs` (a log, a report, the stall frames), and the probes and
 * one-off measurements write loose files beside it. This lists the **stale** units — an entry of the
 * root, file or directory, whose newest byte is older than `--days` (default 3) — with their size and
 * age, and deletes nothing unless `--apply` is passed. The dry run is the default because the operator's
 * rule is to see the list before anything goes (2026-11-08). The full list is always written to
 * `<root>/clean-report-YYYY-MM-DD.txt`; the console gets the summary.
 *
 * Nothing outside the root is ever touched, and a symlink is counted but never followed out of it.
 */
import { lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Unit {
  readonly path: string;
  readonly isDir: boolean;
  readonly bytes: number;
  readonly files: number;
  readonly newestMs: number;
}

function walk(path: string): { bytes: number; files: number; newestMs: number } {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1, newestMs: stat.mtimeMs };
  let bytes = 0;
  let files = 0;
  let newestMs = stat.mtimeMs;
  for (const name of readdirSync(path)) {
    const child = walk(join(path, name));
    bytes += child.bytes;
    files += child.files;
    newestMs = Math.max(newestMs, child.newestMs);
  }
  return { bytes, files, newestMs };
}

const args = process.argv.slice(2);
const readArg = (name: string, fallback: number): number => {
  const at = args.indexOf('--' + name);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  return Number.isFinite(value) ? value : fallback;
};
const days = Math.max(0, readArg('days', 3));
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? (args[rootAt + 1] ?? '.tmp') : '.tmp';
const apply = args.includes('--apply');
const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000;

let units: readonly Unit[];
try {
  units = readdirSync(root).map((name) => {
    const path = join(root, name);
    const stat = lstatSync(path);
    const walked = walk(path);
    return { path, isDir: stat.isDirectory(), ...walked };
  });
} catch {
  console.log('no ' + root + ' directory: nothing to clean');
  process.exit(0);
}

/**
 * Never stale by age: the OCR venv the readers spawn (deleting it stops the OCR tier) and the atlas
 * capture corpus the stored world map was built from. `--keep=a,b` adds to this list; it never
 * subtracts from it.
 */
const KEEP = new Set(['ocr-venv', 'atlas', ...(args.find((arg) => arg.startsWith('--keep='))?.slice(7).split(',') ?? [])]);
const isKept = (unit: Unit): boolean => KEEP.has(unit.path.split(/[\\/]/).pop() ?? '');
const stale = units.filter((unit) => unit.newestMs < cutoff && !isKept(unit)).sort((a, b) => a.newestMs - b.newestMs);
const kept = units.filter((unit) => unit.newestMs < cutoff && isKept(unit));
for (const unit of kept) console.log('  kept (needed): ' + unit.path);
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1) + ' MB';
const when = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const totalBytes = stale.reduce((sum, unit) => sum + unit.bytes, 0);
const totalFiles = stale.reduce((sum, unit) => sum + unit.files, 0);

console.log(root + ': ' + units.length + ' units; ' + stale.length + ' stale (newest byte older than '
  + days + ' days), ' + totalFiles + ' files, ' + mb(totalBytes));

const byDate = new Map<string, { units: number; bytes: number; files: number }>();
for (const unit of stale) {
  const day = when(unit.newestMs);
  const row = byDate.get(day) ?? { units: 0, bytes: 0, files: 0 };
  byDate.set(day, { units: row.units + 1, bytes: row.bytes + unit.bytes, files: row.files + unit.files });
}
for (const [day, row] of [...byDate.entries()].sort()) {
  console.log('  ' + day + '  ' + String(row.units).padStart(4) + ' units  '
    + mb(row.bytes).padStart(9) + '  ' + String(row.files).padStart(5) + ' files');
}

const biggest = [...stale].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
console.log('largest:');
for (const unit of biggest) console.log('  ' + mb(unit.bytes).padStart(9) + '  ' + unit.path);

const lines = stale.map((unit) => when(unit.newestMs) + '  ' + mb(unit.bytes).padStart(9) + '  '
  + String(unit.files).padStart(5) + ' files  ' + (unit.isDir ? 'dir ' : 'file') + '  ' + unit.path);
const reportPath = join(root, 'clean-report-' + new Date().toISOString().slice(0, 10) + '.txt');
writeFileSync(reportPath, lines.join('\n') + '\n');
console.log('full list: ' + reportPath + ' (' + lines.length + ' lines)');

if (!apply) {
  console.log('dry run: nothing deleted. Pass --apply to remove the ' + stale.length + ' units above.');
  process.exit(0);
}
let removed = 0;
for (const unit of stale) {
  try {
    rmSync(unit.path, { recursive: true, force: true });
    removed += 1;
  } catch (error) {
    console.log('  could not remove ' + unit.path + ': ' + (error instanceof Error ? error.message : String(error)));
  }
}
console.log('removed ' + removed + ' of ' + stale.length + ' units on ' + root);
