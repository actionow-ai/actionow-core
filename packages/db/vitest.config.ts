import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    // Integration tests spin Testcontainers; run files sequentially so concurrent
    // containers don't exhaust Docker (full-suite reliability).
    fileParallelism: false,
  },
});
