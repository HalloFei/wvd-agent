#!/usr/bin/env tsx
/**
 * Run the World itself for one farm run (the FFXI 4F task by default).
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/world-run.ts
 *
 * Builds the production composition root (createWvdWorld) with a host stub, starts the console, and
 * prints a state line whenever the World's own status changes. The World keeps its own stall
 * detection and session limit; this harness owns what the World does not: the wall-clock bound, the
 * **report** a morning reader picks up, and the **exit code** that says whether the run finished its
 * cycles or stopped on a condition.
 *
 * Environment:
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | WVD_TASK | tasks/ffxi-4f.json | the task file |
 * | WVD_CYCLES | 1 | enter -> farm -> leave cycles |
 * | WVD_WALL_MS | 45 min | wall-clock bound; the harness's own stop |
 * | WVD_SESSION_MINUTES | 40 | the World's session limit; 0 = none |
 * | WVD_STALL_SECONDS | 120 | no-progress stop |
 * | WVD_ESCALATE_TIMEOUT_MS | 20000 | how long an unanswered question waits |
 * | WVD_SETTLE_MS | 5000 | how long a blank/unnamed frame is held before it stops or asks |
 * | WVD_ESCALATE_MAX | 20 | the hourly question budget |
 * | WVD_REPORT_DIR | .tmp/runs/<stamp> | report and frames of one run |
 * | WVD_PAUSE_ON_STALL | off | stop at the first unnamed frame instead of waiting for the stop |
 * | WVD_STOP_ON_OPENER_MISS | off | stop at a battle whose opener was given up |
 *
 * The stop conditions an unattended run has to leave a record of: a **death** - the main character's
 * scene or a party member's revive QTE, which the World stops on with stopOnDeath; a **stall** - the
 * World stops on stallStopSeconds; a **lost process** - the engine's failure stops the session and a
 * harness that dies leaves a non-zero exit code. report.json says which one it was.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createWvdWorld } from '../src/main.ts';
import { WVD_DEFAULTS } from '../src/config.ts';

const TASK = process.env.WVD_TASK ?? 'tasks/ffxi-4f.json';
const CYCLES = Math.max(1, Number(process.env.WVD_CYCLES ?? 1));
const WALL_MS = Number(process.env.WVD_WALL_MS ?? 45 * 60_000);
const SESSION_MINUTES = Math.max(0, Number(process.env.WVD_SESSION_MINUTES ?? 40));
const STALL_SECONDS = Math.max(1, Number(process.env.WVD_STALL_SECONDS ?? 120));
const ESCALATE_TIMEOUT_MS = Math.max(1, Number(process.env.WVD_ESCALATE_TIMEOUT_MS ?? 20_000));
/** How long a blank or unnamed frame is held before it is the question's (and before the blank stop). */
const SETTLE_MS = Math.max(0, Number(process.env.WVD_SETTLE_MS ?? WVD_DEFAULTS.escalateSettleMs));
/** The hourly question budget; an unattended run has nobody to answer, so it is only a backstop. */
const ESCALATE_MAX = Math.max(1, Number(process.env.WVD_ESCALATE_MAX ?? WVD_DEFAULTS.escalateMaxPerHour));
const PAUSE_ON_STALL = process.env.WVD_PAUSE_ON_STALL === '1';
/**
 * The escalation snapshot width. 1920 by default: a stall frame must be the bytes the readers
 * actually refused, at the size they refused them (operator, 2026-11-08). The 1280 default was
 * unreadable evidence: run 26 stalled on a map the downscaled snapshot showed plainly while the
 * raw frame's readers refused it, and no saved frame could reproduce the refusal.
 */
const ESCALATION_IMAGE_WIDTH = Math.max(320, Number(process.env.WVD_ESCALATION_IMAGE_WIDTH ?? 1_920));
const STOP_ON_OPENER_MISS = process.env.WVD_STOP_ON_OPENER_MISS === '1';
/** One directory per run, so two runs never overwrite each other's record. */
const startedAt = new Date();
const fileStamp = (date: Date): string => date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
const REPORT_DIR = process.env.WVD_REPORT_DIR ?? join('.tmp', 'runs', fileStamp(startedAt));
const REPORT_PATH = join(REPORT_DIR, 'report.json');

/**
 * The numerals OCR tier, wired before the World is built (`main.ts` reads the environment when it
 * constructs the readers).
 *
 * The opener's 陷阱 atlas is recorded for **both** codecs now (`perception/opener.ts`: the 2026-10-24
 * JPEG-era means plus the 2026-11-08 raw-era instances), so this tier answers the live panel on its
 * own — live 12:56, `12 fields on the template tier, 0 escalated`, 4.5 ms median. The OCR tier is the
 * **net** for a glyph the atlas has never seen: a run without it refuses the panel outright (live
 * 12:40: `template 0, ocr 0`, and the loop sat on 由谁打开 for seven minutes).
 *
 * The operator's allowance for that page is 4 s (`ChestPerceiver.OCR_WINDOW_MS` bounds how late a
 * second escalation may start), so a single call is bounded here too: past 3 s the page must decide,
 * not wait.
 */
const OCR_PYTHON = process.env.WVD_OCR_PYTHON ?? resolve('.tmp', 'ocr-venv', 'Scripts', 'python.exe');
const OCR_SCRIPT = process.env.WVD_OCR_SCRIPT ?? resolve('scripts', 'ocr-readout.py');
const ocrWired = existsSync(OCR_PYTHON) && existsSync(OCR_SCRIPT);
if (ocrWired) {
  process.env.WVD_OCR_PYTHON = OCR_PYTHON;
  process.env.WVD_OCR_SCRIPT = OCR_SCRIPT;
  // The 4 s allowance for 由谁打开: one call that outlived 3 s would spend it before the card is pressed.
  process.env.WVD_OCR_TIMEOUT_MS ??= '3000';
}

const cfg = {
  ...WVD_DEFAULTS,
  enabled: true,
  taskFile: TASK,
  cycles: CYCLES,
  sessionMaxMinutes: SESSION_MINUTES,
  stallStopSeconds: STALL_SECONDS,
  // A death is a stop, not a question: this harness runs unattended, and a question nobody answers
  // only holds the loop until it times out.
  stopOnDeath: true,
  escalateTimeoutMs: ESCALATE_TIMEOUT_MS,
  escalateSettleMs: SETTLE_MS,
  escalateMaxPerHour: ESCALATE_MAX,
  escalationImageWidth: ESCALATION_IMAGE_WIDTH,
};
const world = createWvdWorld({ cfg, timezone: 'Asia/Shanghai' });
// Said at start, not discovered at the first chest: the tier's absence is a stall, not a slow read.
console.log(ocrWired
  ? 'OCR tier: ' + OCR_PYTHON + ' + ' + OCR_SCRIPT
  : 'OCR tier: ABSENT (' + OCR_PYTHON + ') — a chest panel the JPEG-era atlas refuses will stall');
/** Local time of day: the morning reader's clock, not UTC. */
const stamp = (): string => new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Shanghai' });
/**
 * The run's own console trail, beside its report (`.tmp/runs/<stamp>/console.log`).
 *
 * 2026-11-08: two stalls cost their diagnosis because the only copy of the trail was the harness's
 * stdout, and a `job_output` read consumes it. A run's evidence has to outlive the reader.
 */
const CONSOLE_PATH = join(REPORT_DIR, 'console.log');
mkdirSync(REPORT_DIR, { recursive: true });
const trail = (line: string): void => {
  try {
    appendFileSync(CONSOLE_PATH, line + '\n');
  } catch {
    // the console is the primary channel; a failed log file must not stop the run
  }
};
/**
 * Every line this harness prints, filed beside the report: the STATE ticks, the events, the script's own
 * log. Patching `console.log` once is what makes the file complete — the keyed `log()` below only sees
 * the World's messages.
 */
const print = console.log.bind(console);
console.log = (line: unknown, ...rest: unknown[]): void => {
  print(line, ...rest);
  trail([line, ...rest].map((value) => (typeof value === 'string' ? value : String(value))).join(' '));
};
const log = (level: string) => (line: string, data?: unknown): void => {
  console.log(stamp() + ' ' + level + ' ' + line + (data === undefined ? '' : ' ' + JSON.stringify(data)));
  if (STOP_ON_OPENER_MISS && line.includes('the opener was given up')) {
    pausedOnStall = true;
    console.log(stamp() + ' PAUSE-ON-OPENER-MISS; the loop is stopping at this battle');
  }
};

/** Every frame the loop pushed, and every event's text: the report is the morning's evidence. */
const frames: string[] = [];
const events: Array<{ readonly at: string; readonly type: string; readonly text: string }> = [];
let frameCount = 0;

const host = {
  log: { info: log('info'), warn: log('warn'), error: log('error'), debug: (): void => {} },
  // Keep every escalation frame: it is the only record of what the loop refused to name.
  pushEvent: async (event: { type?: string; text?: string; blobs?: ReadonlyArray<{ bytes?: Uint8Array; mime?: string }> }) => {
    const type = event.type ?? 'wvd.event';
    events.push({ at: new Date().toISOString(), type, text: event.text ?? '' });
    if (type === 'wvd.note' || type === 'wvd.stuck') console.log(stamp() + ' EVENT ' + type + ' ' + (event.text ?? ''));
    // Every image the event carries: the JPEG the model reads **and** the lossless PNG the ledger keeps
    // (a q75 re-encode hid the ink column that split a digit — 2026-11-08).
    const images = (event.blobs ?? []).filter((entry) => entry.bytes !== undefined && (entry.mime ?? '').startsWith('image/'));
    if (images.length > 0) {
      frameCount += 1;
      for (const blob of images) {
        const ext = (blob.mime ?? 'image/jpeg').split('/')[1] ?? 'jpg';
        const path = join(REPORT_DIR, 'frames', String(frameCount).padStart(3, '0') + '-' + type.replaceAll('.', '-') + '.' + ext);
        try {
          mkdirSync(join(REPORT_DIR, 'frames'), { recursive: true });
          writeFileSync(path, blob.bytes);
          frames.push(path);
          console.log(stamp() + ' SNAPSHOT ' + path);
        } catch {
          // scratch only: a missing directory changes nothing about the run
        }
      }
    }
    if (PAUSE_ON_STALL && type === 'wvd.stuck') {
      pausedOnStall = true;
      console.log(stamp() + ' PAUSE-ON-STALL (type=' + type + '); the loop is stopping at this frame');
    }
    return { cursor: 0 };
  },
  pushDeferred: (): void => {},
};
let closing = false;
/** Set by the host when the loop stops being able to help itself; the main loop ends the run on it. */
let pausedOnStall = false;

/**
 * Close the session and write the run's report. The exit code is the one fact the caller needs:
 * 0 the cycles finished, 2 a stop condition ended the run, 1 the session never started.
 */
async function finish(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(stamp() + ' STOP ' + why);
  const statusNow = async (): Promise<Record<string, unknown> | null> => {
    try {
      const res = await world.invoke('wvd-console', 'status');
      return res.ok && typeof res.value === 'object' && res.value !== null
        ? res.value as Record<string, unknown>
        : null;
    } catch { return null; }
  };
  // Read the World's own ending **before** asking the console to stop: a session that ended itself
  // says why in `detail` (`task-complete: 1 of 1 cycles`, the stall, the death), and the console's own
  // stop overwrites that with "the session was stopped" — which is exactly the word this report is
  // supposed to be able to tell apart (live 2026-11-06 02:39: the World finished the cycle and the
  // harness reported exit 2 and completed=false).
  const ended = await statusNow();
  try { await world.invoke('wvd-console', 'stop'); } catch { /* already down */ }
  const stopped = await statusNow();
  const final = stopped ?? ended;
  const detail = typeof ended?.detail === 'string'
    ? ended.detail
    : typeof final?.detail === 'string' ? final.detail : null;
  // The World's own words for a finished farm: task-complete: N of M cycles.
  const completed = detail !== null && detail.startsWith('task-complete');
  const exitCode = completed ? 0 : 2;
  const endedAt = new Date();
  const report = {
    task: TASK,
    cycles: CYCLES,
    stopOnDeath: true,
    wallMs: WALL_MS,
    sessionMinutes: SESSION_MINUTES,
    stallSeconds: STALL_SECONDS,
    escalateTimeoutMs: ESCALATE_TIMEOUT_MS,
    settleMs: SETTLE_MS,
    escalateMaxPerHour: ESCALATE_MAX,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    why,
    exitCode,
    completed,
    stopReason: detail,
    status: final,
    frames,
    events,
  };
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch (error) {
    console.log(stamp() + ' REPORT-FAILED ' + String(error));
  }
  console.log('FINAL ' + JSON.stringify(final));
  console.log('REPORT ' + REPORT_PATH);
  console.log('DONE exit=' + exitCode + ' completed=' + completed + ' reason=' + (detail ?? why));
  // The words above are the record; give the pipe a moment, then the exit code settles the run.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  process.exit(exitCode);
}

await world.start(host as never);
console.log(stamp() + ' START running=' + world.isRunning() + ' task=' + TASK + ' cycles=' + CYCLES + ' report=' + REPORT_PATH);
if (!world.isRunning()) {
  const started = await world.invoke('wvd-console', 'start');
  console.log(stamp() + ' START-FALLBACK ' + JSON.stringify(started));
  if (!world.isRunning()) {
    console.log('DONE (the session did not start)');
    process.exit(1);
  }
}
const began = Date.now();
let last = '';
let polls = 0;
while (Date.now() - began < WALL_MS) {
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  polls += 1;
  const res = await world.invoke('wvd-console', 'status');
  if (res.ok) {
    const value = res.value as Record<string, unknown>;
    const line = [value.state, value.screen, value.mode, value.detail].filter((part) => part !== undefined && part !== '').join(' | ');
    if (line !== last) { console.log(stamp() + ' STATE ' + line); last = line; }
    // Nothing changes for ten minutes on a healthy farm between cycles: one line says it is alive.
    if (polls % 60 === 0) console.log(stamp() + ' ALIVE ' + line);
  }
  if (pausedOnStall) { await finish('paused on stall'); break; }
  if (!world.isRunning()) break;
}
await finish(world.isRunning() ? 'wall clock' : 'session ended');