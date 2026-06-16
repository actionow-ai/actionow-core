import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests (`*.int.test.ts`) spin up Testcontainers, so allow ample
  // time for image pull + container startup, and run files sequentially so
  // concurrent containers don't exhaust Docker.
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    fileParallelism: false,
  },
});
