/**
 * The wire codec of the engine protocol (contracts §5), plain ESM because the child runs under
 * whichever Node the app or the operator gives it, not under the World's TypeScript loader (R9).
 *
 * One JSON object per line: a message never needs a length prefix, and a partial read is just an
 * unfinished line. There are three shapes on the wire:
 *
 *   parent → child  { id, request }                     a §5 request plus the id its reply echoes
 *   child → parent  { id, ok: true, value }             a §5 reply, exactly
 *   child → parent  { id, ok: false, error, detail? }   a §5 failure, exactly
 *   child → parent  { event }                           unsolicited, e.g. the stop hotkey (R3)
 *
 * A malformed line decodes to `null` and the caller drops it; garbage never becomes a request.
 */

import { MAX_DRAG_MS } from './gestures.mjs';

export { MAX_DRAG_MS };

const OPS = new Set(['capture', 'foreground', 'focus', 'tap', 'key', 'drag']);
const FAILURES = new Set(['unavailable', 'rejected', 'timeout']);

/**
 * Three ticks at the default 100 ms tick (contracts §0.5/§0.7). The child refuses to serve a frame
 * older than this: a stale frame that looks fresh is how a QTE tap lands in the hazard gap (R11).
 */
export const FRAME_MAX_AGE_MS = 300;

/**
 * The bounds on the World-side snapshot downscale, in device pixels (contracts §5, `maxWidth` on the
 * escalation snapshot). Below the floor a snapshot is too small to read; above the ceiling the number
 * is a client bug, not a request for a huge image. A value outside these is a refused request, not
 * something to clamp: guessing would hide the bug. The wire no longer carries the field — the World
 * scales the frame it already holds — but the bounds are the same fact and one copy of them.
 */
export const MIN_CAPTURE_WIDTH = 64;
export const MAX_CAPTURE_WIDTH = 16384;

const isObject = (value) => typeof value === 'object' && value !== null;
const isInteger = (value) => typeof value === 'number' && Number.isInteger(value);

/** Whether a frame's age makes it too old to serve. `ageMs` is a duration on the child's clock. */
export function isStaleFrame(ageMs) {
  return !Number.isFinite(ageMs) || ageMs > FRAME_MAX_AGE_MS;
}

export function encodeRequest(id, request) {
  return `${JSON.stringify({ id, request })}\n`;
}

export function encodeReply(reply) {
  return `${JSON.stringify(reply)}\n`;
}

export function encodeEvent(event) {
  return `${JSON.stringify({ event })}\n`;
}

/**
 * One line to one typed message, or `null` when it is not a well-formed message. Extra fields are
 * dropped: what comes back is exactly contracts §5, so a caller never sees a shape the spec lacks.
 */
export function decodeLine(line) {
  const text = typeof line === 'string' ? line.trim() : '';
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if ('event' in value) {
    const event = decodeEvent(value.event);
    return event ? { event } : null;
  }
  if ('request' in value) {
    if (!isInteger(value.id)) return null;
    const request = decodeRequest(value.request);
    return request ? { request: { id: value.id, request } } : null;
  }
  const reply = decodeReply(value);
  return reply ? { reply } : null;
}

function decodeRequest(request) {
  if (!isObject(request) || typeof request.op !== 'string' || !OPS.has(request.op)) return null;
  switch (request.op) {
    case 'capture':
      // The reply is metadata and the pixels travel on the channel, so the request is its op alone.
      // The JPEG era's `maxWidth`/`crop` are dropped like any other field the contract does not
      // declare: a stale caller must not be able to make the child do work nobody promises.
      return { op: 'capture' };
    case 'foreground':
      return { op: 'foreground' };
    case 'focus':
      return { op: 'focus' };
    case 'tap':
      if (typeof request.x !== 'number' || !Number.isFinite(request.x)) return null;
      if (typeof request.y !== 'number' || !Number.isFinite(request.y)) return null;
      if (request.count !== 1 && request.count !== 2) return null;
      return { op: 'tap', x: request.x, y: request.y, count: request.count };
    case 'key':
      if (!isInteger(request.scan) || request.scan < 0 || request.scan > 0xffff) return null;
      if (typeof request.holdMs !== 'number' || !Number.isFinite(request.holdMs) || request.holdMs < 0) return null;
      return { op: 'key', scan: request.scan, holdMs: request.holdMs };
    case 'drag': {
      for (const value of [request.x1, request.y1, request.x2, request.y2]) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      }
      if (typeof request.durationMs !== 'number' || !Number.isFinite(request.durationMs)) return null;
      // a zero-length drag is a click wearing a drag's name, and above the ceiling the child's
      // teardown could kill the process with the button still down (contracts §4)
      if (request.durationMs <= 0 || request.durationMs > MAX_DRAG_MS) return null;
      return {
        op: 'drag',
        x1: request.x1,
        y1: request.y1,
        x2: request.x2,
        y2: request.y2,
        durationMs: request.durationMs,
      };
    }
    default:
      return null;
  }
}

function decodeReply(reply) {
  if (!isObject(reply) || !isInteger(reply.id)) return null;
  if (reply.ok === true) return { id: reply.id, ok: true, value: reply.value === undefined ? null : reply.value };
  if (reply.ok === false && FAILURES.has(reply.error)) {
    return typeof reply.detail === 'string'
      ? { id: reply.id, ok: false, error: reply.error, detail: reply.detail }
      : { id: reply.id, ok: false, error: reply.error };
  }
  return null;
}

function decodeEvent(event) {
  if (!isObject(event)) return null;
  if (event.kind === 'stopHotkey') return { kind: 'stopHotkey' };
  if (event.kind === 'engineProblem' && typeof event.detail === 'string') {
    return { kind: 'engineProblem', detail: event.detail };
  }
  return null;
}

/** Splits a stream of chunks into whole lines; the leftovers wait for the next chunk. */
export class LineDecoder {
  #pending = '';

  push(chunk) {
    this.#pending += chunk;
    const lines = [];
    for (;;) {
      const end = this.#pending.indexOf('\n');
      if (end < 0) break;
      const line = this.#pending.slice(0, end);
      this.#pending = this.#pending.slice(end + 1);
      if (line.trim()) lines.push(line);
    }
    return lines;
  }
}
