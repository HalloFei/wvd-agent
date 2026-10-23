/**
 * Types of the `.mjs` wire codec (protocol.mjs), so the World's TypeScript sees the same codec the
 * child runs. Kept beside the implementation; the two change together.
 */
import type { EngineCapture, EngineEvent, EngineReply, EngineRequest } from '../contracts.ts';

export type { EngineCapture, EngineEvent } from '../contracts.ts';

/** The value of a `foreground` reply: whether the game window holds the foreground. */
export interface EngineForeground {
  readonly foreground: boolean;
}

/** A §5 request as it goes on the wire: the correlation id the child must echo. */
export interface WireRequest {
  readonly id: number;
  readonly request: EngineRequest;
}

/** What one line decoded to. */
export type WireMessage =
  | { readonly request: WireRequest }
  | { readonly reply: EngineReply }
  | { readonly event: EngineEvent };

/** Three ticks at the default 100 ms tick: a frame older than this is refused (ruling R11). */
export declare const FRAME_MAX_AGE_MS: number;

export declare function isStaleFrame(ageMs: number): boolean;

export declare function encodeRequest(id: number, request: EngineRequest): string;

export declare function encodeReply(reply: EngineReply): string;

export declare function encodeEvent(event: EngineEvent): string;

export declare function decodeLine(line: string): WireMessage | null;

/** Splits a stream of chunks into whole lines; the leftovers wait for the next chunk. */
export declare class LineDecoder {
  push(chunk: string): string[];
}
