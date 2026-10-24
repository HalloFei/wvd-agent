/**
 * Test-only Win32 stand-in for the engine child's snapshot test.
 *
 * The child answers `capture` only when `findWindow` finds a window, and the test is not allowed a
 * real one. The loader registered by `fake-win32-loader.mjs` resolves `./win32-native.mjs` to this
 * module in the child process *and in its workers*, so the protocol, the two render threads, the
 * scaler and the encoder are all the real thing; only the Win32 surface is fake.
 *
 * The frame is a deterministic 192×108 BGRA quartet, so a scaled reply is checked against known
 * sizes and contents without a screen.
 */

export class Refused extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'Refused';
    this.detail = detail;
  }
}

const WIDTH = 192;
const HEIGHT = 108;

export function findWindow() {
  return 1;
}

export function isForeground() {
  return true;
}

export function registerStopHotkey() {
  return { ok: true };
}

export function unregisterStopHotkey() {}

export function pollStopHotkey() {
  return 0;
}

export function releaseHeld() {}

export async function tap() {}

export async function holdKey() {}

export function releaseCaptureSurface() {}

export function captureClient(_hwnd, target = null) {
  const size = WIDTH * HEIGHT * 4;
  const pixels = target && target.length >= size ? target.subarray(0, size) : Buffer.allocUnsafe(size);
  const colours = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 255, 255]];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const colour = colours[(y < HEIGHT / 2 ? 0 : 2) + (x < WIDTH / 2 ? 0 : 1)];
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = 255;
    }
  }
  return { width: WIDTH, height: HEIGHT, bgra: pixels };
}
