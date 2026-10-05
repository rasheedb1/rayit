import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { PRUEBA_TIMEOUT_MS } from "./lib/testing/tiempos";

/**
 * Cuántos procesos de vitest a la vez (CIM-12). Por omisión vitest abre
 * uno por núcleo menos uno (10 en una máquina de 11), y cada uno carga
 * jsdom, compila sus componentes y abre su base embebida. Con dos
 * `pnpm verificar` a la vez eran 20 procesos en 11 núcleos, con cuatro
 * más de 40, y las pruebas daban rojo por tiempo (beforeAll, el RPC
 * «Timeout calling onTaskUpdate» de vitest) sin que nada estuviera mal.
 * Un tercio de los núcleos, y nunca menos de dos: pnpm verificar deja
 * dos a la vez en toda la máquina (scripts/verificar.sh) y turbo corre
 * otra tarea al lado de esta, así que en 11 núcleos quedan 2 × 3 procesos
 * de vitest más dos tareas. Medido sin carga (5-oct): 41 s con 10, 58 s
 * con 3, 84 s con 2. MC_TEST_WORKERS lo fija a mano.
 */
const PROCESOS = Number(process.env.MC_TEST_WORKERS) || Math.max(2, Math.floor(availableParallelism() / 3));

/**
 * El reloj de las pruebas (scripts/pruebas/reloj.mjs, CIM-12): cada
 * proceso de vitest lo carga antes que nada, así que Date y el now() de
 * la base embebida dicen el día del ancla y no el de la máquina. El
 * origen se fija aquí, una vez por `vitest run`, para que todos los
 * procesos compartan el mismo reloj (la demo la siembra uno y la cargan
 * los demás). performance y no Date: este proceso no lleva el reloj movido.
 */
const RELOJ = fileURLToPath(new URL("../../scripts/pruebas/reloj.mjs", import.meta.url));
process.env.MC_RELOJ_ORIGEN ??= String(Math.round(performance.timeOrigin + performance.now()));

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
    // Fija la corrida: la demo sembrada se siembra una vez y se comparte.
    globalSetup: ["./vitest.global-setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next"],
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: PROCESOS, execArgv: ["--import", RELOJ] } },
    // 20 s y no los 5 de vitest: la primera prueba de un archivo carga con
    // el import y la compilación de sus componentes. Los hooks que abren
    // la base y las pruebas que la consultan llevan su constante de
    // lib/testing/tiempos.ts; ningún archivo lleva un número propio.
    testTimeout: PRUEBA_TIMEOUT_MS,
    hookTimeout: PRUEBA_TIMEOUT_MS,
  },
});
