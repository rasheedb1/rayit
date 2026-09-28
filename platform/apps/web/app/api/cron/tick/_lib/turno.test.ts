// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import type { TickSummary } from "@mc/worker/tick";
import { esRutaPublica } from "@/lib/auth/rutas";
import { bearerMatches, createTickHandler, CRON_SECRET_MIN_LENGTH, TICK_BUDGET_MS, tickLogLine } from "./turno";

const SECRETO = "a3f1".repeat(16); // 64 caracteres, como `openssl rand -hex 32`

const RESUMEN: TickSummary = {
  at: "2026-09-28T15:02:00.000Z",
  budgetMs: TICK_BUDGET_MS,
  elapsedMs: 812,
  ran: [{ job: "outbound.dispatch", reason: "due", status: "ok", processed: 3, failed: 0, durationMs: 640, cut: false }],
  left: [{ job: "outbound.generate", reason: "budget" }],
  upToDate: 12,
  exhausted: [],
  failedRuns: 0,
};

/** El secreto va explícito: con un valor por defecto, montar(undefined) probaría el bueno. */
function montar(secret: string | undefined) {
  const run = vi.fn<(budgetMs: number) => Promise<TickSummary>>(async () => RESUMEN);
  const log = vi.fn();
  const logError = vi.fn();
  return { run, log, logError, handler: createTickHandler({ secret: () => secret, run, log, logError }) };
}

const pedir = (method: "GET" | "POST", authorization?: string) =>
  new Request("https://on-cue.test/api/cron/tick", { method, headers: authorization ? { authorization } : {} });

describe("la ruta del turno (CIM-7)", () => {
  test("sin Bearer: 401 vacío, y no corre nada", async () => {
    const { handler, run } = montar(SECRETO);
    const res = await handler(pedir("POST"));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(run).not.toHaveBeenCalled();
  });

  test("con un Bearer malo, uno casi igual o con otro esquema: el mismo 401", async () => {
    const { handler, run } = montar(SECRETO);
    for (const auth of [`Bearer ${"b".repeat(64)}`, `Bearer ${SECRETO.slice(0, -1)}`, `Bearer ${SECRETO}x`, `Basic ${SECRETO}`, SECRETO, `Bearer  ${SECRETO}`, "Bearer "]) {
      const res = await handler(pedir("POST", auth));
      expect(res.status, auth).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("con el Bearer bueno, por POST (pg_cron) y por GET (Vercel Cron): corre un turno de 45 s y devuelve el resumen", async () => {
    const { handler, run, log } = montar(SECRETO);
    for (const method of ["POST", "GET"] as const) {
      const res = await handler(pedir(method, `Bearer ${SECRETO}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RESUMEN);
    }
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(TICK_BUDGET_MS);
    expect(log).toHaveBeenCalledTimes(2);
    const linea = log.mock.calls[0]![0] as string;
    expect(linea).not.toContain("\n");
    expect(JSON.parse(linea)).toMatchObject({ ran: ["outbound.dispatch:ok:3/0:640ms"], left: ["outbound.generate:budget"], upToDate: 12 });
  });

  test("sin CRON_SECRET en el servidor, o con uno corto, nadie entra: ni con la cadena vacía", async () => {
    for (const secret of [undefined, "", "corto"]) {
      const { handler, run, logError } = montar(secret);
      for (const auth of [undefined, "Bearer ", `Bearer ${secret ?? ""}`, `Bearer ${SECRETO}`]) {
        expect((await handler(pedir("POST", auth))).status).toBe(401);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalled();
    }
    expect(bearerMatches(`Bearer ${"x".repeat(CRON_SECRET_MIN_LENGTH - 1)}`, "x".repeat(CRON_SECRET_MIN_LENGTH - 1))).toBe(false);
    expect(bearerMatches(`Bearer ${"x".repeat(CRON_SECRET_MIN_LENGTH)}`, "x".repeat(CRON_SECRET_MIN_LENGTH))).toBe(true);
  });

  test("si el turno falla, 500 sin detalles para quien llama; el error va al log", async () => {
    const logError = vi.fn();
    const handler = createTickHandler({
      secret: () => SECRETO,
      run: async () => { throw new Error("password authentication failed for user mc_worker_login"); },
      log: vi.fn(),
      logError,
    });
    const res = await handler(pedir("POST", `Bearer ${SECRETO}`));
    expect(res.status).toBe(500);
    const cuerpo = await res.text();
    expect(cuerpo).toBe(JSON.stringify({ ok: false }));
    expect(logError).toHaveBeenCalledWith("el turno no pudo correr", expect.any(Error));
  });

  test("la ruta no pide sesión (la protege su Bearer) y el resumen del log es una línea", () => {
    expect(esRutaPublica("/api/cron/tick")).toBe(true);
    expect(tickLogLine({ ...RESUMEN, ran: [{ ...RESUMEN.ran[0]!, cut: true, status: "failed" }] })).toContain("outbound.dispatch:failed(cortado)");
  });
});
