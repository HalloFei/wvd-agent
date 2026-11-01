/**
 * Win32 through koffi, loaded only inside the engine child's workers, never by the World: a native
 * fault must take down this process, not the bot (design §7.3). JPEG work lives in gdiplus.mjs.
 *
 * Capture is the measured path for this game: `PrintWindow` with `PW_RENDERFULLCONTENT` into a
 * 32-bit DIB section, then only the window's **client area** is read. `GetWindowRect` on a bordered
 * window includes the DWM frame, which would offset every click by the border; `GetClientRect` plus
 * `ClientToScreen` gives the client rectangle and its origin, so a frame pixel and a tap pixel mean
 * the same place (R14). The process declares itself per-monitor DPI aware before anything else, so
 * every rectangle is device pixels and the frame reports what was captured, never a constant.
 *
 * Input is refused unless the game window holds the foreground. The rule for a gesture is: guard the
 * press, always complete the gesture (R21) — see `tap` and `holdKey`.
 *
 * The stop hotkey is a thread-queue `RegisterHotKey`: its `WM_HOTKEY` never reaches Node, so
 * `pollStopHotkey` pumps the queue from a timer the child runs beside the protocol loop (R3).
 */
import koffi from 'koffi';
import { createGestures } from './gestures.mjs';
import { parseHotkey } from './hotkey.mjs';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
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

const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ WvdRect *rect)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ WvdRect *rect)');
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ WvdPoint *point)');
const GetDC = user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)');
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)');
const PrintWindow = user32.func('bool __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32_t flags)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
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

const PW_RENDERFULLCONTENT = 0x2;
/** VK_MENU: a lone Alt tap is what makes SetForegroundWindow legal for a background process. */
const VK_MENU = 0x12;
const SW_RESTORE = 9;
const SRCCOPY = 0x00cc0020;
const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x1;
const MOD_NOREPEAT = 0x4000;
const HOTKEY_ID = 1;
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
const MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
const SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
const KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;

// per-monitor DPI aware v2, so no call here scales anything (SetProcessDpiAwarenessContext(-4))
try {
  SetProcessDpiAwarenessContext(-4);
} catch {
  // before Windows 10 1703 the call is absent; the window is at 100% there anyway
}

export { Refused } from './gestures.mjs';

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

/**
 * Restore (if minimized) and raise the window, then report whether it holds the foreground.
 * Windows only lets the foreground process hand focus away, so a lone Alt tap goes first — the
 * technique Coopanion's computer use uses. `SetForegroundWindow` can still be refused; the caller
 * reads the returned boolean and decides, it never assumes the focus took.
 */
export function focusWindow(hwnd) {
  if (!hwnd) return false;
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  send([virtualKey(VK_MENU, 0), virtualKey(VK_MENU, KEYEVENTF_KEYUP)]);
  SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);
  return isForeground(hwnd);
}

// Two reusable DIB sections: PrintWindow renders the whole window into the first, BitBlt copies the
// client rectangle into the second, and RtlMoveMemory hands those bytes to the caller. No
// `koffi.view` anywhere: Electron forbids external buffers (it aborts the process), and this module
// runs under ELECTRON_RUN_AS_NODE as well as plain node (R9).
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

/** Frees the capture surface; the capture worker calls this when it stops. */
export function releaseCaptureSurface() {
  releaseSurface();
}

/**
 * The window's client area as top-down BGRA device pixels. `target` is an optional buffer to fill
 * (the capture worker reuses the buffers its encoder returns); a new one is allocated when it is
 * absent or too small. PrintWindow still renders the whole window — the client rectangle is
 * BitBlt'ed out in the window's own coordinates, so a bordered window is captured at the right
 * offset and its frame never reaches perception (R14).
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mouse = (flags, dx = 0, dy = 0) => ({ type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const key = (scan, flags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });
const virtualKey = (vk, flags) => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } });

function send(inputs) {
  const sent = SendInput(inputs.length, inputs, INPUT_SIZE);
  if (sent !== inputs.length) throw new Error(`send-input:${sent}/${inputs.length}`);
}

/**
 * A pointer move the game can see. The world map reads its pan from *pointer motion in the input
 * stream*: `SetCursorPos` relocates the pointer without producing one, so a drag built from it never
 * panned (measured 2026-11-01 — twenty such drags moved nothing, while every drag that injected
 * `MOUSEEVENTF_MOVE` moved the map by roughly the drag distance). The coordinates are the virtual
 * screen normalised to 0..65535, which is what `MOUSEEVENTF_ABSOLUTE` expects; per-monitor DPI
 * awareness was set above, so the client and screen spaces agree.
 */
function absoluteMove(screenX, screenY) {
  const left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const width = Math.max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const height = Math.max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  const nx = Math.round(((screenX - left) * 65535) / (width - 1));
  const ny = Math.round(((screenY - top) * 65535) / (height - 1));
  send([mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny)]);
}

/**
 * The Win32 device the gesture rules drive (gestures.mjs owns the rules, this file owns the calls).
 * `moveToClient` converts client device pixels to screen through `ClientToScreen` once per press.
 */
const device = {
  isForeground: (hwnd) => isForeground(hwnd),
  moveToClient(hwnd, x, y) {
    const point = { x: Math.round(x), y: Math.round(y) };
    if (!ClientToScreen(hwnd, point)) throw new Error('client-to-screen');
    absoluteMove(point.x, point.y);
  },
  mouseDown: () => send([mouse(MOUSEEVENTF_LEFTDOWN)]),
  mouseUp: () => send([mouse(MOUSEEVENTF_LEFTUP)]),
  keyDown: (scan) => send([key(scan, KEYEVENTF_SCANCODE)]),
  keyUp: (scan) => send([key(scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP)]),
  sleep,
};

const gestures = createGestures(device);

/** Same contract as before: guard the press, always complete the gesture (R21); see gestures.mjs. */
export const tap = gestures.tap;
export const drag = gestures.drag;
export const holdKey = gestures.holdKey;
/** Sends the releases for anything still down when the process is going away. */
export const releaseHeld = gestures.releaseHeld;

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
