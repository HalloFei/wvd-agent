/**
 * The WVD World. This stub mounts, declares the four escalation tools and answers `wvd_status`;
 * Task 10 replaces it with the tick loop and wires the other three tools.
 */
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { WVD_CONFIG_GROUP, WVD_ID, type WvdConfigSection } from './config.ts';

/** Every tool the escalation path needs; only `wvd_status` answers here. */
export const WVD_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wvd_status',
    description: 'Report the WVD farming session: whether one is running, and what it is doing. Takes no arguments.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_look',
    description: 'Capture the game window again and return the current screen as an image.',
    tags: ['read', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'wvd_act',
    description: 'Apply one input action to the game window: tap, double tap, or hold a key.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['tap', 'doubleTap', 'holdKey'], description: 'The action to apply.' },
        x: { type: 'number', description: 'Tap position in device pixels, for tap and doubleTap.' },
        y: { type: 'number', description: 'Tap position in device pixels, for tap and doubleTap.' },
        scan: { type: 'integer', description: 'Keyboard scan code, for holdKey.' },
        holdMs: { type: 'integer', description: 'How long to hold the key in milliseconds, for holdKey.' },
      },
      required: ['op'],
    },
  },
  {
    name: 'wvd_resume',
    description: 'Resume the farming loop after the question is answered, with an optional note for the session log.',
    tags: ['flow'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: 'What was decided, for the session log.' },
      },
    },
  },
];

/** A tool whose implementation arrives in a later task fails with this, as a value. */
const UNAVAILABLE = JSON.stringify({ ok: false, reason: 'unavailable' });

export interface WvdWorldOptions {
  /** Live reference to `worlds.wvd`; later modules get their own typed options from it. */
  cfg: WvdConfigSection;
  /** Deployment timezone; event timestamps use it. */
  timezone: string;
}

export class WvdWorld implements World {
  readonly id = WVD_ID;

  constructor(private readonly opts: WvdWorldOptions) {}

  /** No environment section yet: the loop that would use this World's config does not exist. */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  tools(): ToolDef[] {
    return WVD_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.handlerFor(decl.name) }));
  }

  webUi(): WorldWebUiDecl {
    return { config: [WVD_CONFIG_GROUP] };
  }

  /** Mounting announces nothing: no event may wake the bot before a session starts. */
  async start(_host: WorldHost): Promise<void> {}

  async stop(): Promise<void> {}

  private handlerFor(name: string): ToolDef['handler'] {
    if (name === 'wvd_status') return async () => JSON.stringify({ running: false });
    return async () => UNAVAILABLE;
  }
}
