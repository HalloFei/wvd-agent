import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { EXTENSION_API_VERSIONS, parseExtensionManifest, type ExtensionPackageJson } from 'cortico/extensions/manifest.ts';
import { WVD_CONFIG_GROUP, WVD_DEFAULTS } from '../src/config.ts';
import type { Actuator, Frame, FrameSource, ScreenId } from '../src/contracts.ts';
import { WVD_DEFINITION } from '../src/definition.ts';
import { MAX_CAPTURE_WIDTH, MIN_CAPTURE_WIDTH } from '../src/engine/protocol.ts';
import WVD_DEFAULT from '../src/index.ts';
import { WVD_TOOL_DECLS, WvdWorld } from '../src/world.ts';

const TOOL_NAMES = ['wvd_status', 'wvd_look', 'wvd_act', 'wvd_resume'];

/** The host surface `start()` uses; other members are never called by this stub. */
class RecordingHost {
  readonly events: EventEnvelope[] = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    return full;
  }
}

const callContext = {} as ToolCallContext;

describe('WVD World definition', () => {
  let scratchDir: string;
  beforeEach(() => { scratchDir = mkdtempSync(join(tmpdir(), 'wvd-world-')); });
  afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

  const createWorld = () => WVD_DEFINITION.create(fakeWorldContext(WVD_DEFINITION, { scratchDir, packageDir: process.cwd() }));

  it('is the wvd World', () => {
    expect(WVD_DEFINITION.id).toBe('wvd');
    expect(WVD_DEFINITION.label).not.toBe('');
    expect(createWorld()).toBeInstanceOf(WvdWorld);
  });

  it('exports the definition as the package default', () => {
    expect(WVD_DEFAULT).toBe(WVD_DEFINITION);
  });

  it('declares a manifest the host loader accepts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as ExtensionPackageJson;
    const parsed = parseExtensionManifest(pkg, 'en');
    if (!parsed.ok) throw new Error(parsed.reasons.join('; '));
    expect(parsed.manifest.kind).toBe('world');
    expect(parsed.manifest.api).toBe(EXTENSION_API_VERSIONS.world);
    expect(parsed.warnings).toEqual([]);
  });

  it('passes the host dry mount: create, tools, env prompt vars and config paths', async () => {
    const report = await dryMountWorld(WVD_DEFINITION, { scratchDir, packageDir: process.cwd() });
    expect(report.failures).toEqual([]);
  });

  it('declares the four escalation tools, and gives the same four', () => {
    expect(WVD_TOOL_DECLS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(createWorld().tools().map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it('answers wvd_status in prose, because no session runs at mount', async () => {
    const status = createWorld().tools().find((tool) => tool.name === 'wvd_status')!;
    const result = await status.handler({}, callContext);
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('no session running');
  });

  it('wires the three escalation tools: each refuses, as a value, when there is nothing to answer', async () => {
    const world = createWorld();
    const look = await world.tools().find((candidate) => candidate.name === 'wvd_look')!.handler({}, callContext);
    expect(look).toMatchObject({ text: 'not captured: no session is running', failed: true });

    const act = await world.tools().find((candidate) => candidate.name === 'wvd_act')!.handler({ kind: 'tap', x: 1, y: 1 }, callContext);
    expect(act).toMatchObject({ text: 'not sent: no question is waiting; the loop is running on its own', failed: true });

    const resume = await world.tools().find((candidate) => candidate.name === 'wvd_resume')!.handler({}, callContext);
    expect(resume).toMatchObject({ text: 'not resumed: nothing is waiting for an answer', failed: true });
  });

  it('describes every tool it can give and declares the events it pushes', () => {
    const describe = WVD_DEFINITION.describe!;
    expect(describe.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(describe.events.map((event) => event.type)).toEqual(['wvd.stuck', 'wvd.stopped']);
    expect(describe.events.every((event) => event.trigger === 'flush')).toBe(true);
    expect(describe.events.every((event) => event.tags?.includes('snapshot'))).toBe(true);
  });

  it('mounts and stops without waking the bot', async () => {
    const world = createWorld();
    const host = new RecordingHost();
    await world.start(host as unknown as WorldHost);
    await world.stop();
    expect(host.events).toEqual([]);
  });

  it('declares all forty-three contracts §8 keys with defaults the console can render', () => {
    const properties = WVD_CONFIG_GROUP.schema.properties;
    const prefix = 'worlds.wvd.';
    // The section is flat again (review F2/R12: the numerals-reader strategy is a constructor
    // argument, not a config row until a consumer exists), so every default path is one key.
    const defaultPaths = (value: Record<string, unknown>, at = ''): string[] =>
      Object.entries(value).flatMap(([key, item]) => (
        item !== null && typeof item === 'object'
          ? defaultPaths(item as Record<string, unknown>, `${at}${key}.`)
          : [`${at}${key}`]
      ));
    const defaults = defaultPaths(WVD_DEFAULTS as unknown as Record<string, unknown>);
    expect(Object.keys(properties)).toHaveLength(43);
    expect(defaults).toHaveLength(43);
    for (const path of Object.keys(properties)) {
      expect(path.startsWith(prefix)).toBe(true);
      expect(defaults).toContain(path.slice(prefix.length));
    }
    for (const path of defaults) {
      expect(properties[`${prefix}${path}`]).toBeDefined();
    }
    expect(properties['worlds.wvd.tickMs']).toMatchObject({ type: 'integer', minimum: 50, maximum: 1000 });
    expect(properties['worlds.wvd.jpegQuality']).toMatchObject({ type: 'integer', minimum: 30, maximum: 95 });
    expect(properties['worlds.wvd.pressHoldMs']).toMatchObject({ type: 'integer', minimum: 40, maximum: 500 });
    // `timeQte` refuses a budget below 1 as `misconfigured`; the schema is where a bad setting is
    // caught before the World has to run it.
    expect(properties['worlds.wvd.qteSubLoopMs']).toMatchObject({ type: 'integer', minimum: 1 });
    // The schema is the only place a bad timer setting is named. `planTap` refuses a zero decel by
    // returning no plan at all (it would look like an unreachable zone), a zero latency is finite
    // and silently plans with no lead, and `timeQte` refuses a non-finite or negative window floor
    // only as a bare `misconfigured` — while zero is a legal "no floor". A latency or decel of zero
    // is not a measurement, so both minima stay 1.
    expect(properties['worlds.wvd.qteLatencyMs']).toMatchObject({ type: 'integer', minimum: 1 });
    expect(properties['worlds.wvd.qtePriorCarryTauS']).toMatchObject({ type: 'number', minimum: 0 });
    expect(properties['worlds.wvd.rerollLeadRatio']).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    // The battle sequence's pace: its floor is the pacing primitive's 700 ms, and it is the config's
    // minimum rather than a silent clamp — a value under it is refused where it is written.
    expect(properties['worlds.wvd.battleStepMs']).toMatchObject({ type: 'integer', minimum: 700, maximum: 5000 });
    // the snapshot width is the one value the child refuses outside the wire bounds; the schema is
    // where a bad setting is caught, not a 5 s engine timeout that never names the field
    // 0 is a legitimate "ask on the first frame"; the default is one settle window.
    expect(properties['worlds.wvd.escalateSettleMs']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(properties['worlds.wvd.escalationImageWidth'])
      .toMatchObject({ type: 'integer', minimum: MIN_CAPTURE_WIDTH, maximum: MAX_CAPTURE_WIDTH });
    expect(WVD_DEFAULTS).toMatchObject({
      enabled: false, dryRun: false, tickMs: 100, sessionMaxMinutes: 120, stallStopSeconds: 120,
      gameWindowTitle: 'WizardryVariantsDaphne', jpegQuality: 75, engineTimeoutMs: 5000, pressHoldMs: 60, escalationImageWidth: 1280,
      mapOpenTimeoutMs: 3000, openerPanelTimeoutMs: 10000,
      willpowerFloor: 60, maxRerolls: 5, rerollLeadRatio: 0.5,
      qteLatencyMs: 64, qtePriorCarryTauS: 0.05,
      qteAttemptsFallback: 2, qteSubLoopMs: 4000,
      autoBattleEnableAttempts: 3, fightTimeoutMs: 180000, escalateMaxPerHour: 20, escalateTimeoutMs: 90000, escalateSettleMs: 5000, stopHotkey: 'Ctrl+Alt+W',
      battleStepMs: 1000, battleSettleMs: 1000, battleOpenerTimeoutMs: 10000,
    });
  });

  it('mirrors the frame, source, actuator and screen types from contracts.ts', async () => {
    // The assignments are the assertion: a missing or drifted type fails `pnpm typecheck`. The
    // runtime expectation keeps the file honest about what it asks.
    const source: FrameSource = {
      capture: async (): Promise<Frame> => ({
        atMs: 0, width: 1, height: 1,
        toRgba: async () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
      }),
    };
    const actuator: Actuator = {
      tap: async () => ({ ok: true }),
      doubleTap: async () => ({ ok: true }),
      holdKey: async () => ({ ok: false, reason: 'unavailable', detail: 'not-foreground' }),
      drag: async () => ({ ok: false, reason: 'unavailable', detail: 'not-foreground' }),
    };
    const screens: ScreenId[] = ['town', 'dungeonmap', 'unknown'];
    expect((await source.capture()).width).toBe(1);
    expect(await actuator.holdKey(0x11, 60)).toEqual({ ok: false, reason: 'unavailable', detail: 'not-foreground' });
    expect(screens).toEqual(['town', 'dungeonmap', 'unknown']);
  });
});
