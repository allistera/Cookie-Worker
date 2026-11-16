import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', '.wrangler/**'],
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  // A type-aware @typescript-eslint/no-floating-promises block belongs here,
  // but typescript-eslint (8.x) caps its TypeScript peer at <6.1 and this
  // repo typechecks with TypeScript 7 (the native compiler), whose JS API
  // typescript-eslint cannot drive yet. npm also refuses to nest a second
  // TypeScript to satisfy the peer. Revisit when typescript-eslint supports
  // TS 7; until then floating promises are covered by review convention:
  // every Promise is awaited, returned, or handed to ctx.waitUntil().
];
