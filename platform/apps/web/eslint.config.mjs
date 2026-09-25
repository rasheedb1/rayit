import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**"] },
  // Los dobles de los canales (FakeGmail, FakeUnipile) solo en las pruebas: en una
  // pantalla o una ruta compilarían sin aviso y conectarían canales falsos (VEN-9).
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "test/**", "vitest.setup.ts", "vitest.config.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "@mc/connectors/testing", message: "Los dobles de @mc/connectors/testing son solo para *.test.*." }],
      }],
    },
  },
];
