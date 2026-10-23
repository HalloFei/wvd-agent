/**
 * Win32 through koffi. Loaded only inside the engine child (`child.mjs`), never by the World: a
 * native fault must take down this process, not the bot (design §7.3).
 *
 * Capture is the measured path for this game: `PrintWindow` with `PW_RENDERFULLCONTENT` into a
 * 32-bit DIB, then `GetDIBits`, which returns BGRA top-down. The process declares itself
 * per-monitor DPI aware before anything else, so every rectangle is in device pixels and matches
 * what the frame reports (contracts §0.5: dimensions come from the capture, never a constant).
 *
 * Input is refused unless the game window holds the foreground, checked immediately before
 * `SendInput` — a background click is dropped by the game, so refusing is the honest answer (R4).
 *
 * The stop hotkey is a thread-queue `RegisterHotKey`: its `WM_HOTKEY` never reaches Node, so
 * `pollStopHotkey` pumps the queue from a timer the child runs beside the protocol loop (R3).
 */
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

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

/** `sizeof(INPUT)` on this ABI; `SendInput` refuses the array when it is anything else. */
export const INPUT_SIZE = koffi.sizeof(INPUT);

const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ WvdRect *rect)');
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
const CreateCompatibleBitmap = gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int w, int h)');
const SelectObject = gdi32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)');
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr_t obj)');
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr_t dc)');
const GetDIBits = gdi32.func('int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32_t start, uint32_t lines, void *bits, _Inout_ WvdBitmapInfoHeader *bmi, uint32_t usage)');

const PW_RENDERFULLCONTENT = 0x2;
const WM_HOTKEY = 0x0312;
const PM_REMOVE = 0x1;
const MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
const HOTKEY_ID = 1;
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4;
const KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;
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

export function isForeground(hwnd) {
  return hwnd !== 0 && GetForegroundWindow() === hwnd;
}

/** The window as top-down BGRA device pixels; the child encodes it, raw pixels never cross the pipe. */
export function capture(hwnd) {
  const rect = windowRect(hwnd);
  if (!rect) throw new Error('window-rect');
  const { width, height } = rect;
  if (width <= 0 || height <= 0) throw new Error('window-empty');
  const screen = GetDC(0);
  if (!screen) throw new Error('capture-dc');
  const memory = CreateCompatibleDC(screen);
  if (!memory) {
    ReleaseDC(0, screen);
    throw new Error('capture-dc');
  }
  const bitmap = CreateCompatibleBitmap(screen, width, height);
  if (!bitmap) {
    DeleteDC(memory);
    ReleaseDC(0, screen);
    throw new Error('capture-bitmap');
  }
  const previous = SelectObject(memory, bitmap);
  try {
    if (!PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT)) throw new Error('print-window');
    const bgra = Buffer.alloc(width * height * 4);
    const header = {
      biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
      biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    };
    if (GetDIBits(memory, bitmap, 0, height, bgra, header, 0) !== height) throw new Error('capture-dibits');
    return { width, height, bgra };
  } finally {
    SelectObject(memory, previous);
    DeleteObject(bitmap);
    DeleteDC(memory);
    ReleaseDC(0, screen);
  }
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
 * `count` left clicks at `x`,`y` — device pixels of the window, converted to screen once here.
 * Each click is a 60 ms press, and the foreground is re-asserted before every one, so a focus
 * change between clicks refuses the rest instead of clicking into another app.
 */
export async function tap(hwnd, x, y, count) {
  for (let i = 0; i < count; i++) {
    requireForeground(hwnd);
    const rect = windowRect(hwnd);
    if (!rect) throw new Error('window-rect');
    if (!SetCursorPos(rect.left + Math.round(x), rect.top + Math.round(y))) throw new Error('set-cursor');
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
