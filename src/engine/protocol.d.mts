/**
 * Types of the `.mjs` wire codec (protocol.mjs), so the World's TypeScript sees the same codec the
 * child runs. Kept beside the implementation; the two change together.
 */
import type { EngineReply, EngineRequest } from '../contracts.ts';

/** An unsolicited message from the child; the stop hotkey is the only one (R3). */
export interface EngineEvent {
  readonly kind: 'stopHotkey';
}

/** The value of a `foreground` reply: whether the game window holds the foreground. */
export interface EngineForeground {
  readonly foreground: boolean;
}

/** The value of a `capture` reply: the JPEG as base64, and the device pixels it covers. */
export interface EngineCapture {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
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

export declare function encodeRequest(id: number, request: EngineRequest): string;

export declare function encodeReply(reply: EngineReply): string;

export declare function encodeEvent(event: EngineEvent): string;

export declare function decodeLine(line: string): WireMessage | null;

/** Splits a stream of chunks into whole lines; the leftovers wait for the next chunk. */
export declare class LineDecoder {
  push(chunk: string): string[];
}
