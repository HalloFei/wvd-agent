/**
 * Typed façade over the `.mjs` wire codec (R9: the child runs plain ESM, so the codec itself cannot
 * be TypeScript). The World imports this file and gets the same codec, with types.
 */
export type { EngineCapture, EngineEvent, EngineRequest, EngineReply } from '../contracts.ts';
export type { EngineForeground, EngineInputAck, WireMessage, WireRequest } from './protocol.mjs';
export {
  FRAME_MAX_AGE_MS,
  LineDecoder,
  decodeLine,
  encodeEvent,
  encodeReply,
  encodeRequest,
  isStaleFrame,
} from './protocol.mjs';
