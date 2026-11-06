/**
 * The channel's Win32 file mapping: the region the capture child writes and the World reads.
 *
 * Copies go through `RtlMoveMemory` (never `koffi.view`): this codebase measured that Electron aborts
 * a process which creates an external buffer (win32-native.mjs, 2026-10-31), and a mapped pointer
 * returned as a Buffer is exactly that. A 1920x1080 frame copies in 2 ms, once per direction.
 *
 * The name is per-session (the caller decides it) and the size is the channel's own layout: an
 * existing region of another size is refused at `MapViewOfFile`, which is what a version-owned layout
 * change must do.
 */
import koffi from 'koffi';
import type { ChannelMemory } from './channel-memory.ts';

const kernel32 = koffi.load('kernel32.dll');
const CreateFileMappingW = kernel32.func(
  'intptr_t __stdcall CreateFileMappingW(intptr_t hFile, void *attributes, uint32_t protect, uint32_t high, uint32_t low, str16 name)',
);
const MapViewOfFile = kernel32.func(
  'intptr_t __stdcall MapViewOfFile(intptr_t handle, uint32_t access, uint32_t high, uint32_t low, intptr_t bytes)',
);
const UnmapViewOfFile = kernel32.func('int32_t __stdcall UnmapViewOfFile(intptr_t address)');
const CloseHandle = kernel32.func('int32_t __stdcall CloseHandle(intptr_t handle)');
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void *dest, void *src, intptr_t length)');

const INVALID_HANDLE_VALUE = -1n;
const PAGE_READWRITE = 0x04;
const FILE_MAP_ALL_ACCESS = 0xf001f;

export interface ChannelMapping {
  /** The mapping's name, for the second handle. */
  readonly name: string;
  readonly memory: ChannelMemory;
  dispose(): void;
}

/** Open (creating if absent) the named region. Throws when the region cannot be mapped at `size`. */
export function openMapping(name: string, size: number): ChannelMapping {
  const handle = CreateFileMappingW(INVALID_HANDLE_VALUE, null, PAGE_READWRITE, 0, size, name);
  if (!handle) throw new Error(`channel-mapping: CreateFileMappingW failed (${GetLastError()})`);
  const view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, size);
  if (!view) {
    CloseHandle(handle);
    throw new Error(`channel-mapping: MapViewOfFile failed (${GetLastError()}) — the region is not ${size} bytes`);
  }
  return {
    name,
    memory: mappingMemory(view, size),
    dispose() {
      UnmapViewOfFile(view);
      CloseHandle(handle);
    },
  };
}

/** The region as ChannelMemory: every access is a copy in or out of the mapped view. */
export function mappingMemory(view: bigint | number, size: number): ChannelMemory {
  // koffi hands an `intptr_t` back as a number or a BigInt depending on the build; normalise once.
  const base = BigInt(view);
  const at = (offset: number) => base + BigInt(offset);
  const readInto = (offset: number, length: number): Buffer => {
    const out = Buffer.allocUnsafe(length);
    RtlMoveMemory(out, at(offset), length);
    return out;
  };
  const writeFrom = (offset: number, bytes: Uint8Array): void => {
    RtlMoveMemory(at(offset), bytes, bytes.length);
  };
  return {
    size,
    readUInt32LE: (offset) => readInto(offset, 4).readUInt32LE(0),
    writeUInt32LE: (offset, value) => { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32LE(value, 0); writeFrom(offset, bytes); },
    readBigUInt64LE: (offset) => readInto(offset, 8).readBigUInt64LE(0),
    writeBigUInt64LE: (offset, value) => { const bytes = Buffer.allocUnsafe(8); bytes.writeBigUInt64LE(value, 0); writeFrom(offset, bytes); },
    readDoubleLE: (offset) => readInto(offset, 8).readDoubleLE(0),
    writeDoubleLE: (offset, value) => { const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleLE(value, 0); writeFrom(offset, bytes); },
    read: (offset, length) => readInto(offset, length),
    write: (offset, bytes) => writeFrom(offset, bytes),
    fill: (offset, value, length) => { const bytes = Buffer.alloc(length, value); writeFrom(offset, bytes); },
  };
}
