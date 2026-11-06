/**
 * The vision module's frame channel: a **versioned shared-memory buffer** the capture child writes
 * and the World reads. The bytes are the contract — the child is ESM `.mjs` and reads this layout
 * directly (its offsets are exported), so a change here is a version bump, and an older child and a
 * newer World refuse each other instead of misreading a slot.
 *
 * Why a channel and not a JPEG pipe (operator, 2026-11-07): the child's native encode took a napi
 * fatal through koffi at the end of long runs and left the capture stale, and a raw 1920x1080 frame
 * costs 2 ms to copy while the base64/JSON pipe would need ~55 ms per frame. The loop now moves
 * pixels through memory; JPEG exists only for escalation snapshots, encoded in the World.
 *
 * Layout (little-endian):
 *
 *   header 64 bytes | magic u32 | version u32 | slots u32 | width u32 | height u32 | stride u32 |
 *                   | heartbeatMs f64 | demandMs f64 | latestSeq u64 | reserved |
 *   slot   32 bytes + payload | seq u64 | state u32 | pad u32 | capturedAtMs f64 | width u32 |
 *                             | height u32 | pad u64 | payload: stride*height BGRA |
 *
 * The seqlock is a stamped sequence, not a lock: a slot counts only while its `seq` equals the
 * header's `latestSeq`; a writer stamps the slot with `latestSeq + 1` *before* it writes the payload
 * and publishes the header afterwards, so a reader that sees any other number refuses rather than
 * returning a torn frame.
 */

export const CHANNEL_MAGIC = 0x574f5631; // 'WOV1'
export const CHANNEL_VERSION = 1;
/** A frame older than this is refused: the capture's own stale window, the same as the engine's. */
export const CHANNEL_STALE_MS = 300;

const HEADER_BYTES = 64;
const SLOT_META_BYTES = 32;

export interface ChannelLayout {
  readonly width: number;
  readonly height: number;
  readonly slots: number;
  readonly stride: number;
  readonly headerBytes: number;
  readonly slotBytes: number;
  readonly bytes: number;
}

export interface FrameChannel {
  readonly layout: ChannelLayout;
  /** The mapped view, or a plain Buffer in tests. */
  readonly buffer: Buffer;
}

export interface Header {
  readonly magic: number;
  readonly version: number;
  readonly slots: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly heartbeatMs: number;
  readonly demandMs: number;
  readonly latestSeq: bigint;
}

export interface ServedFrame {
  readonly seq: number;
  readonly capturedAtMs: number;
  readonly width: number;
  readonly height: number;
  /** A copy, taken inside the seqlock: the writer may reuse the slot as soon as this returns. */
  readonly pixels: Uint8Array;
}

/** The byte size of one slot and of the whole channel. */
export function layoutChannel(options: { width: number; height: number; slots: number }): ChannelLayout {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  const slots = Math.max(2, Math.floor(options.slots));
  if (!(width > 0) || !(height > 0)) throw new Error('frame-channel: bad frame size');
  const stride = width * 4;
  const slotBytes = SLOT_META_BYTES + stride * height;
  return {
    width, height, slots, stride,
    headerBytes: HEADER_BYTES,
    slotBytes,
    bytes: HEADER_BYTES + slotBytes * slots,
  };
}

/** The byte offset of a slot's sequence word (the child and the tests read the layout directly). */
export function slotOffset(layout: ChannelLayout, slot: number): number {
  return layout.headerBytes + (slot % layout.slots) * layout.slotBytes;
}

/** The byte offset of a slot's payload. */
export function payloadOffset(layout: ChannelLayout, slot: number): number {
  return slotOffset(layout, slot) + SLOT_META_BYTES;
}

/**
 * A channel over `buffer`: a fresh buffer gets its header; a buffer that already carries one is
 * validated (a version or size mismatch throws — the refusal must be loud at open time, not a
 * misread later).
 */
export function createChannel(buffer: Buffer, layout: ChannelLayout): FrameChannel {
  if (buffer.length < layout.bytes) throw new Error('frame-channel: buffer too small');
  const channel = { layout, buffer };
  if (buffer.readUInt32LE(0) !== CHANNEL_MAGIC) writeHeader(channel);
  readHeader(channel); // validates the version
  return channel;
}

/** The header as it is now. Throws on a version this code does not speak. */
export function readHeader(channel: FrameChannel): Header {
  const buffer = channel.buffer;
  const version = buffer.readUInt32LE(4);
  if (version !== CHANNEL_VERSION) {
    throw new Error(`frame-channel: unsupported version ${version} (this World speaks ${CHANNEL_VERSION})`);
  }
  return {
    magic: buffer.readUInt32LE(0),
    version,
    slots: buffer.readUInt32LE(8),
    width: buffer.readUInt32LE(12),
    height: buffer.readUInt32LE(16),
    stride: buffer.readUInt32LE(20),
    heartbeatMs: buffer.readDoubleLE(24),
    demandMs: buffer.readDoubleLE(32),
    latestSeq: buffer.readBigUInt64LE(40),
  };
}

/** Publish one frame: stamp the slot, write it, then advance the header. The writer never blocks. */
export function publish(channel: FrameChannel, bgra: Uint8Array, meta: { capturedAtMs: number }): void {
  const { layout, buffer } = channel;
  const expected = layout.stride * layout.height;
  if (bgra.length !== expected) throw new Error('frame-channel: frame is not stride*height bytes');
  const header = readHeader(channel);
  const sequence = header.latestSeq + 1n;
  const slot = Number(sequence % BigInt(layout.slots));
  const base = slotOffset(layout, slot);
  // Stamp first: a reader that lands here after the payload starts sees a number that is not the
  // published one and refuses.
  buffer.writeBigUInt64LE(sequence, base);
  buffer.writeUInt32LE(1, base + 8); // state: writing
  buffer.writeDoubleLE(meta.capturedAtMs, base + 16);
  buffer.writeUInt32LE(layout.width, base + 24);
  buffer.writeUInt32LE(layout.height, base + 28);
  buffer.set(bgra, base + SLOT_META_BYTES);
  buffer.writeUInt32LE(2, base + 8); // state: complete
  buffer.writeBigUInt64LE(sequence, 40); // publish: the header names the newest slot
  buffer.writeDoubleLE(meta.capturedAtMs, 24); // the heartbeat rides the publish clock
}

/**
 * The newest complete frame, or null: nothing published yet, a slot that is being written or is not
 * the published one, a frame older than `CHANNEL_STALE_MS`, or a copy that caught a writer. One retry
 * covers a writer landing between the two reads; a second refusal is a refusal.
 */
export function latest(channel: FrameChannel, clock: { nowMs: number }): ServedFrame | null {
  const { layout, buffer } = channel;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const header = readHeader(channel);
    if (header.latestSeq === 0n) return null;
    const slot = Number(header.latestSeq % BigInt(layout.slots));
    const base = slotOffset(layout, slot);
    if (buffer.readBigUInt64LE(base) !== header.latestSeq) continue;
    const capturedAtMs = buffer.readDoubleLE(base + 16);
    if (!Number.isFinite(capturedAtMs)) return null;
    if (clock.nowMs - capturedAtMs >= CHANNEL_STALE_MS) return null;
    const width = buffer.readUInt32LE(base + 24);
    const height = buffer.readUInt32LE(base + 28);
    if (width !== layout.width || height !== layout.height) return null;
    const pixels = new Uint8Array(layout.stride * layout.height);
    pixels.set(buffer.subarray(base + SLOT_META_BYTES, base + SLOT_META_BYTES + pixels.length));
    if (buffer.readBigUInt64LE(base) !== header.latestSeq) continue;
    return { seq: Number(header.latestSeq), capturedAtMs, width, height, pixels };
  }
  return null;
}

/** Mark the writer alive (the supervisor's liveness signal). */
export function touchHeartbeat(channel: FrameChannel, nowMs: number): void {
  channel.buffer.writeDoubleLE(nowMs, 24);
}

/** The channel's last sign of life, ms; open the channel's own clock. */
export function heartbeatOf(channel: FrameChannel): number {
  return channel.buffer.readDoubleLE(24);
}

function writeHeader(channel: FrameChannel): void {
  const { layout, buffer } = channel;
  buffer.fill(0);
  buffer.writeUInt32LE(CHANNEL_MAGIC, 0);
  buffer.writeUInt32LE(CHANNEL_VERSION, 4);
  buffer.writeUInt32LE(layout.slots, 8);
  buffer.writeUInt32LE(layout.width, 12);
  buffer.writeUInt32LE(layout.height, 16);
  buffer.writeUInt32LE(layout.stride, 20);
  buffer.writeDoubleLE(0, 24);
  buffer.writeDoubleLE(0, 32);
  buffer.writeBigUInt64LE(0n, 40);
}
