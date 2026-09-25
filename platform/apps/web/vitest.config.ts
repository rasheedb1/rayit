import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pruebas de componentes y utilidades. No hay plugin de React: esbuild
// compila el JSX con el runtime automático, igual que Next.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `server-only` lanza fuera de un Server Component; en Node se vacía.
      "server-only": fileURLToPath(new URL("./lib/testing/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
    // 15 s y no los 5 de vitest: con la máquina cargada (varios agentes y
    // `pnpm verificar` en paralelo) la primera prueba de un archivo carga
    // con el import y la compilación de sus componentes, y en la
    // integración de VEN-11 r4 se pasó de 5 s sin que nada estuviera mal.
    // Una prueba colgada sigue fallando; solo deja de fallar la lenta.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
