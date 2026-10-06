import { defineConfig } from 'vitest/config';

// Tests run against a real Postgres 17 (embedded-postgres), one cluster per test file.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
