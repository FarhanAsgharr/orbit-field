import { defineConfig } from 'vitest/config';

/**
 * Root test config.
 *
 * The admin dashboard is excluded here because it needs a jsdom environment and
 * a React plugin; it carries its own `vitest.config.ts` and is run by its own
 * workspace script. Running it from the root would execute browser tests in a
 * node environment, where every render throws.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/backend/**/*.test.ts', 'apps/mobile/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/admin-dashboard/**'],
  },
});
