/**
 * Drive the recovery policy against the live game: focus it, read the screen, take the policy's
 * next control, repeat until the route can act. Dry by default; `--apply` presses.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/recover.ts [--apply] [--steps N]
 */
import { execFileSync } from 'node:child_process';
import { recoverStep } from '../src/policy/recover.ts';
import type { Observation } from '../src/contracts.ts';

const TSX = new URL('../../Coopanion/node_modules/tsx/dist/cli.mjs', import.meta.url);
const apply = process.argv.includes('--apply');
const stepsArg = process.argv.indexOf('--steps');
const maxSteps = stepsArg >= 0 ? Number(process.argv[stepsArg + 1]) : 6;

function live(args: string[]): Record<string, unknown> {
  const out = execFileSync(process.execPath, [fileURLToPath(TSX), 'scripts/live.mjs', ...args], { encoding: 'utf8' });
  const line = out.trim().split('\n').filter(Boolean).at(-1) ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}
import { fileURLToPath } from 'node:url';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const focus = live(['focus']);
console.log(JSON.stringify({ focus }));
for (let step = 0; step < maxSteps; step += 1) {
  let status = live(['status']);
  if (status.ok !== true) {
    await sleep(800);
    status = live(['status']);
  }
  if (status.ok !== true) {
    console.log(JSON.stringify({ step, status }));
    break;
  }
  const observation = status as unknown as Observation;
  const next = recoverStep(observation);
  console.log(JSON.stringify({ step, screen: observation.screen, confidence: observation.confidence, next }));
  if (next.kind === 'done') break;
  if (!apply) continue;
  if (next.kind === 'back') live(['key', 'esc']);
  else live(['tap', String(next.at.x), String(next.at.y)]);
  await sleep(900);
}
