/**
 * `--import` entry for the child's snapshot test. It registers the resolve hook that swaps Win32 for
 * the fake in the child and in the worker threads it spawns (workers inherit `process.execArgv`).
 */
import { register } from 'node:module';

register(new URL('./fake-win32-hooks.mjs', import.meta.url).href);
