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
      'eslint.config.mjs',
      'commitlint.config.cjs',
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
            // engine: orchestration over contracts, domain, db, adapters, infra, dify.
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
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@nestjs/common', '@nestjs/core', 'drizzle-orm', 'ioredis', 'bullmq'],
          patterns: ['@actionow/db', '@actionow/infra', '@actionow/adapters'],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  prettier,
);
