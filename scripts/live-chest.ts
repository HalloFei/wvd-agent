/**
 * Live proof for t-mvmh2fe9-wep8d6 — the opener panel answered at its real latency.
 *
 * The deployed World is mounted exactly as `main.ts` hands it to Coo — the real engine child, the
 * q75 capture, the composite perceiver, the real taps — with a host that only records. It is started
 * on the chest prompt the operator left on screen and ticked at its own `tickMs` until the panel is
 * clicked, then stopped. Nothing here decides anything: the loop under test does.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/live-chest.ts
 *
 * One JSON line per loop log record plus one `tick` heartbeat a second; the timeline is the evidence
 * (press → panel arriving → card clicked, with no give-up and no refused re-tap).
 */
import { createWvdWorld } from '../src/main.ts';
import { WVD_DEFAULTS } from '../src/config.ts';

const MAX_MS = Number(process.env.PROBE_MS ?? 60000);
const t0 = performance.now();
const at = (): string => ((performance.now() - t0) / 1000).toFixed(2);

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const records: Array<{ t: number; level: Level; message: string; data?: unknown }> = [];

const say = (level: Level, message: string, data?: unknown): void => {
  const t = performance.now() - t0;
  records.push({ t, level, message, data });
  const line: Record<string, unknown> = { t: at(), level, message };
  if (data !== undefined) line.data = data;
  console.log(JSON.stringify(line));
};

const log = {
  trace: (m: string, d?: unknown) => say('trace', m, d),
  debug: (m: string, d?: unknown) => say('debug', m, d),
  info: (m: string, d?: unknown) => say('info', m, d),
  warn: (m: string, d?: unknown) => say('warn', m, d),
  error: (m: string, d?: unknown) => say('error', m, d),
  emit: (level: Level, m: string) => say(level, m),
  child: () => log,
};

let cursor = 0;
const host = {
  log,
  modelFacts: { accepts: (mime: string) => mime === 'image/jpeg' },
  async pushEvent(event: Record<string, unknown>) {
    cursor += 1;
    say('info', 'host: event pushed', { type: event.type, cursor });
    return { ...event, cursor, origin: 'external', contextDelivery: 'deliver', blobs: [] };
  },
};

const cfg = { ...structuredClone(WVD_DEFAULTS), enabled: false, taskFile: '' };
const world = createWvdWorld({ cfg, timezone: 'Asia/Shanghai' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

await world.start(host as never);
const started = await world.startSession();
if (!started) {
  say('error', 'probe: the session did not start; nothing was driven');
  process.exit(1);
}

let ticks = 0;
let clickedAt: number | null = null;
let lastHeartbeat = 0;
while (world.isRunning() && performance.now() - t0 < MAX_MS) {
  const tickStart = performance.now();
  await world.tick();
  ticks += 1;
  if (records.some((r) => r.message.includes('opening the chest with'))) {
    clickedAt = performance.now() - t0;
    break;
  }
  const sinceHeartbeat = performance.now() - lastHeartbeat;
  if (sinceHeartbeat >= 1000) {
    lastHeartbeat = performance.now();
    say('debug', 'probe: ticking', { ticks, screenTimeMs: Math.round(performance.now() - t0) });
  }
  const spent = performance.now() - tickStart;
  await sleep(Math.max(0, cfg.tickMs - spent));
}

const running = world.isRunning();
await world.stop();

const warnings = records.filter((r) => r.level === 'warn').map((r) => r.message);
const verdict = {
  ticks,
  clickedAtS: clickedAt === null ? null : Number((clickedAt / 1000).toFixed(2)),
  stillRunningWhenStopped: running,
  gaveUp: warnings.some((m) => m.includes('never answered the click')),
  latched: warnings.some((m) => m.includes('already changed nothing')),
  refused: warnings.some((m) => m.includes('could not open-chest')),
  answered: records.some((r) => r.message.includes('open-chest took effect')),
  clicked: clickedAt !== null,
  warnings,
};
console.log(JSON.stringify({ verdict }));
