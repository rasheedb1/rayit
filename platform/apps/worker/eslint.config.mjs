// Reglas del worker. La que importa: nada de console.* suelto. Todo lo
// que se imprime pasa por src/runner/logger.ts, que redacta secretos y
// escribe JSON por línea.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['node_modules/**', 'dist/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-console': 'error',
      'no-debugger': 'error',
      'eqeqeq': ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': ['error', {
        // node:test devuelve promesas que el runner ya administra.
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Los dobles de los canales (FakeGmail, FakeUnipile) solo en las pruebas: un job
  // que los importara compilaría sin aviso y refrescaría tokens falsos (VEN-9).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@mc/connectors/testing', message: 'Los dobles de @mc/connectors/testing son solo para las pruebas (test/, *.test.ts).' }],
      }],
    },
  },
];
