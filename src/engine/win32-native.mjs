/**
 * Win32 through koffi. Loaded only inside the engine child (`child.mjs` and its encoder worker),
 * never by the World: a native fault must take down this process, not the bot (design §7.3).
 *
 * Capture is the measured path for this game: `PrintWindow` with `PW_RENDERFULLCONTENT` into a
 * 32-bit DIB section, then only the window's **client area** is read. `GetWindowRect` on a bordered
 * window includes the DWM frame, which would offset every click by the border; `GetClientRect` plus
 * `ClientToScreen` gives the client rectangle and its origin, so a frame pixel and a tap pixel mean
 * the same place (R14). The process declares itself per-monitor DPI aware before anything else, so
 * every rectangle is device pixels and the frame reports what was captured, never a constant.
 *
 * JPEG is encoded through GDI+ on the DIB pixels (`GdipCreateBitmapFromScan0` +
 * `GdipSaveImageToStream` over an HGLOBAL `IStream`): 15–20 ms at 1920×1080 q75, against 144–234 ms
 * for jpeg-js (R12). `createJpegEncoder` returns null when GDI+ cannot initialise, and the caller
 * falls back to jpeg-js behind the same `encode(bgra, width, height)` interface.
 *
 * Input is refused unless the game window holds the foreground, checked immediately before
 * `SendInput` — a background click is dropped by the game, so refusing is the honest answer (R4).
 * Tap coordinates are client device pixels, converted to screen through `ClientToScreen` once.
 *
 * The stop hotkey is a thread-queue `RegisterHotKey`: its `WM_HOTKEY` never reaches Node, so
 * `pollStopHotkey` pumps the queue from a timer the child runs beside the protocol loop (R3).
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const gdiplus = koffi.load('gdiplus.dll');
const ole32 = koffi.load('ole32.dll');
const kernel32 = koffi.load('kernel32.dll');

const POINT = koffi.struct('WvdPoint', { x: 'long', y: 'long' });
const RECT = koffi.struct('WvdRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const MSG = koffi.struct('WvdMsg', {
  hwnd: 'intptr_t',
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt: POINT,
  lPrivate: 'uint32_t',
});
const BITMAPINFOHEADER = koffi.struct('WvdBitmapInfoHeader', {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
  biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t',
  biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
});
const MOUSEINPUT = koffi.struct('WvdMouseInput', {
  dx: 'long', dy: 'long', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('WvdKeyboardInput', {
  wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('WvdHardwareInput', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
const INPUT = koffi.struct('WvdInput', {
  type: 'uint32_t',
  u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
});

// GDI+ (encoding only)
const CLSID = koffi.struct('WvdClsid', {
  Data1: 'uint32_t', Data2: 'uint16_t', Data3: 'uint16_t', Data4: koffi.array('uint8_t', 8),
});
const ENCODER_PARAMETER = koffi.struct('WvdEncoderParameter', {
  Guid: CLSID, NumberOfValues: 'uint32_t', Type: 'uint32_t', Value: 'void *',
});
const ENCODER_PARAMETERS = koffi.struct('WvdEncoderParameters', {
  Count: 'uint32_t', Parameter: koffi.array(ENCODER_PARAMETER, 1),
});
const IMAGE_CODEC_INFO = koffi.struct('WvdImageCodecInfo', {
  Clsid: CLSID, FormatID: CLSID,
  CodecName: 'str16', DllName: 'str16', FormatDescription: 'str16', FilenameExtension: 'str16', MimeType: 'str16',
  Flags: 'uint32_t', Version: 'uint32_t', SigCount: 'uint32_t', SigSize: 'uint32_t', SigPattern: 'void *', SigMask: 'void *',
});
const GDIPLUS_STARTUP_INPUT = koffi.struct('WvdGdiplusStartupInput', {
  GdiplusVersion: 'uint32_t', DebugEventCallback: 'void *', SuppressBackgroundThread: 'int32_t', SuppressExternalCodecs: 'int32_t',
});
const SEEK_PROTO = koffi.proto('int32_t __stdcall WvdStreamSeek(void *self, int64_t move, uint32_t origin, _Out_ int64_t *position)');
const RELEASE_PROTO = koffi.proto('uint32_t __stdcall WvdStreamRelease(void *self)');

const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ WvdRect *rect)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ WvdRect *rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ WvdPoint *point)');
const GetDC = user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32_t flags)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, WvdInput *inputs, int size)');
const RegisterHotKey = user32.func('bool __stdcall RegisterHotKey(intptr_t hwnd, int id, uint32_t mods, uint32_t vk)');
const UnregisterHotKey = user32.func('bool __stdcall UnregisterHotKey(intptr_t hwnd, int id)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Inout_ WvdMsg *msg, intptr_t hwnd, uint32_t min, uint32_t max, uint32_t remove)');
const CreateCompatibleDC = gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t dc)');
const CreateDIBSection = gdi32.func('intptr_t __stdcall CreateDIBSection(intptr_t dc, _In_ WvdBitmapInfoHeader *bmi, uint32_t usage, _Out_ void **bits, intptr_t section, uint32_t offset)');
const SelectObject = gdi32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr_t obj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr_t dc)');
const BitBlt = gdi32.func('bool __stdcall BitBlt(intptr_t dst, int x, int y, int w, int h, intptr_t src, int sx, int sy, uint32_t rop)');
const RtlMoveMemory = kernel32.func('void __stdcall RtlMoveMemory(void *dest, const void *src, intptr_t length)');
const GdiplusStartup = gdiplus.func('int32_t __stdcall GdiplusStartup(_Out_ uintptr_t *token, _In_ WvdGdiplusStartupInput *input, void *output)');
const GdipGetImageEncodersSize = gdiplus.func('int32_t __stdcall GdipGetImageEncodersSize(_Out_ uint32_t *numEncoders, _Out_ uint32_t *size)');
const GdipGetImageEncoders = gdiplus.func('int32_t __stdcall GdipGetImageEncoders(uint32_t numEncoders, uint32_t size, void *encoders)');
const GdipCreateBitmapFromScan0 = gdiplus.func('int32_t __stdcall GdipCreateBitmapFromScan0(int width, int height, int stride, int format, void *scan0, _Out_ void **bitmap)');
const GdipSaveImageToStream = gdiplus.func('int32_t __stdcall GdipSaveImageToStream(void *image, void *stream, _In_ WvdClsid *clsid, _In_ WvdEncoderParameters *params)');
const GdipDisposeImage = gdiplus.func('int32_t __stdcall GdipDisposeImage(void *image)');
const CreateStreamOnHGlobal = ole32.func('int32_t __stdcall CreateStreamOnHGlobal(intptr_t hglobal, int32_t deleteOnRelease, _Out_ void **stream)');
const GetHGlobalFromStream = ole32.func('int32_t __stdcall GetHGlobalFromStream(void *stream, _Out_ intptr_t *hglobal)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(intptr_t handle)');
const GlobalUnlock = kernel32.func('int32_t __stdcall GlobalUnlock(intptr_t handle)');

const PW_RENDERFULLCONTENT = 0x2;
const SRCCOPY = 0x00cc0020;
const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x1;
const MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
const HOTKEY_ID = 1;
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
const KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;
const PIXEL_FORMAT_32BPP_ARGB = 0x0026200a;
const ENCODER_PARAMETER_VALUE_TYPE_LONG = 4;
/** EncoderQuality, the only JPEG parameter this engine sets. */
const ENCODER_QUALITY = {
  Data1: 0x1d5be4b5, Data2: 0xfa4a, Data3: 0x452d,
  Data4: [0x9c, 0xdd, 0x5d, 0xb3, 0x51, 0x05, 0xe7, 0xeb],
};
/** The shortest press the game sees: a 0 ms press is dropped at 30 fps (spec §4). */
const PRESS_MS = 60;

// per-monitor DPI aware v2, so no call here scales anything (SetProcessDpiAwarenessContext(-4))
try {
  SetProcessDpiAwarenessContext(-4);
} catch {
  // before Windows 10 1703 the call is absent; the window is at 100% there anyway
}

/** The one refusal the hotkey guard makes; the child turns it into `rejected`/`not-foreground`. */
export class Refused extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'Refused';
    this.detail = detail;
  }
}

/** `sizeof(INPUT)` on this ABI; `SendInput` refuses the array when it is anything else. */
export const INPUT_SIZE = koffi.sizeof(INPUT);

/** Handle of the top-level window titled exactly `title`, or 0 when it is not on screen. */
export function findWindow(title) {
  return FindWindowW(null, title);
}

/** The window's outer rectangle in physical pixels, or null when the call fails. */
export function windowRect(hwnd) {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetWindowRect(hwnd, rect)) return null;
  return { left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/** The window's client rectangle in physical pixels, or null when the call fails. */
export function clientRect(hwnd) {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetClientRect(hwnd, rect)) return null;
  return { left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

export function isForeground(hwnd) {
  return hwnd !== 0 && GetForegroundWindow() === hwnd;
}

// Two reusable DIB sections: PrintWindow renders the whole window into the first, BitBlt copies the
// client rectangle into the second, and RtlMoveMemory hands those bytes to the caller. No
// `koffi.view` anywhere: Electron forbids external buffers (it aborts the process), and this module
// must run under ELECTRON_RUN_AS_NODE as well as plain node (R9).
let surface = null;

function releaseSurface() {
  if (!surface) return;
  try {
    if (surface.windowDc) SelectObject(surface.windowDc, surface.windowPrevious);
    if (surface.windowBitmap) DeleteObject(surface.windowBitmap);
    if (surface.windowDc) DeleteDC(surface.windowDc);
    if (surface.clientDc) SelectObject(surface.clientDc, surface.clientPrevious);
    if (surface.clientBitmap) DeleteObject(surface.clientBitmap);
    if (surface.clientDc) DeleteDC(surface.clientDc);
    if (surface.screen) ReleaseDC(0, surface.screen);
  } finally {
    surface = null;
  }
}

function bitmapHeader(width, height) {
  return {
    biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, biPlanes: 1,
    biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
  };
}

function ensureSurface(windowWidth, windowHeight, clientWidth, clientHeight) {
  if (surface
    && surface.windowWidth === windowWidth && surface.windowHeight === windowHeight
    && surface.clientWidth === clientWidth && surface.clientHeight === clientHeight) return surface;
  releaseSurface();
  const screen = GetDC(0);
  if (!screen) throw new Error('capture-dc');
  const windowDc = CreateCompatibleDC(screen);
  const windowBits = [null];
  const windowBitmap = windowDc ? CreateDIBSection(screen, bitmapHeader(windowWidth, windowHeight), 0, windowBits, 0, 0) : 0;
  const clientDc = windowDc ? CreateCompatibleDC(windowDc) : 0;
  const clientBits = [null];
  const clientBitmap = clientDc ? CreateDIBSection(windowDc, bitmapHeader(clientWidth, clientHeight), 0, clientBits, 0, 0) : 0;
  if (!windowDc || !windowBitmap || !windowBits[0] || !clientDc || !clientBitmap || !clientBits[0]) {
    if (clientBitmap) DeleteObject(clientBitmap);
    if (clientDc) DeleteDC(clientDc);
    if (windowBitmap) DeleteObject(windowBitmap);
    if (windowDc) DeleteDC(windowDc);
    ReleaseDC(0, screen);
    throw new Error('capture-surface');
  }
  surface = {
    windowWidth,
    windowHeight,
    clientWidth,
    clientHeight,
    screen,
    windowDc,
    windowBitmap,
    windowBits: windowBits[0],
    windowPrevious: SelectObject(windowDc, windowBitmap),
    clientDc,
    clientBitmap,
    clientBits: clientBits[0],
    clientPrevious: SelectObject(clientDc, clientBitmap),
  };
  return surface;
}

/** Frees the capture surface; the child calls this on shutdown. */
export function releaseCaptureSurface() {
  releaseSurface();
}

/**
 * The window's client area as top-down BGRA device pixels. `target` is an optional buffer to fill
 * (the child reuses the buffers its encoder returns); a new one is allocated when it is absent or
 * too small. PrintWindow still renders the whole window — the client rectangle is BitBlt'ed out in
 * the window's own coordinates, so a bordered window is captured at the right offset and its frame
 * never reaches perception (R14).
 */
export function captureClient(hwnd, target = null) {
  const window = windowRect(hwnd);
  if (!window) throw new Error('window-rect');
  const client = clientRect(hwnd);
  if (!client || client.width <= 0 || client.height <= 0) throw new Error('client-rect');
  const origin = { x: 0, y: 0 };
  if (!ClientToScreen(hwnd, origin)) throw new Error('client-origin');
  const offsetX = origin.x - window.left;
  const offsetY = origin.y - window.top;
  if (offsetX < 0 || offsetY < 0 || offsetX + client.width > window.width || offsetY + client.height > window.height) {
    throw new Error('client-outside-window');
  }
  const current = ensureSurface(window.width, window.height, client.width, client.height);
  if (!PrintWindow(hwnd, current.windowDc, PW_RENDERFULLCONTENT)) throw new Error('print-window');
  if (!BitBlt(current.clientDc, 0, 0, client.width, client.height, current.windowDc, offsetX, offsetY, SRCCOPY)) {
    throw new Error('bitblt');
  }
  const size = client.width * client.height * 4;
  const pixels = target && target.length >= size ? target.subarray(0, size) : Buffer.allocUnsafe(size);
  RtlMoveMemory(pixels, current.clientBits, size);
  return { width: client.width, height: client.height, bgra: pixels };
}

// GDI+ is started lazily, in whichever thread first asks for an encoder (the worker thread).
let gdiplusState;

function gdiplusSupport() {
  if (gdiplusState) return gdiplusState;
  try {
    const token = [0];
    const input = {
      GdiplusVersion: 1, DebugEventCallback: 0, SuppressBackgroundThread: 0, SuppressExternalCodecs: 0,
    };
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
    gdiplusState = { ok: true, token: token[0], clsid };
  } catch (error) {
    gdiplusState = { ok: false, detail: error?.message ?? String(error) };
  }
  return gdiplusState;
}

/** Why GDI+ is unavailable, for the child's log; empty when it is available. */
export function gdiplusProblem() {
  const state = gdiplusSupport();
  return state.ok ? '' : state.detail;
}

const pointerSize = koffi.sizeof('void *');
const encoderStreamSeek = 5; // IStream::Seek
const encoderStreamRelease = 2; // IUnknown::Release

/**
 * A JPEG encoder over GDI+, or null when GDI+ cannot start (the caller falls back to jpeg-js).
 * `encode(bgra, width, height)` takes top-down BGRA — exactly what `captureClient` produces — and
 * copies the bytes out before the stream is released: the HGLOBAL is freed on release.
 */
export function createJpegEncoder(quality) {
  const state = gdiplusSupport();
  if (!state.ok) return null;
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
      let vtable = null;
      try {
        const opened = CreateStreamOnHGlobal(0, 1, stream);
        if (opened !== 0) throw new Error(`gdiplus-stream:${opened}`);
        vtable = koffi.decode(stream[0], 'void *');
        const saved = GdipSaveImageToStream(bitmap[0], stream[0], state.clsid, params);
        if (saved !== 0) throw new Error(`gdiplus-save:${saved}`);
        const seek = koffi.decode(vtable, encoderStreamSeek * pointerSize, 'void *');
        const position = [0];
        const sought = koffi.call(seek, SEEK_PROTO, stream[0], 0, 2, position); // STREAM_SEEK_END
        if (sought !== 0) throw new Error(`gdiplus-seek:${sought}`);
        const length = Number(position[0]);
        if (!(length > 0)) throw new Error('gdiplus-empty');
        const hglobal = [0];
        if (GetHGlobalFromStream(stream[0], hglobal) !== 0) throw new Error('gdiplus-hglobal');
        const pointer = GlobalLock(hglobal[0]);
        if (!pointer) throw new Error('gdiplus-lock');
        try {
          // copied out before the stream is released: the HGLOBAL is freed on release
          const bytes = Buffer.allocUnsafe(length);
          RtlMoveMemory(bytes, pointer, length);
          return bytes;
        } finally {
          GlobalUnlock(hglobal[0]);
        }
      } finally {
        if (vtable) {
          const release = koffi.decode(vtable, encoderStreamRelease * pointerSize, 'void *');
          koffi.call(release, RELEASE_PROTO, stream[0]);
        }
        GdipDisposeImage(bitmap[0]);
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mouse = (flags) => ({ type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const key = (scan, flags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

function send(inputs) {
  const sent = SendInput(inputs.length, inputs, INPUT_SIZE);
  if (sent !== inputs.length) throw new Error(`send-input:${sent}/${inputs.length}`);
}

function requireForeground(hwnd) {
  if (!isForeground(hwnd)) throw new Refused('not-foreground');
}

/**
 * `count` left clicks at `x`,`y` — client device pixels, converted to screen through
 * `ClientToScreen` once per click. Each click is a 60 ms press, and the foreground is re-asserted
 * before every one, so a focus change between clicks refuses the rest instead of clicking into
 * another app.
 */
export async function tap(hwnd, x, y, count) {
  for (let i = 0; i < count; i++) {
    requireForeground(hwnd);
    const point = { x: Math.round(x), y: Math.round(y) };
    if (!ClientToScreen(hwnd, point)) throw new Error('client-to-screen');
    if (!SetCursorPos(point.x, point.y)) throw new Error('set-cursor');
    send([mouse(MOUSEEVENTF_LEFTDOWN)]);
    await sleep(PRESS_MS);
    send([mouse(MOUSEEVENTF_LEFTUP)]);
    if (i < count - 1) await sleep(PRESS_MS);
  }
}

/** Holds the key with keyboard scan code `scan` for at least `holdMs`; releases it even on failure. */
export async function holdKey(hwnd, scan, holdMs) {
  requireForeground(hwnd);
  send([key(scan, KEYEVENTF_SCANCODE)]);
  try {
    await sleep(Math.max(PRESS_MS, Math.round(holdMs)));
  } finally {
    send([key(scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)]);
  }
}

const MODIFIERS = new Map([
  ['ctrl', MOD_CONTROL], ['control', MOD_CONTROL], ['alt', MOD_ALT], ['shift', MOD_SHIFT],
  ['win', MOD_WIN], ['windows', MOD_WIN], ['meta', MOD_WIN],
]);

/** `Ctrl+Alt+W` → { mods, vk }; null for anything else, so a typo fails registration loudly. */
export function parseHotkey(text) {
  const parts = String(text).split('+').map((part) => part.trim()).filter(Boolean);
  let mods = 0;
  let vk = 0;
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (modifier !== undefined) {
      mods |= modifier;
      continue;
    }
    if (vk !== 0) return null;
    if (/^[a-z0-9]$/i.test(part)) {
      vk = part.toUpperCase().charCodeAt(0);
      continue;
    }
    const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(part);
    if (!functionKey) return null;
    vk = 0x6f + Number(functionKey[1]);
  }
  return vk === 0 ? null : { mods, vk };
}

let hotkeyRegistered = false;

/** Registers the stop hotkey on this thread's queue; `{ ok: false, detail }` when it cannot. */
export function registerStopHotkey(text) {
  const parsed = parseHotkey(text);
  if (!parsed) return { ok: false, detail: `bad-hotkey:${text}` };
  if (hotkeyRegistered) unregisterStopHotkey();
  if (!RegisterHotKey(0, HOTKEY_ID, parsed.mods | MOD_NOREPEAT, parsed.vk)) return { ok: false, detail: 'register-hotkey-failed' };
  hotkeyRegistered = true;
  return { ok: true };
}

export function unregisterStopHotkey() {
  if (!hotkeyRegistered) return;
  UnregisterHotKey(0, HOTKEY_ID);
  hotkeyRegistered = false;
}

/** Drains `WM_HOTKEY` from the thread queue; the number of presses is what the child reports. */
export function pollStopHotkey() {
  if (!hotkeyRegistered) return 0;
  const msg = { hwnd: 0, message: 0, wParam: 0, lParam: 0, time: 0, pt: { x: 0, y: 0 }, lPrivate: 0 };
  let presses = 0;
  while (PeekMessageW(msg, 0, WM_HOTKEY, WM_HOTKEY, PM_REMOVE)) {
    if (msg.message === WM_HOTKEY && msg.wParam === HOTKEY_ID) presses++;
  }
  return presses;
}
