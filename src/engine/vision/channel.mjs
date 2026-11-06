/**
 * The capture child's side of the shared frame channel (contracts §5): it opens the named region the
 * World created and publishes each captured BGRA frame into the newest slot, with the same layout and
 * the same seqlock the World's reader implements in `frame-channel.ts`.
 *
 * This file is plain ESM because the child runs under whichever Node the app or the operator gives it
 * (R9), and it imports nothing from the World's TypeScript. That makes the byte layout a contract
 * twice over: the offsets below are the same numbers as `frame-channel.ts` (which exports them),
 * and `tests/engine-child-snapshot.test.ts` is the place the child's writer and the World's reader
 * meet, so a drift is caught before a live run. The layout is read from the region's own header, not
 * passed on the command line: a child and a World that disagree about the version refuse each other
 * instead of misreading a slot.
 *
 * Copies go through `RtlMoveMemory` (never `koffi.view`): this codebase measured that Electron aborts
 * a process which creates an external buffer (win32-native.mjs, 2026-10-31), and a mapped pointer
 * returned as a Buffer is exactly that. A 1920x1080 frame copies in 2 ms.
 *
 * The timestamps here are `Date.now()` epoch milliseconds, not `performance.now()`: the child and the
 * World are separate processes and do not share a monotonic origin (contracts §0.4).
 */
import koffi from 'koffi';

export const CHANNEL_MAGIC = 0x574f5631; // 'WOV1'
export const CHANNEL_VERSION = 1;
export const HEADER_BYTES = 64;
export const SLOT_META_BYTES = 32;
/** Header field offsets (the layout is the contract; `frame-channel.ts` names the same numbers). */
const HEARTBEAT_MS = 24;
const LATEST_SEQ = 40;

const kernel32 = koffi.load('kernel32.dll');
const OpenFileMappingW = kernel32.func(
  'intptr_t __stdcall OpenFileMappingW(uint32_t access, int32_t inherit, str16 name)',
);
const MapViewOfFile = kernel32.func(
  'intptr_t __stdcall MapViewOfFile(intptr_t handle, uint32_t access, uint32_t high, uint32_t low, intptr_t bytes)',
);
const UnmapViewOfFile = kernel32.func('int32_t __stdcall UnmapViewOfFile(intptr_t address)');
const CloseHandle = kernel32.func('int32_t __stdcall CloseHandle(intptr_t handle)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void *dest, void *src, intptr_t length)');

const FILE_MAP_ALL_ACCESS = 0xf001f;

/** The region as byte access; every read and write is a copy in or out of the mapped view. */
function memoryOverView(view, size) {
  const base = BigInt(view);
  const at = (offset) => base + BigInt(offset);
  const readInto = (offset, length) => {
    const out = Buffer.allocUnsafe(length);
    RtlMoveMemory(out, at(offset), length);
    return out;
  };
  const writeFrom = (offset, bytes) => {
    RtlMoveMemory(at(offset), bytes, bytes.length);
  };
  return {
    size,
    readUInt32LE: (offset) => readInto(offset, 4).readUInt32LE(0),
    writeUInt32LE: (offset, value) => {
      const bytes = Buffer.allocUnsafe(4);
      bytes.writeUInt32LE(value, 0);
      writeFrom(offset, bytes);
    },
    readBigUInt64LE: (offset) => readInto(offset, 8).readBigUInt64LE(0),
    writeBigUInt64LE: (offset, value) => {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeBigUInt64LE(value, 0);
      writeFrom(offset, bytes);
    },
    readDoubleLE: (offset) => readInto(offset, 8).readDoubleLE(0),
    writeDoubleLE: (offset, value) => {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleLE(value, 0);
      writeFrom(offset, bytes);
    },
    read: (offset, length) => readInto(offset, length),
    write: (offset, bytes) => writeFrom(offset, bytes),
    fill: (offset, value, length) => writeFrom(offset, Buffer.alloc(length, value)),
  };
}

/**
 * The layout the region's header declares. A mismatch — another version, a stride that is not
 * `width * 4`, a region of another size — throws: the child must refuse a region it does not speak
 * rather than publish into the wrong offsets.
 */
export function layoutOf(memory, bytes) {
  const magic = memory.readUInt32LE(0);
  if (magic !== CHANNEL_MAGIC) throw new Error(`channel: not a frame channel (magic ${magic})`);
  const version = memory.readUInt32LE(4);
  if (version !== CHANNEL_VERSION) {
    throw new Error(`channel: unsupported version ${version} (this child speaks ${CHANNEL_VERSION})`);
  }
  const slots = memory.readUInt32LE(8);
  const width = memory.readUInt32LE(12);
  const height = memory.readUInt32LE(16);
  const stride = memory.readUInt32LE(20);
  if (slots < 2 || !(width > 0) || !(height > 0) || stride !== width * 4) {
    throw new Error(`channel: bad layout header (${width}x${height}, stride ${stride}, ${slots} slots)`);
  }
  const slotBytes = SLOT_META_BYTES + stride * height;
  const required = HEADER_BYTES + slotBytes * slots;
  if (required !== bytes) {
    throw new Error(`channel: the layout is ${required} bytes, this region is ${bytes}`);
  }
  return { width, height, slots, stride, headerBytes: HEADER_BYTES, slotBytes, bytes: required };
}

/**
 * Publish one frame: stamp the slot with the next sequence, write the payload, then advance the
 * header. The reader reads the sequence before and after its copy and refuses a slot that changed,
 * so a frame a perceiver sees is never torn (see `frame-channel.ts`).
 *
 * Returns the sequence it published; the protocol thread reports it, and the World's reply carries it.
 */
export function publishFrame(memory, layout, bgra, capturedAtMs) {
  const expected = layout.stride * layout.height;
  if (!bgra || bgra.length !== expected) {
    throw new Error(`channel: the frame is ${bgra?.length} bytes, the slot takes ${expected}`);
  }
  if (!Number.isFinite(capturedAtMs)) throw new Error('channel: capturedAtMs must be epoch milliseconds');
  const sequence = memory.readBigUInt64LE(LATEST_SEQ) + 1n;
  const slot = Number(sequence % BigInt(layout.slots));
  const base = layout.headerBytes + slot * layout.slotBytes;
  // Stamp first: a reader that lands after the payload starts sees a sequence that is not the
  // published one and refuses, instead of taking half a frame.
  memory.writeBigUInt64LE(base, sequence);
  memory.writeUInt32LE(base + 8, 1); // state: writing
  memory.writeDoubleLE(base + 16, capturedAtMs);
  memory.writeUInt32LE(base + 24, layout.width);
  memory.writeUInt32LE(base + 28, layout.height);
  memory.write(base + SLOT_META_BYTES, bgra);
  memory.writeUInt32LE(base + 8, 2); // state: complete
  memory.writeBigUInt64LE(LATEST_SEQ, sequence); // publish: the header names the newest slot
  memory.writeDoubleLE(HEARTBEAT_MS, capturedAtMs); // the heartbeat rides the publish clock
  return { seq: Number(sequence), capturedAtMs };
}

/**
 * Open the region the World created, read its layout, and return the writer over it.
 *
 * The region is the World's: the child opens it read-write and throws when it is absent or of another
 * size. `publish` never blocks, and `heartbeat` keeps the supervisor's liveness signal moving while
 * nothing is being captured (the render loop stops on idle demand).
 */
export function openChannel(name, bytes) {
  if (typeof name !== 'string' || name === '') throw new Error('channel: a region name is required');
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error(`channel: "${bytes}" is not a region size`);
  const handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, name);
  if (!handle) throw new Error(`channel: OpenFileMappingW failed (${GetLastError()}) for "${name}"`);
  const view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, bytes);
  if (!view) {
    CloseHandle(handle);
    throw new Error(`channel: MapViewOfFile failed (${GetLastError()}) — "${name}" is not ${bytes} bytes`);
  }
  const memory = memoryOverView(view, bytes);
  let layout;
  try {
    layout = layoutOf(memory, bytes);
  } catch (error) {
    UnmapViewOfFile(view);
    CloseHandle(handle);
    throw error;
  }
  return {
    name,
    bytes,
    layout,
    memory,
    publish(bgra, capturedAtMs) {
      return publishFrame(memory, layout, bgra, capturedAtMs);
    },
    heartbeat(nowMs) {
      memory.writeDoubleLE(HEARTBEAT_MS, nowMs);
    },
    dispose() {
      UnmapViewOfFile(view);
      CloseHandle(handle);
    },
  };
}
