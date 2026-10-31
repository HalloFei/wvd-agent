/**
 * Record a chest QTE through the engine, and take every press in one clock.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/live-record-qte.ts --open --reroll
 *
 * The run is a probe, not the World: it drives the *production* pieces of the QTE path
 * (`bandSampler`, `timeQte`, `chooseQtePass`, the chest actions and `sendInput`) from one
 * process so that every observation and every input lands on one `performance.now()` clock. That
 * is what the measurement needs: the loop's own frames are saved with the frame clock the planner
 * used, and each press is logged at the instant the sub-loop decided to send it.
 *
 * What lands in `.tmp/record/<stamp>/`:
 *
 * - `bar/NNNNN.jpg` — the QTE band (the child's crop, its own encode), one per capture the timing
 *   loop made, so the marker trail and the brake after the press are the frames the loop saw;
 * - `full/NNNNN.jpg` — full frames at each screen transition (prompt, panel, dungeon, loot);
 * - `frames.jsonl` — one line per saved frame: `{kind, n, atMs, ageMs, width, height, crop}`
 *   (`atMs` is the same instant `Frame.atMs` carries: receipt minus the child's frame age);
 * - `readings.jsonl` — one line per accepted bar reading: `{atMs, markerX, zones, enabled}`;
 * - `events.jsonl` — every input: `{kind, detail, atMs, doneMs, ok, inputMs, ...}`, where
 *   `inputMs` is the child's own receipt-to-`SendInput` measurement (contracts §5);
 * - `summary.json` — the run's decisions, in order.
 *
 * The capture path is a proxy over the engine client: it records the reply and returns it
 * unchanged, so the timing loop still runs `Win32Capture`'s stamping, stale-frame refusal and lazy
 * decode. Writing a JPEG on the sampling path costs 1–3 ms and is visible in the *next* frame's
 * clock, never in this one.
 *
 * Flags: `--open` (tap 打开 first), `--reroll` (let the attempt-vs-reroll policy cancel a narrow
 * bar and re-engage), `--budget=<ms>` (the pre-press budget, default `qteSubLoopMs`),
 * `--seconds=<s>` (whole-run cap, default 90), `--out=<dir>`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionResult, Actuator, EngineRequest, Observation, OpenerPanel, Point } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import type { EngineCapture, EngineReply } from '../src/engine/protocol.ts';
import type { EngineRequester } from '../src/engine/win32.ts';
import { bandSampler, timeQte, type QteSampler } from '../src/actions/qte.ts';
import {
  DISARM_SCAN,
  acceptChestPrompt,
  cancelQte,
  reenterChest,
} from '../src/actions/chest.ts';
import { chooseQtePass, type QtePass } from '../src/policy/qte.ts';
import { chooseOpener } from '../src/policy/chest.ts';
import { openerCardCentre, parseOpenerDetailed } from '../src/perception/opener.ts';
import { ChestPerceiver } from '../src/perception/chest.ts';
import { ChestOpeningPerceiver } from '../src/perception/chest-opening.ts';
import { ChestPromptPerceiver } from '../src/perception/prompt.ts';
import { CombatPerceiver } from '../src/perception/combat.ts';
import { CompositePerceiver } from '../src/perception/composite.ts';
import { HudPerceiver } from '../src/perception/hud.ts';
import { TownPerceiver, WorldMapPerceiver } from '../src/perception/location.ts';
import { MapPerceiver } from '../src/perception/map.ts';
import { WVD_DEFAULTS } from '../src/config.ts';

const args: Record<string, string | true> = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (match) args[match[1]!] = match[2] ?? true;
}
const num = (key: string, fallback: number): number =>
  args[key] === undefined ? fallback : Number(args[key]);

const cfg = structuredClone(WVD_DEFAULTS);
const budgetMs = num('budget', cfg.qteSubLoopMs);
const minWindowMs = num('minwindow', cfg.qteMinWindowMs);
const capMs = num('seconds', 90) * 1000;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = String(args.out ?? '.tmp/record/qte-' + stamp);
mkdirSync(join(out, 'bar'), { recursive: true });
mkdirSync(join(out, 'full'), { recursive: true });

const now = (): number => performance.now();
const t0 = now();
/** Milliseconds since the run started, to 0.1 ms: the clock every file in this directory is on. */
const rel = (atMs: number): number => Math.round((atMs - t0) * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const append = (name: string, line: string): void => appendFileSync(join(out, name), line + '\n');

const child = startEngine({ title: cfg.gameWindowTitle, hotkey: '', jpegQuality: cfg.jpegQuality });
const client = connectEngine(child, { timeoutMs: 15_000 });

// --- recording capture ---------------------------------------------------------------------

let barFrames = 0;
let fullFrames = 0;
const recording: EngineRequester = {
  async request(request: EngineRequest): Promise<EngineReply> {
    const reply = await client.request(request);
    if (request.op !== 'capture' || !reply.ok) return reply;
    const value = reply.value as EngineCapture;
    const crop = 'crop' in request ? request.crop : undefined;
    const kind = crop === undefined ? 'full' : 'bar';
    const n = crop === undefined ? ++fullFrames : ++barFrames;
    const atMs = now() - value.ageMs;
    const file = join(out, kind, String(n).padStart(5, '0') + '.jpg');
    writeFileSync(file, Buffer.from(value.jpeg, 'base64'));
    append('frames.jsonl', JSON.stringify({
      kind, n, atMs: rel(atMs), ageMs: Math.round(value.ageMs),
      width: value.width, height: value.height, crop: crop ?? null,
    }));
    return reply;
  },
};
const source = new Win32Capture(recording, {
  onProblem: (event) => append('events.jsonl', JSON.stringify({ kind: 'engineProblem', ...event })),
});

// --- the bar reader, logged ----------------------------------------------------------------

const loggedSampler: QteSampler = {
  sample: async (previousMarkerX?: number) => {
    const asked = now();
    const sample = await bandSampler(source).sample(previousMarkerX);
    const line = sample.ok
      ? {
          n: rel(asked), atMs: rel(sample.reading.atMs),
          markerX: sample.reading.markerX,
          zones: sample.reading.zones.map((zone) => [zone.from, zone.to]),
          enabled: sample.reading.enabled,
        }
      : { n: rel(asked), refused: sample.reason };
    append('readings.jsonl', JSON.stringify(line));
    return sample;
  },
};

// --- inputs, logged at the instant they are sent -------------------------------------------

const actuator: Actuator = {
  tap: (at: Point) => note('tap', at, () => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 1 })),
  doubleTap: (at: Point) => note('doubleTap', at, () => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 2 })),
  holdKey: (scan: number, holdMs: number) => note('key', { scan: '0x' + scan.toString(16), holdMs }, () => sendInput(client, { op: 'key', scan, holdMs })),
  drag: (from: Point, to: Point, durationMs: number) => note('drag', { from, to, durationMs }, () => sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs })),
};

async function note(kind: string, detail: unknown, send: () => Promise<ActionResult>): Promise<ActionResult> {
  const atMs = now();
  const result = await send();
  const doneMs = now();
  append('events.jsonl', JSON.stringify({
    kind, detail, atMs: rel(atMs), doneMs: rel(doneMs), ...result as Record<string, unknown>,
  }));
  return result;
}

// --- what the screen is, for the transitions between bars ----------------------------------

const perceiver = new CompositePerceiver([
  { perceiver: new ChestPerceiver(), floor: 0.5 },
  { perceiver: new MapPerceiver(), floor: 0.5 },
  { perceiver: new ChestPromptPerceiver(), floor: 0.5 },
  { perceiver: new ChestOpeningPerceiver(), floor: 0.5 },
  { perceiver: new CombatPerceiver(), floor: 0.5 },
  { perceiver: new HudPerceiver(), floor: 0.5 },
  { perceiver: new WorldMapPerceiver(), floor: 0.5 },
  { perceiver: new TownPerceiver(), floor: 0.5 },
]);

/**
 * A capture that tolerates one transient engine refusal. The child refuses a frame whose age it
 * cannot vouch for (`stale-frame`), which a transition can produce for a moment; a measurement run
 * must report that and keep watching, not die on it.
 */
async function captureQuietly(): Promise<Frame | null> {
  try {
    return await source.capture();
  } catch (error) {
    append('events.jsonl', JSON.stringify({
      kind: 'capture-refused',
      detail: error instanceof Error ? error.message : String(error),
      atMs: rel(now()),
    }));
    return null;
  }
}

const observe = async (): Promise<Observation | null> => {
  const frame = await captureQuietly();
  return frame === null ? null : perceiver.observe(frame);
};
const seen = (observation: Observation): string =>
  `${observation.screen} (${observation.confidence.toFixed(2)})`;

async function waitForScreen(screen: string, timeoutMs: number, label: string): Promise<boolean> {
  const until = now() + timeoutMs;
  let last = '';
  while (now() < until) {
    const observation = await observe();
    if (observation === null) {
      await sleep(60);
      continue;
    }
    last = seen(observation);
    if (observation.screen === screen) {
      append('events.jsonl', JSON.stringify({ kind: 'screen', label, screen: last, atMs: rel(now()) }));
      return true;
    }
    await sleep(120);
  }
  append('events.jsonl', JSON.stringify({ kind: 'screen-timeout', label, screen: last, atMs: rel(now()) }));
  return false;
}

// --- the run -------------------------------------------------------------------------------

const decisions: unknown[] = [];
const say = (line: string): void => {
  console.log(JSON.stringify(line));
  decisions.push(line);
};

const focused = await focusGame(client);
say(`the game is ${focused ? 'foreground' : 'NOT foreground'} (capture starts)`);
if (!focused) {
  client.close();
  process.exit(1);
}
const opening = await observe();
say(`screen before: ${seen(opening)}`);

/** What the panel wait learned: a readable panel, a drawn-but-unreadable one, or no panel at all. */
type PanelWait =
  | { readonly kind: 'panel'; readonly panel: OpenerPanel }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'timeout'; readonly last: string };

/**
 * Poll until the opener panel is drawn. The parser's own verdict is the signal: `not-panel` means
 * the panel is not up yet, while `unreadable` is a panel whose ranking numerals failed — the panel
 * is there, and (see `openThroughPanel`) it cannot be ranked.
 */
async function waitForPanel(): Promise<PanelWait> {
  const until = now() + cfg.openerPanelTimeoutMs;
  let last = seen(opening);
  while (now() < until) {
    const frame = await captureQuietly();
    if (frame === null) {
      await sleep(60);
      continue;
    }
    const detailed = await parseOpenerDetailed(frame);
    if (detailed.ok) return { kind: 'panel', panel: detailed.panel };
    last = seen(await perceiver.observe(frame));
    if (detailed.reason === 'unreadable') return { kind: 'unreadable' };
    await sleep(120);
  }
  return { kind: 'timeout', last };
}

/**
 * 打开 → the `由谁打开?` panel → one card. The card is `chooseOpener`'s when the panel reads; when
 * the panel is drawn but its ranking numerals are not readable the run refuses to guess, unless
 * `--card=<slot>` names one — a measurement override for the recording, never a production path.
 */
async function openThroughPanel(): Promise<boolean> {
  // A panel that is already drawn (a reroll's re-engage, or a run that started on it) is used as it
  // is: tapping 打开 would land on the panel, not on the chest.
  const first = await captureQuietly();
  if (first === null) {
    say('the first capture was refused; nothing was tapped');
    return false;
  }
  const pre = await parseOpenerDetailed(first);
  let found: PanelWait;
  if (pre.ok) {
    found = { kind: 'panel', panel: pre.panel };
  } else if (pre.reason === 'unreadable') {
    found = { kind: 'unreadable' };
  } else {
    const tapped = await acceptChestPrompt(actuator);
    say(`tapped 打开: ${tapped.ok ? 'accepted' : tapped.reason}`);
    if (!tapped.ok) return false;
    found = await waitForPanel();
  }
  const forced = args.card === undefined ? null : Number(args.card);
  let index: number | null = null;
  if (found.kind === 'panel') {
    say('opener panel: ' + found.panel.members
      .map((member, slot) => `${slot}:${member.name} 解除${member.disarm} 发现${member.detect} 心${Number.isFinite(member.willpower) ? member.willpower : '?'}`)
      .join(' | '));
    const choice = chooseOpener(found.panel, cfg.willpowerFloor);
    if (choice === null) {
      say(`no member holds the ${cfg.willpowerFloor} floor: the panel is left alone`);
      return false;
    }
    index = forced ?? choice.index;
    say(`the policy picks slot ${choice.index}; tapping ${index}`);
  } else if (found.kind === 'unreadable') {
    say('opener panel: drawn, but its 陷阱 numerals are unreadable, so it cannot be ranked');
    if (forced === null) {
      say('refusing to click a card by guess: pass --card=<slot> to force the measurement');
      return false;
    }
    index = forced;
  } else {
    say(`no opener panel within ${cfg.openerPanelTimeoutMs} ms (last: ${found.last})`);
    return false;
  }
  const centre = openerCardCentre(index);
  if (centre === null) {
    say(`slot ${index} has no measured centre`);
    return false;
  }
  const card = await actuator.tap(centre);
  say(`tapped card ${index} at ${centre.x},${centre.y}: ${card.ok ? 'accepted' : card.reason}`);
  return card.ok;
}

if (args.open === true && !(await openThroughPanel())) {
  client.close();
  process.exit(1);
}

let rerolls = 0;
let lastPass: QtePass | null = null;
let presses = 0;
let outcomeLine: string | null = null;

while (now() - t0 < capMs) {
  const outcome = await timeQte({
    sampler: loggedSampler,
    press: async () => {
      const result = await note('press', { key: 'space', holdMs: cfg.pressHoldMs }, () => sendInput(client, { op: 'key', scan: DISARM_SCAN, holdMs: cfg.pressHoldMs }));
      if (result.ok) presses += 1;
      return result;
    },
    now,
    wait: sleep,
    latencyMs: cfg.qteLatencyMs,
    decelPxPerS2: cfg.qteDecelPxPerS2,
    budgetMs,
    choosePass: (pass: QtePass) => {
      lastPass = pass;
      const choice = chooseQtePass(pass, { rerolls, budget: cfg.maxRerolls }, minWindowMs);
      append('events.jsonl', JSON.stringify({
        kind: 'pass', windowMs: Math.round(pass.windowMs), speedPxPerS: Math.round(pass.speedPxPerS),
        rerolls, choice, atMs: rel(now()),
      }));
      return choice;
    },
  });

  if (outcome.ok === true) {
    outcomeLine = `pressed: v=${outcome.v.toFixed(0)} px/s delay=${outcome.atMs.toFixed(0)} ms `
      + `target=${outcome.target} tapX=${outcome.tapX} restX=${outcome.restX ?? 'unread'} `
      + `settled=${outcome.restSettled}`;
    say(outcomeLine);
    const after = await observe();
    say(`screen after the rest read: ${after === null ? 'unreadable' : seen(after)}`);
    break;
  }
  if (outcome.reason === 'reroll' && args.reroll === true && rerolls < cfg.maxRerolls) {
    // The attempt-vs-reroll policy's action, in the order the World sends it: leave the bar, wait for
    // the 3-D view, step one tile off the chest, wait for 打开, and re-open.
    const pass = lastPass;
    const cancelled = await cancelQte(actuator);
    rerolls += 1;
    say(`reroll ${rerolls}/${cfg.maxRerolls}: window ${Math.round(pass?.windowMs ?? 0)} ms at ${Math.round(pass?.speedPxPerS ?? 0)} px/s; cancel ${cancelled.ok ? 'took' : 'failed'}`);
    if (!(await waitForScreen('dungeon', 4000, 'after the cancel'))) break;
    await reenterChest(actuator, cfg.hazardEscapeHoldMs);
    if (!(await waitForScreen('chest-prompt', cfg.openerPanelTimeoutMs, 'after the re-engage'))) break;
    if (!(await openThroughPanel())) break;
    continue;
  }
  if (outcome.reason === 'no-better-pass') {
    say(`gave up: no pass cleared ${minWindowMs} ms in ${rerolls} rerolls`);
    break;
  }
  if (outcome.reason === 'bar-gone') {
    // Ordinary in the first tick of a bar: the game is still drawing it. The World's next tick
    // would try again; this probe waits the same way instead of ending the run.
    await sleep(80);
    continue;
  }
  say(`stopped: ${outcome.reason}`);
  break;
}

const summary = {
  out,
  presses,
  rerolls,
  outcome: outcomeLine,
  frames: { bar: barFrames, full: fullFrames },
  seconds: rel(now()) / 1000,
  decisions,
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ out, presses, rerolls, barFrames, fullFrames, seconds: summary.seconds }));
client.close();
