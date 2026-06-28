import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.turbo/**',
      '**/drizzle/**',
      '**/src/generated/**',
      'packages/contracts/scripts/**',
      'eslint.config.mjs',
      'commitlint.config.cjs',
      '**/vite.config.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    plugins: {
      'import-x': importX,
      'simple-import-sort': simpleImportSort,
      boundaries,
    },
    settings: {
      // Resolve `@actionow/<name>` imports to `packages/<name>/src/...` so
      // boundaries (which relies on the import resolver via
      // eslint-module-utils) can classify the import target by element type.
      // eslint-module-utils reads the legacy `import/resolver` settings key.
      // The typescript resolver maps `@actionow/*` to `packages/*/src` via the
      // referenced tsconfigs + each package's `main: src/index.ts`, which makes
      // cross-package imports resolvable even where pnpm has not symlinked the
      // (intentionally undeclared) dependency.
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'],
        },
        node: true,
      },
      // Capture-based, file-mode elements classify EVERY file under a package
      // (including nested files like packages/db/src/schema/index.ts) and
      // expose the package/app name via `capture` for use in element-types.
      'boundaries/elements': [
        { type: 'pkg', pattern: 'packages/*/**', mode: 'file', capture: ['package'] },
        { type: 'app', pattern: 'apps/*/**', mode: 'file', capture: ['app'] },
      ],
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: '^I[A-Z]', match: false },
        },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      // Enforce the §14.5 dependency table. Elements are captured by package
      // name, so `from`/`allow` are matched on the `package` capture. A package
      // may always import its own files (same package name).
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // contracts: leaf — may only import its own files.
            {
              from: [['pkg', { package: 'contracts' }]],
              allow: [['pkg', { package: 'contracts' }]],
            },
            // domain: contracts only.
            {
              from: [['pkg', { package: 'domain' }]],
              allow: [['pkg', { package: 'domain' }]],
            },
            {
              from: [['pkg', { package: 'domain' }]],
              allow: [['pkg', { package: 'contracts' }]],
            },
            // db: contracts, domain.
            {
              from: [['pkg', { package: 'db' }]],
              allow: [
                ['pkg', { package: 'db' }],
                ['pkg', { package: 'contracts' }],
                ['pkg', { package: 'domain' }],
              ],
            },
            // infra: contracts.
            {
              from: [['pkg', { package: 'infra' }]],
              allow: [
                ['pkg', { package: 'infra' }],
                ['pkg', { package: 'contracts' }],
              ],
            },
            // adapters: contracts, domain, infra.
            {
              from: [['pkg', { package: 'adapters' }]],
              allow: [
                ['pkg', { package: 'adapters' }],
                ['pkg', { package: 'contracts' }],
                ['pkg', { package: 'domain' }],
                ['pkg', { package: 'infra' }],
              ],
            },
            // dify: contracts, domain, infra.
            {
              from: [['pkg', { package: 'dify' }]],
              allow: [
                ['pkg', { package: 'dify' }],
                ['pkg', { package: 'contracts' }],
                ['pkg', { package: 'domain' }],
                ['pkg', { package: 'infra' }],
              ],
            },
            // engine: orchestration over contracts, domain, db, adapters, infra, dify, payments.
            {
              from: [['pkg', { package: 'engine' }]],
              allow: [
                ['pkg', { package: 'engine' }],
                ['pkg', { package: 'contracts' }],
                ['pkg', { package: 'domain' }],
                ['pkg', { package: 'db' }],
                ['pkg', { package: 'adapters' }],
                ['pkg', { package: 'infra' }],
                ['pkg', { package: 'dify' }],
                // PaymentService (engine) orchestrates the provider registry types.
                ['pkg', { package: 'payments' }],
              ],
            },
            // apps (api, worker): any package + any app.
            {
              from: [['app', {}]],
              allow: [
                ['pkg', {}],
                ['app', {}],
              ],
            },
          ],
        },
      ],
    },
  },
  // Deterministic enforcement of the §14.5 import boundary table.
  //
  // `boundaries/element-types` (above) can only classify *resolved* targets,
  // so a type-only or otherwise unresolved import of an undeclared workspace
  // package can slip through. `no-restricted-imports` matches the import
  // *specifier string* regardless of resolution, so it deterministically
  // rejects forbidden cross-package edges — including `import type`.
  //
  // For each source package below, `patterns` forbids every `@actionow/*`
  // package that package may NOT import per §14.5 (both the bare specifier and
  // its subpaths, e.g. `@actionow/db/schema`). A package never needs to forbid
  // its own name (internal imports are relative). The `files` glob covers the
  // whole package (`**/*.ts`) so test files are linted too. `engine` may use
  // every lib and `apps/**` may import everything, so neither is restricted
  // here.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/domain',
            '@actionow/domain/*',
            '@actionow/db',
            '@actionow/db/*',
            '@actionow/adapters',
            '@actionow/adapters/*',
            '@actionow/dify',
            '@actionow/dify/*',
            '@actionow/infra',
            '@actionow/infra/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/infra/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/domain',
            '@actionow/domain/*',
            '@actionow/db',
            '@actionow/db/*',
            '@actionow/adapters',
            '@actionow/adapters/*',
            '@actionow/dify',
            '@actionow/dify/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/adapters',
            '@actionow/adapters/*',
            '@actionow/dify',
            '@actionow/dify/*',
            '@actionow/infra',
            '@actionow/infra/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/db',
            '@actionow/db/*',
            '@actionow/dify',
            '@actionow/dify/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/dify/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/db',
            '@actionow/db/*',
            '@actionow/adapters',
            '@actionow/adapters/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  // domain: contracts only. Keeps the pre-existing third-party blacklist and
  // extends the `@actionow/*` patterns to forbid every non-contracts lib
  // (now including dify + engine).
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@nestjs/common', '@nestjs/core', 'drizzle-orm', 'ioredis', 'bullmq'],
          patterns: [
            '@actionow/db',
            '@actionow/db/*',
            '@actionow/infra',
            '@actionow/infra/*',
            '@actionow/adapters',
            '@actionow/adapters/*',
            '@actionow/dify',
            '@actionow/dify/*',
            '@actionow/engine',
            '@actionow/engine/*',
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  // Frontend app (React + browser): the strict-type-checked rules tuned for the
  // backend libs are too aggressive for a UI app. Components don't annotate
  // every return type, `() => setState(x)` handlers return void by design, and
  // `getElementById('root')!` is the idiomatic mount. Browser globals enabled.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A <DataTable> that takes `loading` MUST also take `error`: otherwise a
      // failed (or failed-on-refetch) query renders an empty table instead of a
      // retry state. Pass error={query.isError} + onRetry={() => void refetch()}.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXOpeningElement[name.name='DataTable']:has(JSXAttribute[name.name='loading']):not(:has(JSXAttribute[name.name='error']))",
          message:
            'A <DataTable> with `loading` must also pass `error` (wire it to the query’s isError) so a failed fetch surfaces a retry state instead of an empty table. Add error={query.isError} + onRetry={() => void refetch()}.',
        },
      ],
    },
  },
  // Test setup / polyfills (e.g. a jsdom matchMedia shim) legitimately use empty
  // stubs and runtime guards the type system thinks are unnecessary.
  {
    files: ['apps/web/**/test/**', 'apps/web/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  prettier,
);
