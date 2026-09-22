import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pruebas de componentes y utilidades. No hay plugin de React: esbuild
// compila el JSX con el runtime automático, igual que Next.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
  },
});
