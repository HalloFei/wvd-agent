#!/usr/bin/env tsx
/**
 * The battle UI at 1920x1080: get into a fight, then capture the command phase — the measurement the
 * battle-opener feature (t-mvy7ucdt-ow08qu) needs, because every template the legacy has is portrait.
 *
 *   ... battle-probe.ts hunt              walk the floor until a battle, then save 6 command frames
 *   ... battle-probe.ts tap <x> <y> [k]   tap a point on the battle screen, save k frames after it
 *
 * Frames land in .tmp/battle-<phase>-<n>.jpg; the JSON line carries the screen each one was named.
 */
import { writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import type { Frame, Observation, Point } from '../src/contracts.ts';
import { automoveToTile, openMap } from '../src/actions/automove.ts';
import { connectEngine, startEngine } from '../src/engine/child.ts';
import { focusGame, sendInput, Win32Capture } from '../src/engine/win32.ts';
import { MapPerceiver, tileOnScreen } from '../src/perception/map.ts';

const TITLE = 'WizardryVariantsDaphne';
const HOLD_MS = 60;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const out = (value: unknown): void => { console.log(JSON.stringify(value)); };
const log = (line: string): void => { console.error(line); };
const command = process.argv[2] ?? 'hunt';

const child = startEngine({ title: TITLE, jpegQuality: 90 });
const client = connectEngine(child, { timeoutMs: 8_000 });
try {
  const source = new Win32Capture(client, {});
  const map = new MapPerceiver();
  const actuator = {
    tap: (at: Point) => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 1 as const }),
    doubleTap: (at: Point) => sendInput(client, { op: 'tap', x: at.x, y: at.y, count: 2 as const }),
    holdKey: (scan: number, holdMs: number) => sendInput(client, { op: 'key', scan, holdMs }),
    drag: (from: Point, to: Point, durationMs: number) =>
      sendInput(client, { op: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs }),
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

  const save = async (frame: Frame, name: string, screen: string): Promise<string> => {
    const image = await frame.toRgba();
    writeFileSync(name, jpeg.encode({ data: image.data, width: image.width, height: image.height }, 92).data);
    return screen;
  };

  const focused = await focusGame(client);
  if (!focused) { out({ ok: false, error: 'focus-refused' }); process.exit(1); }

  if (command === 'tap') {
    const x = Number(process.argv[3]);
    const y = Number(process.argv[4]);
    const count = Number(process.argv[5] ?? 6);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('tap needs x y');
    await sendInput(client, { op: 'tap', x, y, count: 1 });
    const frames: Array<{ path: string; screen: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const shot = await see();
      const path = '.tmp/battle-tap-' + index + '.jpg';
      await save(shot.frame, path, shot.observation.screen);
      frames.push({ path, screen: shot.observation.screen });
      await wait(250);
    }
    out({ ok: true, command: 'tap', at: { x, y }, frames });
  } else {
    // Hunt: open the map, walk to a cell, and look for a battle on the way. Repeat a few times.
    const attempts: Array<{ walkTo: Point | null; screen: string; moved: boolean }> = [];
    let battle = false;
    for (let attempt = 0; attempt < 8 && !battle; attempt += 1) {
      let shot = await see();
      if (shot.observation.screen === 'combat') { battle = true; break; }
      if (shot.observation.screen !== 'dungeonmap') {
        await openMap(actuator, HOLD_MS);
        await wait(900);
        shot = await see();
        if (shot.observation.screen !== 'dungeonmap') { attempts.push({ walkTo: null, screen: shot.observation.screen, moved: false }); continue; }
      }
      const read = shot.observation;
      if (read.screen !== 'dungeonmap') break;
      // Walk far and *avoid* the chest: a chest stops the walk at its prompt, and the point of the hunt
      // is the enemies on the way. Eight cells out in each direction, then six.
      const player = read.map.player;
      const candidates: Point[] = [
        { x: player.x - 8, y: player.y }, { x: player.x + 8, y: player.y },
        { x: player.x, y: player.y + 8 }, { x: player.x, y: player.y - 8 },
        { x: player.x - 6, y: player.y - 2 }, { x: player.x + 6, y: player.y + 2 },
      ];
      let moved = false;
      for (const cell of candidates) {
        const at = tileOnScreen(read.map, cell);
        const walked = await automoveToTile(actuator, at, HOLD_MS, { capture: () => source.capture() });
        if (walked.ok) { moved = true; attempts.push({ walkTo: cell, screen: 'walking', moved }); break; }
      }
      if (!moved) { attempts.push({ walkTo: null, screen: 'no walk', moved }); continue; }
      // The walk takes seconds; look for a battle on the way.
      for (let poll = 0; poll < 40; poll += 1) {
        await wait(1000);
        const now = await see();
        if (now.observation.screen === 'combat') { battle = true; break; }
        // A chest on the way is not the hunt: leave its QTE (free) and keep looking.
        if (now.observation.screen === 'chest-qte') await sendInput(client, { op: 'tap', x: 738, y: 758, count: 1 });
        if (now.observation.screen === 'chest-prompt') await sendInput(client, { op: 'tap', x: 960, y: 980, count: 1 });
      }
    }
    const frames: Array<{ path: string; screen: string }> = [];
    if (battle) {
      for (let index = 0; index < 6; index += 1) {
        const shot = await see();
        const path = '.tmp/battle-cmd-' + index + '.jpg';
        await save(shot.frame, path, shot.observation.screen);
        frames.push({ path, screen: shot.observation.screen });
        await wait(300);
      }
    }
    out({ ok: true, command: 'hunt', battle, attempts, frames });
  }
} finally {
  client.close();
}
