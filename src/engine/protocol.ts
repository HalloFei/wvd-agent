/**
 * Typed façade over the `.mjs` wire codec (R9: the child runs plain ESM, so the codec itself cannot
 * be TypeScript). The World imports this file and gets the same codec, with types.
 */
export type { EngineRequest, EngineReply } from '../contracts.ts';
export type { EngineCapture, EngineEvent, EngineForeground, WireMessage, WireRequest } from './protocol.mjs';
export { LineDecoder, decodeLine, encodeEvent, encodeReply, encodeRequest } from './protocol.mjs';
