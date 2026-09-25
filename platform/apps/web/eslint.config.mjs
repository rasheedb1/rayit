import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  { ignores: [".next/**", "node_modules/**"] },
  {
    // @mc/db/worker marca una transacción como del worker (WorkerSql): es lo
    // que impide llamar al despachador desde la web. La web que de verdad
    // necesita el rol del worker usa asWorker (VEN-10 r3).
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "@mc/db/worker", message: "@mc/db/worker es solo del worker: la web usa asWorker de @mc/db." }],
      }],
    },
  },
  // Los dobles de los canales (FakeGmail, FakeUnipile) solo en las pruebas: en una
  // pantalla o una ruta compilarían sin aviso y conectarían canales falsos (VEN-9).
  // En flat config la regla del bloque que casa después reemplaza a la de arriba,
  // así que este bloque repite la de @mc/db/worker (integración de la fase 4).
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "test/**", "vitest.setup.ts", "vitest.config.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "@mc/connectors/testing", message: "Los dobles de @mc/connectors/testing son solo para *.test.*." },
          { name: "@mc/db/worker", message: "@mc/db/worker es solo del worker: la web usa asWorker de @mc/db." },
        ],
      }],
    },
  },
];
