#!/usr/bin/env node
/**
 * The refusal triage: what the ledger filed, and the one command that turns a record into a fixture.
 *
 * The ledger (perception/ledger.ts) files a refusal as a lossless PNG plus its measurements. This is the
 * other half of the loop the corpus was missing: a stall at 03:00 becomes a committed fixture and a test,
 * instead of a memory of a screenshot.
 *
 *   node scripts/triage-refusals.ts --list [<dir>]          the runs' refusals, newest first
 *   node scripts/triage-refusals.ts --promote <record.json> --screen <id> --expect <what it is>
 *
 * `--list` reads every `refusal-*.json` under the directory (default `.tmp/runs`). `--promote` copies the
 * record and its PNG into `testdata/refusals/<stamp>-<gate>/` and prints the test stub that pins it —
 * the expected screen is the operator's (or the lead's) answer to the question the frame asked, and it is
 * never guessed here.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const at = args.indexOf('--' + name);
  return at >= 0 ? args[at + 1] : undefined;
};

interface RefusalRecord {
  readonly at: string;
  readonly screen: string;
  readonly gate: string;
  readonly confidence: number;
  readonly measures: Readonly<Record<string, number>>;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(path, out);
    else if (entry.startsWith('refusal-') && entry.endsWith('.json')) out.push(path);
  }
}

if (args.includes('--list') || args.length === 0) {
  const at = args.indexOf('--list');
  const root = at >= 0 ? args[at + 1] ?? join('.tmp', 'runs') : args[0] ?? join('.tmp', 'runs');
  const files: string[] = [];
  walk(root, files);
  if (files.length === 0) {
    console.log('no refusal records under ' + root + ' (the ledger files them beside the run)');
    process.exit(0);
  }
  const rows = files.map((file) => {
    const record = JSON.parse(readFileSync(file, 'utf8')) as RefusalRecord;
    return { file, record };
  }).sort((a, b) => (a.record.at < b.record.at ? 1 : -1));
  console.log('when                       gate                     screen      confidence  measured');
  for (const { record } of rows) {
    const measures = Object.entries(record.measures).map(([name, number]) => name + '=' + number).join(' ');
    console.log(record.at.padEnd(27) + record.gate.padEnd(25) + record.screen.padEnd(12)
      + String(record.confidence).padEnd(12) + measures);
  }
  console.log('');
  console.log(rows.length + ' refusal(s); promote one with --promote <record.json> --screen <id> --expect <what it is>');
  process.exit(0);
}

const promote = value('promote');
if (promote !== undefined) {
  const record = JSON.parse(readFileSync(promote, 'utf8')) as RefusalRecord;
  const screen = value('screen');
  const expect = value('expect');
  if (screen === undefined || expect === undefined) {
    console.error('--promote needs --screen <id> --expect <what the frame is>');
    process.exit(1);
  }
  const stamp = record.at.replaceAll(':', '-').replaceAll('.', '-');
  const gate = record.gate.replaceAll(/[^a-z0-9-]/gi, '-');
  const dir = join('testdata', 'refusals', stamp + '-' + gate);
  mkdirSync(dir, { recursive: true });
  const png = join(dirname(promote), basename(promote, '.json') + '.png');
  copyFileSync(png, join(dir, 'frame.png'));
  writeFileSync(join(dir, 'record.json'), JSON.stringify({ ...record, expected: screen, expectation: expect }, null, 2) + '\n');
  console.log('promoted to ' + dir + '/ (frame.png + record.json)');
  console.log('');
  console.log('Add the pin to the reader\'s suite:');
  console.log('');
  const quoted = (text: string): string => "'" + text.replaceAll("'", "\\'") + "'";
  for (const line of [
    '  it(' + quoted('reads the ' + expect + ' frame as ' + screen + ' (refusal of ' + record.at + ')') + ', async () => {',
    '    const frame = await pngFrame(' + quoted(join(dir, 'frame.png')) + ');',
    '    expect(await readMapDetailed(frame)).toEqual({ ok: false, gate: ' + quoted(record.gate) + ' });',
    '  });',
  ]) console.log(line);
  process.exit(0);
}

console.error('usage: --list [<dir>] | --promote <record.json> --screen <id> --expect <what it is>');
process.exit(1);
