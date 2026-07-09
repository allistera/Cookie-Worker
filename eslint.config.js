import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', '.wrangler/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
