// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'server/prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Money is never a JS number (00 §6, 01 §10).
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is decimal.js. Use money()/round2() from lib/money.' },
      ],
    },
  },
);
