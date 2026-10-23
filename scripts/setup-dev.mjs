#!/usr/bin/env node
/**
 * Links the Coopanion framework sources into `node_modules/cortico`, so `cortico/*` imports resolve
 * for tsc and vitest from any checkout location. The target is `CORTICO_SRC` when set, otherwise
 * the first `Coopanion/vendor/cortico/src` found by walking up from the repository root and from
 * its git directory: a worktree's git directory sits inside the umbrella checkout even when the
 * worktree itself lives elsewhere.
 */
import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const LINK = join(ROOT, 'node_modules', 'cortico');
const SIBLING = join('Coopanion', 'vendor', 'cortico', 'src');
const MARKER = 'world.ts';

const fail = (message) => {
  console.error(`setup-dev: ${message}`);
  process.exit(1);
};

const isFramework = (dir) => {
  try {
    return statSync(join(dir, MARKER)).isFile();
  } catch {
    return false;
  }
};

const searchUp = (start, relative) => {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, relative);
    if (isFramework(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** The git directory this checkout uses, and for a worktree or submodule its umbrella's too. */
const gitStartDirs = (root) => {
  const dotGit = join(root, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return [];
  }
  if (stat.isDirectory()) return [dotGit];
  if (!stat.isFile()) return [];
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  return match ? [resolve(root, match[1].trim())] : [];
};

const requested = (process.env.CORTICO_SRC ?? '').trim();
let target;
if (requested) {
  target = resolve(requested);
  if (!isFramework(target)) {
    fail(`CORTICO_SRC points at ${target}, which is not the framework source (no ${MARKER} in it)`);
  }
} else {
  const starts = [ROOT, ...gitStartDirs(ROOT)];
  for (const start of starts) {
    target = searchUp(start, SIBLING);
    if (target) break;
  }
  if (!target) {
    fail(`no ${SIBLING} (with ${MARKER}) found by searching upward from ${starts.join(' and ')}; `
      + 'set CORTICO_SRC to the framework\'s src directory');
  }
}

const samePath = (left, right) => {
  const normalize = (value) => {
    const resolved = resolve(String(value).replace(/^\\\\\?\\/, ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

mkdirSync(join(ROOT, 'node_modules'), { recursive: true });
const existing = lstatSync(LINK, { throwIfNoEntry: false });
if (existing) {
  if (!existing.isSymbolicLink()) {
    fail(`${LINK} exists and is not a link; remove it so the framework sources can be linked`);
  }
  if (samePath(readlinkSync(LINK), target)) process.exit(0);
  unlinkSync(LINK);
}
symlinkSync(target, LINK, 'junction');
console.log(`setup-dev: cortico/* -> ${target}`);
