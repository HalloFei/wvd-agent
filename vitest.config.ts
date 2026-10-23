import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * In tests `cortico/*` resolves to the Coopanion checkout's framework source, the same mapping as
 * tsconfig paths. Installed into Coopanion the host's module hook does this instead.
 */
const FRAMEWORK_SRC = fileURLToPath(new URL('../../../Coopanion/vendor/cortico/src/', import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }] },
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
  },
});
