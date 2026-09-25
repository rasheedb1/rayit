// Las mismas reglas que apps/worker: nada de console.* suelto, sin any,
// promesas siempre esperadas. Este paquete no imprime nunca: recibe un
// logger y lo demás lo devuelve como valores o errores tipados.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['node_modules/**', 'dist/**', 'fixtures/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
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
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'before', 'after', 'beforeEach', 'afterEach'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // FakeGmail y FakeUnipile viven en src/testing y salen por @mc/connectors/testing:
  // ningún archivo de producción del paquete los importa (VEN-9).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/testing/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@mc/connectors/testing', message: 'Los dobles son solo para las pruebas.' }],
        patterns: [{ group: ['**/testing/fake-*', '**/testing/index.ts'], message: 'Los dobles son solo para las pruebas.' }],
      }],
    },
  },
];
