/**
 * GDI+ through koffi: JPEG **decode** only.
 *
 * The encoder that used to live here was deleted with the vision module (2026-11-07). It was the
 * child's hot path and its hand-read COM vtable call (`Seek` on the HGLOBAL stream, after every
 * save) took a napi fatal error at the end of long runs, ending three sessions with `stale-frame`.
 * Frames now travel as raw BGRA through the shared channel and JPEG is encoded in the World with
 * jpeg-js, for escalation snapshots only.
 *
 * The decoder stays: recorded artifacts (`testdata/`) and the native round-trip test read JPEGs with
 * it, and it is the decoder this machine measured. It puts the base64 JPEG into an HGLOBAL `IStream`,
 * calls `GdipCreateBitmapFromStream`, locks the bitmap at 32bppARGB, copies it out with one
 * `RtlMoveMemory` and turns BGRA into the RGBA `RgbaImage` promises.
 *
 * `RtlMoveMemory` copies, never `koffi.view`: Electron aborts a process that creates an external
 * buffer over native memory, and this module must run under ELECTRON_RUN_AS_NODE too (R9).
 *
 * GDI+ is started lazily in whichever thread first asks for it; `decodeJpeg` throws when GDI+ cannot
 * start or the bytes are not a JPEG it reads.
 */
import koffi from 'koffi';

const gdiplus = koffi.load('gdiplus.dll');
const ole32 = koffi.load('ole32.dll');
const kernel32 = koffi.load('kernel32.dll');

const STARTUP_INPUT = koffi.struct('GpStartupInput', {
  GdiplusVersion: 'uint32_t', DebugEventCallback: 'void *', SuppressBackgroundThread: 'int32_t', SuppressExternalCodecs: 'int32_t',
});
const BITMAP_DATA = koffi.struct('GpBitmapData', {
  Width: 'uint32_t', Height: 'uint32_t', Stride: 'int32_t', PixelFormat: 'int32_t', Scan0: 'void *', Reserved: 'uintptr_t',
});
const GP_RECT = koffi.struct('GpRect', { X: 'int32_t', Y: 'int32_t', Width: 'int32_t', Height: 'int32_t' });

const RELEASE_PROTO = koffi.proto('uint32_t __stdcall GpStreamRelease(void *self)');

const GdiplusStartup = gdiplus.func('int32_t __stdcall GdiplusStartup(_Out_ uintptr_t *token, _In_ GpStartupInput *input, void *output)');
const GdipCreateBitmapFromStream = gdiplus.func('int32_t __stdcall GdipCreateBitmapFromStream(void *stream, _Out_ void **bitmap)');
const GdipGetImageWidth = gdiplus.func('int32_t __stdcall GdipGetImageWidth(void *image, _Out_ uint32_t *width)');
const GdipGetImageHeight = gdiplus.func('int32_t __stdcall GdipGetImageHeight(void *image, _Out_ uint32_t *height)');
const GdipBitmapLockBits = gdiplus.func('int32_t __stdcall GdipBitmapLockBits(void *bitmap, _In_ GpRect *rect, uint32_t flags, int32_t format, _Inout_ GpBitmapData *data)');
const GdipBitmapUnlockBits = gdiplus.func('int32_t __stdcall GdipBitmapUnlockBits(void *bitmap, _Inout_ GpBitmapData *data)');
const GdipDisposeImage = gdiplus.func('int32_t __stdcall GdipDisposeImage(void *image)');
const CreateStreamOnHGlobal = ole32.func('int32_t __stdcall CreateStreamOnHGlobal(intptr_t hglobal, int32_t deleteOnRelease, _Out_ void **stream)');
const GlobalAlloc = kernel32.func('intptr_t __stdcall GlobalAlloc(uint32_t flags, intptr_t bytes)');
const GlobalFree = kernel32.func('intptr_t __stdcall GlobalFree(intptr_t handle)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(intptr_t handle)');
const GlobalUnlock = kernel32.func('int32_t __stdcall GlobalUnlock(intptr_t handle)');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void *dest, const void *src, intptr_t length)');

const PIXEL_FORMAT_32BPP_ARGB = 0x0026200a;
const IMAGE_LOCK_MODE_READ = 1;
const GMEM_MOVEABLE = 0x2;

const pointerSize = koffi.sizeof('void *');

let state;

function support() {
  if (state) return state;
  try {
    const token = [0];
    const input = { GdiplusVersion: 1, DebugEventCallback: 0, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0 };
    const startup = GdiplusStartup(token, input, null);
    if (startup !== 0) throw new Error(`gdiplus-startup:${startup}`);
    state = { ok: true };
  } catch (error) {
    state = { ok: false, detail: error?.message ?? String(error) };
  }
  return state;
}

/** Why GDI+ is unavailable, for a log or a test's skip; empty when it is available. */
export function gdiplusProblem() {
  const current = support();
  return current.ok ? '' : current.detail;
}

/** Release an IStream (IUnknown::Release, vtable slot 2). */
function releaseStream(stream) {
  const vtable = koffi.decode(stream, 'void *');
  const release = koffi.decode(vtable, 2 * pointerSize, 'void *');
  koffi.call(release, RELEASE_PROTO, stream);
}

/**
 * Decode a JPEG to RGBA. Uses `GdipCreateBitmapFromStream` over an HGLOBAL IStream, locks the
 * decoded bitmap at 32bppARGB and copies the pixels out with one `RtlMoveMemory`.
 *
 * A stride other than width*4 is refused, not interpreted: GDI+ rows are `Scan0 + y*Stride`, so a
 * negative stride already encodes bottom-up, and row arithmetic here cannot be exercised by any
 * JPEG GDI+ produces (it locks these at width*4). A decoder that cannot occur is not worth an
 * aliasing bug, so the bytes are refused.
 *
 * Throws when GDI+ cannot start or the bytes are not a JPEG this GDI+ reads.
 */
export function decodeJpeg(bytes) {
  const current = support();
  if (!current.ok) throw new Error(`gdiplus:${current.detail}`);
  if (!bytes || bytes.length === 0) throw new Error('jpeg-empty');

  const hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes.length);
  if (!hglobal) throw new Error('jpeg-hglobal');
  const pointer = GlobalLock(hglobal);
  if (!pointer) {
    GlobalFree(hglobal);
    throw new Error('jpeg-lock');
  }
  RtlMoveMemory(pointer, bytes, bytes.length);
  GlobalUnlock(hglobal);

  const stream = [null];
  const opened = CreateStreamOnHGlobal(hglobal, 1, stream); // the stream owns the HGLOBAL now
  if (opened !== 0) {
    GlobalFree(hglobal);
    throw new Error(`jpeg-stream:${opened}`);
  }
  const bitmap = [null];
  try {
    const created = GdipCreateBitmapFromStream(stream[0], bitmap);
    if (created !== 0) throw new Error(`jpeg-create:${created}`);
    const width = [0];
    const height = [0];
    if (GdipGetImageWidth(bitmap[0], width) !== 0) throw new Error('jpeg-width');
    if (GdipGetImageHeight(bitmap[0], height) !== 0) throw new Error('jpeg-height');
    if (!(width[0] > 0) || !(height[0] > 0)) throw new Error('jpeg-empty-image');
    const rect = { X: 0, Y: 0, Width: width[0], Height: height[0] };
    const data = { Width: 0, Height: 0, Stride: 0, PixelFormat: 0, Scan0: null, Reserved: 0 };
    const locked = GdipBitmapLockBits(bitmap[0], rect, IMAGE_LOCK_MODE_READ, PIXEL_FORMAT_32BPP_ARGB, data);
    if (locked !== 0) throw new Error(`jpeg-lock:${locked}`);
    try {
      if (data.Stride !== width[0] * 4) throw new Error(`jpeg-stride:${data.Stride}`);
      const out = Buffer.allocUnsafe(width[0] * height[0] * 4);
      RtlMoveMemory(out, data.Scan0, out.length);
      // BGRA in memory -> the RGBA the RgbaImage contract promises (one 32-bit pass)
      const pixels = new Uint32Array(out.buffer, out.byteOffset, width[0] * height[0]);
      for (let index = 0; index < pixels.length; index++) {
        const value = pixels[index];
        pixels[index] = (value & 0xff00ff00) | ((value & 0x00ff0000) >>> 16) | ((value & 0x000000ff) << 16);
      }
      return { width: width[0], height: height[0], data: out };
    } finally {
      GdipBitmapUnlockBits(bitmap[0], data);
    }
  } finally {
    // each release is independent: a bad vtable or a failed dispose must not leak the other
    try {
      if (bitmap[0]) GdipDisposeImage(bitmap[0]);
    } catch {
      // tearing down anyway
    }
    try {
      if (stream[0]) releaseStream(stream[0]);
    } catch {
      // as above; the stream's HGLOBAL is released by the OS with the process
    }
  }
}
