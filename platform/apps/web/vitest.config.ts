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
    // Las pruebas que importan un módulo entero (una página, unas acciones) tardan en transformar la primera vez;
    // con varios agentes a la vez en la máquina (carga 50-60) pasaban de los 5 s por defecto sin fallar de verdad.
    testTimeout: 20_000,
  },
});
