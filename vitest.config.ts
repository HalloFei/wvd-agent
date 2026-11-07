import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `cortico/*` resolves through the `node_modules/cortico` link that scripts/setup-dev.mjs creates,
 * the same files tsconfig.json gives tsc. Installed into Coopanion, the host's module hook resolves
 * the prefix instead.
 */
const FRAMEWORK_SRC = fileURLToPath(new URL('./node_modules/cortico/', import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }] },
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
    /**
     * Files run **one at a time**, so the repo's gate (`pnpm test` = plain `vitest run`) is green on
     * this host with no hand-set environment or extra flag. The reason is load, measured 2026-11-07:
     * the numerals corpus (`tests/readers-corpus.test.ts`, Task 5) performs 24 **real** OCR reads, and
     * under parallel forks those reads slow the whole machine enough to push two pre-existing,
     * load-sensitive timing files over their assertions — `engine-child-snapshot` (asserts a capture
     * aged under 200 ms) and `qte-band` (asserts a decode against a frame-time budget) — and to
     * stretch single OCR calls from ~2.5-5 s to 10-13 s. Their assertions are untouched; only how many
     * files share the host at once changes. The cost is wall time (the suite measured ~6 min
     * serialised); the benefit is that "green" no longer depends on an idle machine or a typed flag.
     * If a future suite is fast enough, this is the line to measure and remove.
     */
    fileParallelism: false,
  },
});
