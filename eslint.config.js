import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Pure packages run unchanged on the server, the offline client and in tests (ARCHITECTURE §2).
const PURE = [
  'packages/game-sdk/src/core/**',
  'packages/game-sdk/src/engine/**',
  'packages/protocol/src/**',
  'packages/sync/src/**',
  'packages/games/*/src/logic/**',
  'packages/games/*/src/bot/**',
];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/.expo/**',
      '**/drizzle/**',
      'spikes/**',
      '.isolated/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.es2023 } } },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: PURE,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react/*',
                'react-*',
                'expo',
                'expo-*',
                '@expo/*',
                '@shopify/*',
                'node:*',
                'fs',
                'path',
                'os',
                'crypto',
              ],
              message: 'Pure logic packages must not import platform, UI or Node modules.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'localStorage',
        'setTimeout',
        'setInterval',
        'performance',
        'process',
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Use the injected Rng.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use ctx.now.',
        },
        { selector: "NewExpression[callee.name='Date']", message: 'Use ctx.now.' },
      ],
    },
  },
  {
    files: ['*.config.*', '**/*.config.*', 'scripts/**', 'apps/server/**', 'packages/db/**'],
    languageOptions: { globals: { ...globals.node } },
  },
);
