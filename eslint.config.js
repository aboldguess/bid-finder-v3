import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'data/', 'data-demo/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  { files: ['src/web/public/**'], languageOptions: { globals: globals.browser } },
];
