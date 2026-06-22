import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS DI reads `design:paramtypes` decorator metadata to resolve constructor
 * dependencies. Vitest's default esbuild transform does not emit it, so the
 * controllers/services would fail to instantiate under `Test`. `unplugin-swc`
 * compiles with `emitDecoratorMetadata` enabled, matching `tsc`/`nest build`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    // Many e2e files each spin their own Testcontainers (pg/redis/minio); running
    // them in parallel exhausts Docker. Run files sequentially for reliability.
    fileParallelism: false,
  },
  plugins: [
    // `unplugin-swc`'s vite plugin type skews against vitest's bundled vite
    // `Plugin` declaration (two copies of vite's types resolve here); the value
    // is a valid plugin at runtime. `vite` isn't a direct dep so its type can't
    // be imported to cast — suppress the test-only config type mismatch.
    // @ts-expect-error -- vite Plugin type skew between unplugin-swc and vitest
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
