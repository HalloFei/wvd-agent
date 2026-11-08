/**
 * The two events this World pushes, as data (research-escalation-design.md §1, §1.6).
 *
 * Pure: this file builds an envelope's fields and pushes nothing, so the wording the model reads is
 * testable without a host. Two rules from the research are encoded here rather than in the loop:
 *
 * - **The text is the whole message.** `type`, `source`, `ts`, `senderKey`, `tags` and `meta` never
 *   reach the model, so the text names the event, carries the local reading (what perception saw),
 *   states the deadline and the fallback, and ends with one question line.
 * - **`meta` is for the console and the session file**, never for the model, and it is
 *   JSON-serializable only.
 */
import type { BlobInput, EventEnvelope, EventOrigin } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import type { Intent, Observation } from '../contracts.ts';

/** Exactly what `WorldHost.pushEvent` accepts: an envelope minus the fields the host stamps. */
export type WvdEvent = Omit<EventEnvelope, 'cursor' | 'origin' | 'contextDelivery' | 'blobs'> & {
  origin?: EventOrigin;
  blobs?: BlobInput[];
};

/** `[HH:MM:SS]` in the deployment zone. The model has no other clock on the event. */
export function stamp(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(at);
}

/** What the loop does when nobody answers, in the words the event uses. */
export function fallbackPhrase(intent: Intent): string {
  switch (intent.kind) {
    case 'open-map': return 'opens the map';
    case 'move': return 'walks to the tile the map names';
    case 'open-chest': return 'tries the chest it is standing on';
    case 'loot': return 'collects the loot card';
    case 'fight': return 'keeps resolving the battle';
    case 'exit': return 'leaves the dungeon and restarts the route';
    case 'recover': {
      // The stepper's own words: the model is told the control the loop will press, not a category.
      // `done` is not one the loop hands over (the route's fallback is), but say it rather than throw.
      switch (intent.step.kind) {
        case 'exit-page': return 'leaves the ' + intent.step.page + ' page by ' + intent.step.label;
        case 'collapse-party-panel': return 'collapses the party panel to reveal the world map';
        case 'back': return 'presses Esc once';
        case 'done': return 'waits, having no step to press';
      }
    }
    case 'run-script': return 'runs the task script';
    case 'wait': return 'waits and looks again';
    case 'stop': return 'stops the session';
  }
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * One line of everything the loop knows, from contracts §3's `Observation` only — the model's
 * substitute when the endpoint cannot attach the image (research §2.2), so it must be complete:
 * the screen, how sure perception was, and the payload the screen type owns.
 */
export function observationLine(observation: Observation): string {
  const head = `screen ${observation.screen}, confidence ${observation.confidence.toFixed(2)}`;
  switch (observation.screen) {
    case 'dungeonmap': {
      const chests = observation.map.icons.filter((icon) => icon.kind === 'chest').length;
      const hazards = observation.map.icons.filter((icon) => icon.kind === 'hazard').length;
      return `${head}; map ${observation.map.floorTitle}, party at X:${observation.map.player.x} Y:${observation.map.player.y}, `
        + `${plural(chests, 'chest', 'chests')}, ${plural(hazards, 'hazard', 'hazards')}`;
    }
    case 'chest-qte': {
      const { zones, markerX, attempts } = observation.qte;
      return `${head}; ${plural(zones.length, 'zone', 'zones')}, marker at ${Math.round(markerX)}, `
        + `${attempts === null ? 'attempts unreadable' : `${attempts} attempts`}`;
    }
    case 'chest-open': {
      const members = observation.opener.members;
      // A card that draws no heart has no willpower to compare (`NaN`, see `parseOpener`): it is left
      // out of the lowest, and "unreadable" is said when no member's numeral was read.
      let lowest: number | null = null;
      let unread = 0;
      for (const member of members) {
        const willpower = member.willpower;
        // No heart drawn (the main character) and a heart that could not be read are both left out
        // of the lowest: neither is a number the screen showed.
        if (willpower === null || !Number.isFinite(willpower)) {
          unread += 1;
          continue;
        }
        if (lowest === null || willpower < lowest) lowest = willpower;
      }
      const unreadNote = unread > 0 ? `, ${unread} with no willpower shown` : '';
      return `${head}; opener panel with ${plural(members.length, 'member', 'members')}, `
        + `lowest willpower ${lowest === null ? 'unreadable' : lowest}${unreadNote}`;
    }
    default:
      return head;
  }
}

export interface StuckInput {
  readonly timezone: string;
  readonly at: Date;
  /** `performance.now()` of the frame the verdict refused: the loop's one clock (§0.4). */
  readonly atMs: number;
  readonly escalationId: string;
  readonly ticksStuck: number;
  readonly observation: Observation;
  readonly question: string;
  readonly fallbackLine: string;
  readonly timeoutMs: number;
  readonly fallback: Intent;
  readonly escalationsThisHour: number;
  readonly maxPerHour: number;
  readonly image: BlobInput | null;
  /**
   * The same frame, lossless: the ledger's copy of the evidence, beside the JPEG the model reads.
   * Absent when the source has no PNG path — the event then carries the JPEG alone.
   */
  readonly imageLossless?: BlobInput | null;
  /** Whether the active endpoint can attach the image; false is said in words, never silent. */
  readonly imageVisible: boolean;
}

/** `wvd.stuck`: the loop is paused, here is the frame it refused and the one question it asks. */
export function stuckEvent(input: StuckInput): WvdEvent {
  const lines = [
    `[wvd.stuck ${stamp(input.timezone, input.at)}] Loop paused. ${observationLine(input.observation)}; `
      + `${input.ticksStuck} ticks in a row.`,
  ];
  if (input.image === null) {
    // Two different reasons for no image, and the model is told which: the capture failed, or the
    // endpoint cannot show one. Silence would look like the image is there when it is not.
    lines.push('The screenshot for this question could not be captured, so this line is what there is to judge from.');
  } else if (!input.imageVisible) {
    lines.push('The active endpoint cannot show images, so this line is what there is to judge from.');
  }
  lines.push(`Question: ${input.question}`);
  lines.push(`Without an answer in ${Math.round(input.timeoutMs / 1000)} s it ${input.fallbackLine}.`);

  return {
    type: 'wvd.stuck',
    source: 'wvd',
    senderKey: 'wvd.stuck',
    ts: nowIso(input.timezone, input.at),
    tags: ['snapshot'],
    text: lines.join('\n'),
    meta: {
      escalation: {
        id: input.escalationId,
        atMs: input.atMs,
        ticks: input.ticksStuck,
        screen: input.observation.screen,
        confidence: input.observation.confidence,
        question: input.question,
        timeoutMs: input.timeoutMs,
        fallback: input.fallback.kind,
        hour: input.escalationsThisHour,
        hourMax: input.maxPerHour,
        image: input.image === null || !('bytes' in input.image)
          ? null
          : { mime: input.image.mime, bytes: input.image.bytes.length },
      },
    },
    ...(input.image
      ? { blobs: input.imageLossless ? [input.image, input.imageLossless] : [input.image] }
      : {}),
  };
}

export interface StoppedInput {
  readonly timezone: string;
  readonly at: Date;
  readonly atMs: number;
  readonly reason: string;
  readonly observation: Observation | null;
  readonly escalationsThisHour: number;
}

/**
 * `wvd.stopped`: the one report a stopped session leaves. A stop is the operator's business — the
 * stop hotkey, a dead engine or a spent budget all mean "the game is on its own now" — so it is
 * pushed once per session and never again.
 */
export function stoppedEvent(input: StoppedInput): WvdEvent {
  const last = input.observation === null
    ? 'nothing had been observed yet'
    : `last observation ${observationLine(input.observation)}`;
  return {
    type: 'wvd.stopped',
    source: 'wvd',
    senderKey: 'wvd.stopped',
    ts: nowIso(input.timezone, input.at),
    tags: ['snapshot'],
    text: `[wvd.stopped ${stamp(input.timezone, input.at)}] The farming loop stopped: ${input.reason}. `
      + `${last[0]!.toUpperCase()}${last.slice(1)}. Input is off and nothing will be touched until a session starts again.`,
    meta: {
      stopped: {
        reason: input.reason,
        atMs: input.atMs,
        escalationsThisHour: input.escalationsThisHour,
        screen: input.observation?.screen ?? null,
      },
    },
  };
}
