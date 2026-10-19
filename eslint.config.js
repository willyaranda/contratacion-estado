import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dump/**', 'docs/**', 'coverage/**', 'transparencia/*.html', 'transparencia/data.json'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // script del navegador (se incrusta en las páginas)
    files: ['transparencia/analytics.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
