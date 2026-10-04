// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TICK_BUDGET_MS, TICK_CLOSE_MS, TICK_SIGNATURE_HEADER, TICK_TIMESTAMP_HEADER, tickSignature } from "./turno";

/**
 * route.ts carga el worker solo después de comprobar el Bearer (CIM-7):
 * la URL es pública y un 401 no debe pagar el arranque en frío de
 * @mc/worker/tick (todos los handlers, los conectores y el SDK).
 *
 * El módulo del worker se sustituye por uno que anota cuándo se carga:
 * vi.mock no lo evalúa hasta que alguien lo importa, así que «cargado» es
 * exactamente «route.ts lo importó».
 */
const worker = vi.hoisted(() => ({ cargado: 0, llamadas: [] as unknown[] }));
vi.mock("@mc/worker/tick", () => {
  worker.cargado++;
  return {
    runTickFromEnv: async (opts: unknown) => {
      worker.llamadas.push(opts);
      return { at: "2026-09-28T15:00:00.000Z", budgetMs: TICK_BUDGET_MS, elapsedMs: 5, ran: [], left: [], upToDate: 0, exhausted: [], failedRuns: 0, planMs: 3, orphanedBossJobs: null };
    },
  };
});

const SECRETO = "c0de".repeat(16);
const pedir = (authorization?: string) =>
  new Request("https://on-cue.test/api/cron/tick", { method: "POST", headers: authorization ? { authorization } : {} });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("route.ts del turno", () => {
  test("un 401 no carga el worker; el Bearer bueno sí, y corre un turno de TICK_BUDGET_MS", async () => {
    vi.stubEnv("CRON_SECRET", SECRETO);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ruta = await import("../route");
    expect(ruta.maxDuration).toBe(60);
    expect(ruta.runtime).toBe("nodejs");

    for (const auth of [undefined, "Bearer otro", `Basic ${SECRETO}`]) {
      expect((await ruta.POST(pedir(auth))).status).toBe(401);
      expect((await ruta.GET(pedir(auth))).status).toBe(401);
    }
    expect(worker.cargado, "ningún 401 importó @mc/worker/tick").toBe(0);

    const res = await ruta.POST(pedir(`Bearer ${SECRETO}`));
    expect(res.status).toBe(200);
    expect(worker.cargado).toBe(1);
    expect(worker.llamadas).toEqual([{ budgetMs: TICK_BUDGET_MS }]);
  });

  test("la firma del cron de Supabase entra por route.ts con el reloj del servidor; una caducada o futura es 401 y no corre ningún turno", async () => {
    vi.stubEnv("CRON_SECRET", SECRETO);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ruta = await import("../route");
    const firmada = (ts: number) =>
      new Request("https://on-cue.test/api/cron/tick", {
        method: "POST",
        headers: { [TICK_TIMESTAMP_HEADER]: String(ts), [TICK_SIGNATURE_HEADER]: tickSignature(String(ts), SECRETO) },
      });
    const ahora = Math.floor(Date.now() / 1000);
    const turnosAntes = worker.llamadas.length;
    expect((await ruta.POST(firmada(ahora - 120))).status).toBe(401);
    expect((await ruta.POST(firmada(ahora + 120))).status).toBe(401);
    expect(worker.llamadas.length, "ningún 401 corrió un turno").toBe(turnosAntes);
    expect((await ruta.POST(firmada(ahora))).status).toBe(200);
    expect(worker.llamadas.length).toBe(turnosAntes + 1);
    expect(worker.llamadas.at(-1)).toEqual({ budgetMs: TICK_BUDGET_MS });
  });

  test("route.ts no importa del worker nada que no sea un tipo (lo demás, con import dinámico)", () => {
    const fuente = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "route.ts"), "utf8");
    const estaticos = [...fuente.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(estaticos.filter((p) => p?.startsWith("@mc/worker"))).toEqual([]);
    expect(fuente).toMatch(/await import\("@mc\/worker\/tick"\)/);
  });

  test("TICK_CLOSE_MS de la ruta es el del worker (la espera del 504 depende de los dos)", async () => {
    const real = await vi.importActual<typeof import("@mc/worker/tick")>("@mc/worker/tick");
    expect(TICK_CLOSE_MS).toBe(real.TICK_CLOSE_MS);
  });
});
