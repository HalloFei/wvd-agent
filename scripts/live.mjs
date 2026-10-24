#!/usr/bin/env node
/**
 * The launcher for `scripts/live.ts`. The World is TypeScript and the CLI imports it directly, so
 * it needs tsx; this checkout may not have one, but the sibling Coopanion does (the app loads the
 * World through tsx itself). This wrapper finds either and passes the arguments through unchanged.
 *
 *   node scripts/live.mjs status
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const candidates = [
  new URL('../node_modules/tsx/dist/cli.mjs', here),
  new URL('../../Coopanion/node_modules/tsx/dist/cli.mjs', here),
];
const tsx = candidates.find((candidate) => existsSync(candidate));
if (tsx === undefined) {
  console.error('wvd live: tsx not found. Install it in wvd-agent or keep the Coopanion checkout beside it.');
  process.exit(2);
}
const cli = fileURLToPath(new URL('./live.ts', here));
const child = spawn(process.execPath, [fileURLToPath(tsx), cli, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  console.error('wvd live:', error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
