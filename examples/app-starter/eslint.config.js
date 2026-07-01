import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', Response: 'readonly', Buffer: 'readonly', setTimeout: 'readonly' },
    },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] },
  },
  { ignores: ['node_modules'] },
];
