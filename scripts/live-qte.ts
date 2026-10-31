/**
 * Live QTE probe — measurement tool for qteDecelPxPerS2 (card t-mvlez2p5).
 *
 * Modes:
 *   shot   --out=<png/jpg>          one full-frame capture, written to disk
 *   focus                            minimize+restore the game window and take the foreground
 *   key    --scan=0x39 [--hold=60]   one key press through the engine's foreground guard
 *   watch  --seconds=3              sample the QTE window and report what is there (never presses)
 *   qte    --seconds=12 --out=<dir> [--maxpresses=1] [--latency=75] [--decel=3000]
 *                                   sample the bar, plan one press like production, press it, then
 *                                   keep sampling so the brake is recorded
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineDecoder, decodeLine, encodeRequest } from '../src/engine/protocol.mjs';
import { parseQte, qteWindow } from '../src/perception/chest.ts';
import { planTap, qteVelocity } from '../src/policy/qte.ts';
import { chooseOpener } from '../src/policy/chest.ts';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const CHILD = join(ROOT, 'src', 'engine', 'child.mjs');
const TITLE = process.env.WVD_TITLE ?? 'WizardryVariantsDaphne';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] ?? true;
}
const mode = process.argv[2];
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));

// ---------------------------------------------------------------------------------------------
// Engine client (same codec the World uses)

function spawnEngine() {
  const child = spawn(process.execPath, [CHILD, '--title=' + TITLE, '--hotkey='], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const pending = new Map();
  let nextId = 1;
  const decoder = new LineDecoder();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    for (const line of decoder.push(chunk)) {
      const message = decodeLine(line);
      if (!message || !('reply' in message)) continue;
      const resolve = pending.get(message.reply.id);
      if (resolve) { pending.delete(message.reply.id); resolve(message.reply); }
    }
  });
  const request = (request) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (reply) => (reply.ok ? resolve(reply.value) : reject(new Error(reply.error + (reply.detail ? ':' + reply.detail : '')))));
    child.stdin.write(encodeRequest(id, request));
  });
  return { child, request, stderr: () => stderr };
}

function frameFrom(jpegB64, width, height, atMs) {
  const bytes = Buffer.from(jpegB64, 'base64');
  let image = null;
  return {
    atMs, width, height,
    async toRgba() {
      if (image) return image;
      try {
        const { decodeJpeg } = await import('../src/engine/gdiplus.mjs');
        image = decodeJpeg(bytes);
      } catch (error) {
        const jpegjs = (await import('jpeg-js')).default;
        image = jpegjs.decode(bytes, { useTArray: true });
      }
      return image;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Focus: SetForegroundWindow is refused while another app owns the input queue, so minimize first.

async function focusWindow() {
  const win32 = await import('../src/engine/win32-native.mjs');
  const koffi = (await import('koffi')).default;
  const user32 = koffi.load('user32.dll');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t h, int cmd)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t h)');
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t h)');
  const hwnd = win32.findWindow(TITLE);
  if (!hwnd) throw new Error('window-not-found: ' + TITLE);
  ShowWindow(hwnd, 6); // SW_MINIMIZE
  await new Promise((r) => setTimeout(r, 180));
  ShowWindow(hwnd, 9); // SW_RESTORE
  await new Promise((r) => setTimeout(r, 180));
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  await new Promise((r) => setTimeout(r, 120));
  return { hwnd, foreground: win32.isForeground(hwnd) };
}

// ---------------------------------------------------------------------------------------------

const engine = mode === 'focus' ? null : spawnEngine();
const now = () => performance.now();

try {
  if (mode === 'focus') {
    console.log(JSON.stringify(await focusWindow()));
  } else if (mode === 'shot') {
    const out = args.out ?? (ROOT + '/.tmp/live/shot.png');
    const value = await engine.request({ op: 'capture' });
    const { writeJpegAsPng } = { writeJpegAsPng: null };
    writeFileSync(out.replace(/\.png$/, '.jpg'), Buffer.from(value.jpeg, 'base64'));
    console.log(JSON.stringify({ out: out.replace(/\.png$/, '.jpg'), width: value.width, height: value.height, ageMs: value.ageMs }));
  } else if (mode === 'key') {
    const scan = Number(args.scan ?? 0x39);
    const hold = num('hold', 60);
    const value = await engine.request({ op: 'key', scan, holdMs: hold });
    console.log(JSON.stringify({ sent: { scan, hold }, value }));
  } else if (mode === 'watch' || mode === 'qte') {
    const outDir = args.out ?? (ROOT + '/.tmp/live/qte-' + Date.now());
    mkdirSync(outDir, { recursive: true });
    const seconds = num('seconds', 12);
    const maxPresses = num('maxpresses', 1);
    const latencyMs = num('latency', 75);
    const decelPxPerS2 = num('decel', 3000);
    const crop = qteWindow({ width: 1920, height: 1080 });
    const origin = { x: crop.x, y: crop.y };
    const samples = [];
    const presses = [];
    const t0 = now();
    let prev;
    let reading = 0;
    let sawBar = false;
    let pressed = 0;
    let brakeUntil = 0;
    let refusedStreak = 0;

    while (now() - t0 < seconds * 1000) {
      let value;
      try {
        value = await engine.request({ op: 'capture', crop });
      } catch (error) {
        samples.push({ atMs: Math.round(now() - t0), error: String(error.message) });
        refusedStreak += 1;
        if (refusedStreak > 20) break;
        continue;
      }
      const atMs = now() - value.ageMs;
      const frame = frameFrom(value.jpeg, value.width, value.height, atMs);
      let parsed;
      try {
        parsed = await parseQte(frame, prev, origin);
      } catch (error) {
        samples.push({ atMs: Math.round(atMs - t0), threw: String(error.message) });
        continue;
      }
      if (!parsed.ok) {
        refusedStreak += 1;
        samples.push({ atMs: Math.round(atMs - t0), refused: parsed.reason });
        if (pressed > 0 && refusedStreak >= 2) break;
        if (sawBar && refusedStreak >= 8) break;
        continue;
      }
      refusedStreak = 0;
      sawBar = true;
      prev = parsed.qte.markerX;
      reading += 1;
      samples.push({
        t: Math.round(atMs - t0),
        x: parsed.qte.markerX,
        enabled: parsed.enabled,
        confidence: +parsed.confidence.toFixed(2),
        zones: parsed.qte.zones.map((z) => [z.from, z.to]),
      });
      if (brakeUntil > 0 && now() >= brakeUntil) break;

      // One planned press, timed like the production sub-loop.
      if (mode === 'qte' && pressed < maxPresses && parsed.enabled && samples.filter((s) => 'x' in s).length >= 3) {
        const last3 = samples.filter((s) => 'x' in s).slice(-3);
        const v = qteVelocity(
          { atMs: last3[0].t, markerX: last3[0].x },
          { atMs: last3[1].t, markerX: last3[1].x },
          { atMs: last3[2].t, markerX: last3[2].x },
        );
        if (v !== null) {
          const plan = planTap({ markerX: parsed.qte.markerX, v, zones: parsed.qte.zones, latencyMs, decelPxPerS2, horizonMs: 4000 });
          if (plan) {
            const instant = atMs + plan.atMs;
            const left = instant - now();
            if (left >= 150) {
              await new Promise((r) => setTimeout(r, left));
              const pressAt = now();
              let ack;
              try {
                ack = await engine.request({ op: 'key', scan: 0x39, holdMs: num('hold', 60) });
              } catch (error) {
                ack = { error: error.message };
              }
              pressed += 1;
              brakeUntil = now() + num('brakeMs', 1500);
              presses.push({
                v: +v.toFixed(1),
                planAtMs: +plan.atMs.toFixed(1),
                target: plan.target,
                tapX: parsed.qte.markerX,
                readAgeMs: +(now() - 0 - 0).toFixed(0),
                scheduledEarlyByMs: +(pressAt - instant).toFixed(1),
                ack,
              });
            }
          }
        }
      }
    }

    const summary = {
      outDir,
      samples: samples.length,
      presses,
      firstRefusals: samples.filter((s) => s.refused).slice(0, 6),
      x: samples.filter((s) => 'x' in s).map((s) => [s.t, s.x]),
      zones: samples.find((s) => s.zones)?.zones ?? null,
      enabledSeen: samples.some((s) => s.enabled),
    };
    writeFileSync(join(outDir, 'samples.json'), JSON.stringify({ mode, crop, t0Epoch: Date.now(), samples, presses }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
  } else if (mode === 'tap') {
    const point = { x: num('x'), y: num('y') };
    const value = await engine.request({ op: 'tap', x: point.x, y: point.y, count: num('count', 1) });
    console.log(JSON.stringify({ sent: point, value }));
  } else if (mode === 'open') {
    if (args.prompt) {
      const promptAck = await engine.request({ op: 'tap', x: 955, y: 858, count: 1 });
      console.log(JSON.stringify({ promptTap: promptAck }));
      await new Promise((r) => setTimeout(r, num('settle', 700)));
    }
    const outDir = args.out ?? (ROOT + '/.tmp/live/opener');
    mkdirSync(outDir, { recursive: true });
    const opener = await import('../src/perception/opener.ts');
    let panel = null;
    let reason = null;
    for (let attempt = 0; attempt < num('poll', 40); attempt += 1) {
      const value = await engine.request({ op: 'capture' });
      const frame = frameFrom(value.jpeg, value.width, value.height, now() - value.ageMs);
      const detailed = await opener.parseOpenerDetailed(frame);
      writeFileSync(outDir + '/panel-' + attempt + '.jpg', Buffer.from(value.jpeg, 'base64'));
      if (detailed.ok) { panel = detailed.panel; break; }
      reason = detailed.reason;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!panel) {
      console.log(JSON.stringify({ panel: null, reason }));
    } else {
      const choice = chooseOpener(panel, num('floor', 60));
      const point = choice ? opener.openerCardCentre(choice.index) : null;
      let tapAck = null;
      if (choice && point && args.tap) {
        tapAck = await engine.request({ op: 'tap', x: point.x, y: point.y, count: 1 });
      }
      console.log(JSON.stringify({ members: panel.members, choice, point, tapAck }, null, 1));
    }
  } else {
    console.error('usage: <shot|focus|key|tap|open|watch|qte> [--key=value]');
    process.exitCode = 2;
  }
} finally {
  if (engine) {
    engine.child.stdin.end();
    setTimeout(() => engine.child.kill(), 300);
  }
}
