/**
 * The stop-hotkey parser, kept apart from the Win32 bindings so it can be tested without loading
 * koffi or user32. A hotkey is modifiers plus exactly one key: `Ctrl+Alt+W`, never a bare `W`,
 * because a bare letter registered globally would swallow that key from every other program.
 */

const MOD_ALT = 0x1;
const MOD_CONTROL = 0x2;
const MOD_SHIFT = 0x4;
const MOD_WIN = 0x8;

const MODIFIERS = new Map([
  ['ctrl', MOD_CONTROL], ['control', MOD_CONTROL], ['alt', MOD_ALT], ['shift', MOD_SHIFT],
  ['win', MOD_WIN], ['windows', MOD_WIN], ['meta', MOD_WIN],
]);

/**
 * `Ctrl+Alt+W` → `{ mods, vk }`; null for anything else, including a key with no modifier and a
 * combination with two keys. A typo fails registration loudly instead of registering something
 * surprising.
 */
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
  return vk === 0 || mods === 0 ? null : { mods, vk };
}
