/**
 * The channel's byte access, as a seam: the pure channel logic reads and writes through this, so the
 * same code runs over a plain Buffer (tests) and over the Win32 file mapping (production).
 *
 * The mapping adapter uses `RtlMoveMemory` copies, never `koffi.view` — this codebase has measured
 * that Electron aborts a process which creates an external buffer (win32-native.mjs, 2026-10-31), and
 * a mapped pointer handed back as a Buffer is exactly that. The copy is 2 ms for a 1920x1080 frame
 * and happens once per direction.
 */

export interface ChannelMemory {
  /** Bytes the region holds. */
  readonly size: number;
  readUInt32LE(offset: number): number;
  writeUInt32LE(offset: number, value: number): void;
  readBigUInt64LE(offset: number): bigint;
  writeBigUInt64LE(offset: number, value: bigint): void;
  readDoubleLE(offset: number): number;
  writeDoubleLE(offset: number, value: number): void;
  /** A copy of `[offset, offset + length)`. */
  read(offset: number, length: number): Buffer;
  /** Copy `bytes` into the region at `offset`. */
  write(offset: number, bytes: Uint8Array): void;
  /** Zero a range. */
  fill(offset: number, value: number, length: number): void;
}

/** A channel over a plain Buffer: the tests' adapter, and the staging buffer a mapping copies through. */
export function memoryOverBuffer(buffer: Buffer): ChannelMemory {
  return {
    size: buffer.length,
    readUInt32LE: (offset) => buffer.readUInt32LE(offset),
    writeUInt32LE: (offset, value) => { buffer.writeUInt32LE(value, offset); },
    readBigUInt64LE: (offset) => buffer.readBigUInt64LE(offset),
    writeBigUInt64LE: (offset, value) => { buffer.writeBigUInt64LE(value, offset); },
    readDoubleLE: (offset) => buffer.readDoubleLE(offset),
    writeDoubleLE: (offset, value) => { buffer.writeDoubleLE(value, offset); },
    read: (offset, length) => Buffer.from(buffer.subarray(offset, offset + length)),
    write: (offset, bytes) => { buffer.set(bytes, offset); },
    fill: (offset, value, length) => { buffer.fill(value, offset, offset + length); },
  };
}
