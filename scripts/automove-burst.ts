#!/usr/bin/env tsx
/**
 * Tap a dungeon-map cell and capture the moment right after it — the measurement the pointer-mode
 * walk has never had (t-mvm2kfvh-d9kc0s).
 *
 * The 自动移動 element is the one blind gesture in `automoveToTile`: the tap is aimed 79-84 px above
 * the clicked cell, measured on mid-panel tiles. The operator CLI starts a child per command (~3-4 s),
 * so a popup raised by a tap is gone before any shot exists; this probe connects once, taps, and
 * captures a burst after each tap, printing every input's reply so a swallowed press is visible.
 *
 *   node ../Coopanion/node_modules/tsx/dist/cli.mjs scripts/automove-burst.ts [label]
 *
 * Frames land in .tmp/burst-<label>-<phase>-<n>.jpg — look at them, do not trust the classifier alone.
 */
import { writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import type { Frame, Observation } from '../src/contracts.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { MapPerceiver } from '../src/perception/map.ts';

const TITLE = 'WizardryVariantsDaphne';
const HOLD_MS = 60;
const KEYS: Readonly<Record<string, number>> = { g: 0x22, r: 0x13, f: 0x21 };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const label = process.argv[2] ?? 'run';
const out = (value: unknown): void => { console.log(JSON.stringify(value)); };
const log = (line: string): void => { console.error(line); };

const child = startEngine({ title: TITLE, jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
try {
  const source = new Win32Capture(client, {});
  const map = new MapPerceiver();
  const replies: Array<{ what: string; ok: boolean; reason?: string }> = [];

  const press = async (what: string, op: { op: 'key'; scan: number; holdMs: number } | { op: 'tap'; x: number; y: number; count: 1 }): Promise<boolean> => {
    const reply = await sendInput(client, op);
    replies.push({ what, ok: reply.ok, ...(reply.ok ? {} : { reason: reply.reason }) });
    return reply.ok;
  };

  const see = async (): Promise<{ frame: Frame; observation: Observation }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const frame = await source.capture();
        return { frame, observation: await map.observe(frame) };
      } catch (error) {
        log('capture failed: ' + String(error));
        await wait(200);
      }
    }
    throw new Error('the engine did not answer a capture');
  };

  const focused = await focusGame(client);
  if (!focused) { out({ ok: false, error: 'focus-refused' }); process.exit(1); }

  let current = await see();
  if (current.observation.screen !== 'dungeonmap') {
    log('screen is ' + current.observation.screen + '; opening the map');
    await press('menu', { op: 'key', scan: KEYS.g!, holdMs: HOLD_MS });
    await wait(150);
    await press('map', { op: 'key', scan: KEYS.g!, holdMs: HOLD_MS });
    await wait(900);
    current = await see();
  }
  if (current.observation.screen !== 'dungeonmap') {
    out({ ok: false, error: 'the map did not open', screen: current.observation.screen, replies });
    process.exit(1);
  }
  const read = current.observation;
  if (read.screen !== 'dungeonmap') throw new Error('unreachable');
  const origin = read.map.origin;
  const player = read.map.player;
  const chest = read.map.icons.find((icon) => icon.kind === 'chest');
  const project = (cell: { x: number; y: number }) => ({
    x: Math.round(origin.x + (cell.x - player.x) * 36),
    y: Math.round(origin.y - (cell.y - player.y) * 36),
  });

  const save = async (frame: Frame, name: string): Promise<{ path: string; screen: string }> => {
    const image = await frame.toRgba();
    writeFileSync(name, jpeg.encode({ data: image.data, width: image.width, height: image.height }, 92).data);
    const observation = await map.observe(frame);
    return { path: name, screen: observation.screen };
  };

  const burst = async (phase: string): Promise<Array<{ path: string; screen: string; ms: number }>> => {
    const frames: Array<{ path: string; screen: string; ms: number }> = [];
    const started = Date.now();
    for (let index = 0; index < 6; index += 1) {
      const shot = await see();
      const saved = await save(shot.frame, '.tmp/burst-' + label + '-' + phase + '-' + index + '.jpg');
      frames.push({ ...saved, ms: Date.now() - started });
      await wait(120);
    }
    return frames;
  };

  const phases: Record<string, unknown> = {};

  // Phase 1: pointer mode on, then the walkable neighbour — the control case.
  await press('pointer', { op: 'key', scan: KEYS.r!, holdMs: HOLD_MS });
  await wait(200);
  const neighbour = { x: player.x, y: player.y + 1 };
  const neighbourAt = project(neighbour);
  await press('tap-neighbour', { op: 'tap', x: neighbourAt.x, y: neighbourAt.y, count: 1 });
  phases.neighbour = { cell: neighbour, at: neighbourAt, frames: await burst('n') };

  // Phase 2: the chest cell, from whatever the game is showing now.
  const now = await see();
  if (now.observation.screen === 'dungeonmap' && chest !== undefined) {
    const chestAt = project(chest.at);
    await press('tap-chest', { op: 'tap', x: chestAt.x, y: chestAt.y, count: 1 });
    phases.chest = { cell: chest.at, at: chestAt, frames: await burst('c') };
  } else {
    phases.chest = { skipped: true, screen: now.observation.screen };
  }

  out({ ok: true, label, player, origin, chestCell: chest?.at ?? null, replies, phases });
} finally {
  client.close();
}
