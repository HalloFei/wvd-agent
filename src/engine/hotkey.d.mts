/** Types of the `.mjs` stop-hotkey parser (hotkey.mjs). */

export interface ParsedHotkey {
  /** MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WIN, never zero. */
  readonly mods: number;
  /** Windows virtual-key code of the one key. */
  readonly vk: number;
}

export declare function parseHotkey(text: string): ParsedHotkey | null;
