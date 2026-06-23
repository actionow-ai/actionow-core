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
    // `unplugin-swc`'s vite plugin compiles with `emitDecoratorMetadata` so
    // NestJS DI works under vitest (esbuild alone drops the metadata).
    // Cast through unknown→never: unplugin-swc's Plugin type is structurally
    // compatible but doesn't unify with the resolved vite PluginOption union when
    // multiple vite versions are hoisted in the monorepo, and `vite` isn't a
    // direct dep here so PluginOption can't be named. `never` is assignable to the
    // PluginOption[] element, keeping the config valid + skew-proof.
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }) as unknown as never,
  ],
});
