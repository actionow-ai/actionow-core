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
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/*' },
        { type: 'domain', pattern: 'packages/domain/*' },
        { type: 'db', pattern: 'packages/db/*' },
        { type: 'adapters', pattern: 'packages/adapters/*' },
        { type: 'dify', pattern: 'packages/dify/*' },
        { type: 'infra', pattern: 'packages/infra/*' },
        { type: 'app', pattern: 'apps/*' },
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
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'contracts', allow: [] },
            { from: 'domain', allow: ['contracts'] },
            { from: 'db', allow: ['contracts', 'domain'] },
            { from: 'infra', allow: ['contracts'] },
            { from: 'adapters', allow: ['contracts', 'domain', 'infra'] },
            { from: 'dify', allow: ['contracts', 'domain', 'infra'] },
            { from: 'app', allow: ['contracts', 'domain', 'db', 'adapters', 'dify', 'infra'] },
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
        { paths: ['@nestjs/common', '@nestjs/core', 'drizzle-orm', 'ioredis', 'bullmq'] },
        { patterns: ['@actionow/db', '@actionow/infra', '@actionow/adapters'] },
      ],
    },
  },
  { files: ['**/*.spec.ts', '**/*.test.ts'], rules: { '@typescript-eslint/no-unsafe-assignment': 'off' } },
  prettier,
);
