#!/usr/bin/env tsx
/**
 * Run the World itself for one farm cycle (the FFXI 4F task by default).
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/world-run.ts
 *
 * Builds the production composition root (createWvdWorld) with a host stub, starts the console,
 * and prints a state line whenever the World's own status changes. The World keeps its own stall
 * detection (stallStopSeconds) and its session limit; this harness adds a wall-clock stop so a
 * wedged run cannot hold the machine forever.
 */
import { writeFileSync } from 'node:fs';
import { createWvdWorld } from '../src/main.ts';
import { WVD_DEFAULTS } from '../src/config.ts';

const TASK = process.env.WVD_TASK ?? 'tasks/ffxi-4f.json';
const WALL_MS = Number(process.env.WVD_WALL_MS ?? 45 * 60_000);
/**
 * Stop the loop at the first stall (an escalation, i.e. a frame it could not name and would wait on),
 * leaving the game on that frame: the operator's "pause when stall" for a diagnosis run.
 */
const PAUSE_ON_STALL = process.env.WVD_PAUSE_ON_STALL === '1';
const cfg = {
  ...WVD_DEFAULTS,
  enabled: true,
  taskFile: TASK,
  cycles: 1,
  sessionMaxMinutes: 40,
  stallStopSeconds: 120,
};
const world = createWvdWorld({ cfg, timezone: 'Asia/Shanghai' });
const stamp = (): string => new Date().toISOString().slice(11, 19);
const log = (level: string) => (line: string, data?: unknown): void => {
  console.log(stamp() + ' ' + level + ' ' + line + (data === undefined ? '' : ' ' + JSON.stringify(data)));
};
const host = {
  log: { info: log('info'), warn: log('warn'), error: log('error'), debug: (): void => {} },
  // Keep every escalation snapshot: the frame is the only record of what the loop refused to name.
  pushEvent: async (event: { type?: string; blobs?: ReadonlyArray<{ bytes?: Uint8Array; mime?: string }> }) => {
    const blob = event.blobs?.find((entry) => entry.bytes !== undefined && (entry.mime ?? '').startsWith('image/'));
    if (blob?.bytes !== undefined) {
      const ext = (blob.mime ?? 'image/jpeg').split('/')[1] ?? 'jpg';
      const path = '.tmp/escalation-' + stamp().replaceAll(':', '') + '.' + ext;
      try {
        writeFileSync(path, blob.bytes);
        console.log(stamp() + ' SNAPSHOT ' + path);
      } catch {
        // scratch only: a missing .tmp changes nothing about the run
      }
    }
    if (PAUSE_ON_STALL && event.type === 'wvd.stuck') {
      pausedOnStall = true;
      console.log(stamp() + ' PAUSE-ON-STALL (type=' + event.type + '); the loop is stopping at this frame');
    }
    return { cursor: 0 };
  },
  pushDeferred: (): void => {},
};
let closing = false;
/** Set by the host when the loop stops being able to help itself; the main loop ends the run on it. */
let pausedOnStall = false;
async function finish(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(stamp() + ' STOP ' + why);
  try { await world.invoke('wvd-console', 'stop'); } catch { /* already down */ }
  const status = await world.invoke('wvd-console', 'status');
  console.log('FINAL ' + JSON.stringify(status));
}

await world.start(host as never);
console.log(stamp() + ' START running=' + world.isRunning());
if (!world.isRunning()) {
  const started = await world.invoke('wvd-console', 'start');
  console.log(stamp() + ' START-FALLBACK ' + JSON.stringify(started));
  if (!world.isRunning()) { console.log('DONE (the session did not start)'); process.exit(1); }
}
const began = Date.now();
let last = '';
while (Date.now() - began < WALL_MS) {
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  const res = await world.invoke('wvd-console', 'status');
  if (res.ok) {
    const value = res.value as Record<string, unknown>;
    const line = [value.state, value.screen, value.mode, value.detail].filter((part) => part !== undefined && part !== '').join(' | ');
    if (line !== last) { console.log(stamp() + ' STATE ' + line); last = line; }
  }
  if (pausedOnStall) { await finish('paused on stall'); break; }
  if (!world.isRunning()) break;
}
await finish(world.isRunning() ? 'wall clock' : 'session ended');
console.log('DONE');
process.exit(0);
