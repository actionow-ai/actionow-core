import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Integration tests (`*.int.test.ts`) spin up Testcontainers, so allow ample
  // time for image pull + container startup in `beforeAll` hooks.
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000, hookTimeout: 180000 },
});
