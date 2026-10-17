import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite (PostgreSQL v procesu) se při paralelním běhu více souborů spouští pomaleji.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
  },
});
