/**
 * GDI+ through koffi: JPEG encode and decode, shared by the engine child's encoder thread (encode),
 * the World process (decode, R19), and the native round-trip test. No new dependency: GDI+ is a
 * Windows component and koffi is already required for Win32.
 *
 * Encode: `GdipCreateBitmapFromScan0` over the captured BGRA -> JPEG codec CLSID from
 * `GdipGetImageEncoders` -> `GdipSaveImageToStream` over an HGLOBAL `IStream`, quality as an
 * `EncoderQuality` long. Decode: the base64 JPEG goes into an HGLOBAL `IStream`,
 * `GdipCreateBitmapFromStream`, `GdipBitmapLockBits` at 32bppARGB, one `RtlMoveMemory` out, and a
 * Uint32 pass that turns BGRA into the RGBA `RgbaImage` promises.
 *
 * `RtlMoveMemory` copies, never `koffi.view`: Electron aborts a process that creates an external
 * buffer over native memory, and this module must run under ELECTRON_RUN_AS_NODE too (R9).
 *
 * GDI+ is started lazily in whichever thread first asks for it. `createJpegEncoder` returns null and
 * `decodeJpeg` throws when GDI+ cannot start, so each caller can fall back to jpeg-js and say so.
 */
import koffi from 'koffi';

const gdiplus = koffi.load('gdiplus.dll');
const ole32 = koffi.load('ole32.dll');
const kernel32 = koffi.load('kernel32.dll');

const CLSID = koffi.struct('GpClsid', {
  Data1: 'uint32_t', Data2: 'uint16_t', Data3: 'uint16_t', Data4: koffi.array('uint8_t', 8),
});
const ENCODER_PARAMETER = koffi.struct('GpEncoderParameter', {
  Guid: CLSID, NumberOfValues: 'uint32_t', Type: 'uint32_t', Value: 'void *',
});
const ENCODER_PARAMETERS = koffi.struct('GpEncoderParameters', {
  Count: 'uint32_t', Parameter: koffi.array(ENCODER_PARAMETER, 1),
});
const IMAGE_CODEC_INFO = koffi.struct('GpImageCodecInfo', {
  Clsid: CLSID, FormatID: CLSID,
  CodecName: 'str16', DllName: 'str16', FormatDescription: 'str16', FilenameExtension: 'str16', MimeType: 'str16',
  Flags: 'uint32_t', Version: 'uint32_t', SigCount: 'uint32_t', SigSize: 'uint32_t', SigPattern: 'void *', SigMask: 'void *',
});
const STARTUP_INPUT = koffi.struct('GpStartupInput', {
  GdiplusVersion: 'uint32_t', DebugEventCallback: 'void *', SuppressBackgroundThread: 'int32_t', SuppressExternalCodecs: 'int32_t',
});
const BITMAP_DATA = koffi.struct('GpBitmapData', {
  Width: 'uint32_t', Height: 'uint32_t', Stride: 'int32_t', PixelFormat: 'int32_t', Scan0: 'void *', Reserved: 'uintptr_t',
});
const GP_RECT = koffi.struct('GpRect', { X: 'int32_t', Y: 'int32_t', Width: 'int32_t', Height: 'int32_t' });

const SEEK_PROTO = koffi.proto('int32_t __stdcall GpStreamSeek(void *self, int64_t move, uint32_t origin, _Out_ int64_t *position)');
const RELEASE_PROTO = koffi.proto('uint32_t __stdcall GpStreamRelease(void *self)');

const GdiplusStartup = gdiplus.func('int32_t __stdcall GdiplusStartup(_Out_ uintptr_t *token, _In_ GpStartupInput *input, void *output)');
const GdipGetImageEncodersSize = gdiplus.func('int32_t __stdcall GdipGetImageEncodersSize(_Out_ uint32_t *numEncoders, _Out_ uint32_t *size)');
const GdipGetImageEncoders = gdiplus.func('int32_t __stdcall GdipGetImageEncoders(uint32_t numEncoders, uint32_t size, void *encoders)');
const GdipCreateBitmapFromScan0 = gdiplus.func('int32_t __stdcall GdipCreateBitmapFromScan0(int width, int height, int stride, int format, void *scan0, _Out_ void **bitmap)');
const GdipCreateBitmapFromStream = gdiplus.func('int32_t __stdcall GdipCreateBitmapFromStream(void *stream, _Out_ void **bitmap)');
const GdipGetImageWidth = gdiplus.func('int32_t __stdcall GdipGetImageWidth(void *image, _Out_ uint32_t *width)');
const GdipGetImageHeight = gdiplus.func('int32_t __stdcall GdipGetImageHeight(void *image, _Out_ uint32_t *height)');
const GdipBitmapLockBits = gdiplus.func('int32_t __stdcall GdipBitmapLockBits(void *bitmap, _In_ GpRect *rect, uint32_t flags, int32_t format, _Inout_ GpBitmapData *data)');
const GdipBitmapUnlockBits = gdiplus.func('int32_t __stdcall GdipBitmapUnlockBits(void *bitmap, _Inout_ GpBitmapData *data)');
const GdipSaveImageToStream = gdiplus.func('int32_t __stdcall GdipSaveImageToStream(void *image, void *stream, _In_ GpClsid *clsid, _In_ GpEncoderParameters *params)');
const GdipDisposeImage = gdiplus.func('int32_t __stdcall GdipDisposeImage(void *image)');
const CreateStreamOnHGlobal = ole32.func('int32_t __stdcall CreateStreamOnHGlobal(intptr_t hglobal, int32_t deleteOnRelease, _Out_ void **stream)');
const GetHGlobalFromStream = ole32.func('int32_t __stdcall GetHGlobalFromStream(void *stream, _Out_ intptr_t *hglobal)');
const GlobalAlloc = kernel32.func('intptr_t __stdcall GlobalAlloc(uint32_t flags, intptr_t bytes)');
const GlobalFree = kernel32.func('intptr_t __stdcall GlobalFree(intptr_t handle)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(intptr_t handle)');
const GlobalUnlock = kernel32.func('int32_t __stdcall GlobalUnlock(intptr_t handle)');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void *dest, const void *src, intptr_t length)');

const PIXEL_FORMAT_32BPP_ARGB = 0x0026200a;
const ENCODER_PARAMETER_VALUE_TYPE_LONG = 4;
const IMAGE_LOCK_MODE_READ = 1;
const GMEM_MOVEABLE = 0x2;
const STREAM_SEEK_END = 2;
/** EncoderQuality, the only JPEG parameter this engine sets. */
const ENCODER_QUALITY = {
  Data1: 0x1d5be4b5, Data2: 0xfa4a, Data3: 0x452d,
  Data4: [0x9c, 0xdd, 0x5d, 0xb3, 0x51, 0x05, 0xe7, 0xeb],
};

const pointerSize = koffi.sizeof('void *');

let state;

function support() {
  if (state) return state;
  try {
    const token = [0];
    const input = { GdiplusVersion: 1, DebugEventCallback: 0, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0 };
    const startup = GdiplusStartup(token, input, null);
    if (startup !== 0) throw new Error(`gdiplus-startup:${startup}`);
    const counts = [0];
    const bytes = [0];
    if (GdipGetImageEncodersSize(counts, bytes) !== 0) throw new Error('gdiplus-encoders-size');
    const buffer = Buffer.alloc(bytes[0]);
    if (GdipGetImageEncoders(counts[0], bytes[0], buffer) !== 0) throw new Error('gdiplus-encoders');
    const codec = koffi.decode(buffer, IMAGE_CODEC_INFO, counts[0]).find((candidate) => candidate.MimeType === 'image/jpeg');
    if (!codec) throw new Error('gdiplus-no-jpeg');
    const clsid = {
      Data1: codec.Clsid.Data1,
      Data2: codec.Clsid.Data2,
      Data3: codec.Clsid.Data3,
      Data4: Array.from({ length: 8 }, (_, index) => codec.Clsid.Data4[index] ?? 0),
    };
    state = { ok: true, clsid };
  } catch (error) {
    state = { ok: false, detail: error?.message ?? String(error) };
  }
  return state;
}

/** Why GDI+ is unavailable, for a log or an `engineProblem`; empty when it is available. */
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

function seekEnd(stream) {
  const vtable = koffi.decode(stream, 'void *');
  const seek = koffi.decode(vtable, 5 * pointerSize, 'void *');
  const position = [0];
  const status = koffi.call(seek, SEEK_PROTO, stream, 0, STREAM_SEEK_END, position);
  if (status !== 0) throw new Error(`gdiplus-seek:${status}`);
  return Number(position[0]);
}

/**
 * A JPEG encoder over GDI+, or null when GDI+ cannot start (the caller falls back to jpeg-js).
 * `encode(bgra, width, height)` takes top-down BGRA — exactly what the capture produces — and
 * copies the bytes out before the stream is released, because the HGLOBAL dies with the stream.
 */
export function createJpegEncoder(quality) {
  const current = support();
  if (!current.ok) return null;
  const qualityValue = Buffer.alloc(4);
  qualityValue.writeUInt32LE(Math.max(1, Math.min(100, Math.round(quality))));
  const params = {
    Count: 1,
    Parameter: [{
      Guid: ENCODER_QUALITY,
      NumberOfValues: 1,
      Type: ENCODER_PARAMETER_VALUE_TYPE_LONG,
      Value: qualityValue,
    }],
  };
  return {
    encode(bgra, width, height) {
      const bitmap = [null];
      const created = GdipCreateBitmapFromScan0(width, height, width * 4, PIXEL_FORMAT_32BPP_ARGB, bgra, bitmap);
      if (created !== 0) throw new Error(`gdiplus-bitmap:${created}`);
      const stream = [null];
      let opened = false;
      try {
        const status = CreateStreamOnHGlobal(0, 1, stream);
        if (status !== 0) throw new Error(`gdiplus-stream:${status}`);
        opened = true;
        const saved = GdipSaveImageToStream(bitmap[0], stream[0], current.clsid, params);
        if (saved !== 0) throw new Error(`gdiplus-save:${saved}`);
        const length = seekEnd(stream[0]);
        if (!(length > 0)) throw new Error('gdiplus-empty');
        const hglobal = [0];
        if (GetHGlobalFromStream(stream[0], hglobal) !== 0) throw new Error('gdiplus-hglobal');
        const pointer = GlobalLock(hglobal[0]);
        if (!pointer) throw new Error('gdiplus-lock');
        try {
          const bytes = Buffer.allocUnsafe(length);
          RtlMoveMemory(bytes, pointer, length);
          return bytes;
        } finally {
          GlobalUnlock(hglobal[0]);
        }
      } finally {
        try {
          if (opened) releaseStream(stream[0]);
        } catch {
          // the bitmap below is still disposed
        }
        try {
          GdipDisposeImage(bitmap[0]);
        } catch {
          // nothing else to do
        }
      }
    },
  };
}

/**
 * Copy a 32bpp top-down RGBA image out of native memory with whatever stride GDI+ gave it. The
 * common case (stride == width*4) is one `RtlMoveMemory`; a padded or bottom-up stride is copied
 * row by row, because assuming width*4 is how a decoder silently scans garbage. Exported so the
 * non-standard strides can be tested without a codec that produces them.
 */
export function copyStrided(source, stride, width, height) {
  const rowBytes = width * 4;
  if (!Number.isInteger(stride) || Math.abs(stride) < rowBytes) throw new Error(`jpeg-stride:${stride}`);
  const out = Buffer.allocUnsafe(rowBytes * height);
  if (stride === rowBytes) {
    RtlMoveMemory(out, source, out.length);
    return out;
  }
  const base = typeof source === 'bigint' ? source : koffi.address(source);
  for (let row = 0; row < height; row++) {
    // a negative stride means GDI+ handed us the bottom row first
    const at = stride > 0 ? base + BigInt(row * stride) : base + BigInt((height - 1 - row) * stride);
    RtlMoveMemory(out.subarray(row * rowBytes, (row + 1) * rowBytes), at, rowBytes);
  }
  return out;
}

/**
 * Decode a JPEG to RGBA. Uses `GdipCreateBitmapFromStream` over an HGLOBAL IStream, locks the
 * decoded bitmap at 32bppARGB and copies the pixels out with one `RtlMoveMemory` (GDI+ gives a
 * width*4 stride for these images; anything else is refused so the caller can fall back rather than
 * mis-scan). Throws when GDI+ cannot start or the bytes are not a JPEG this GDI+ reads.
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
      const out = copyStrided(data.Scan0, data.Stride, width[0], height[0]);
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
