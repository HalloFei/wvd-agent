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
  },
});
