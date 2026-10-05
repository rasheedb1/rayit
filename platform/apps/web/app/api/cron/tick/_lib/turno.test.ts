// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { TickSummary } from "@mc/worker/tick";
import { esRutaPublica } from "@/lib/auth/rutas";
import {
  bearerMatches, createTickHandler, CRON_SECRET_MIN_LENGTH, signatureMatches, TICK_BUDGET_MS, TICK_SIGNATURE_HEADER,
  TICK_SIGNATURE_WINDOW_S, TICK_TIMESTAMP_HEADER, tickLogLine, tickSignature,
} from "./turno";

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
  planMs: 41,
  orphanedBossJobs: null,
};

/** El secreto va explícito: con un valor por defecto, montar(undefined) probaría el bueno. */
function montar(secret: string | undefined) {
  const run = vi.fn<(budgetMs: number) => Promise<TickSummary>>(async () => RESUMEN);
  const log = vi.fn();
  const logError = vi.fn();
  return { run, log, logError, handler: createTickHandler({ secret: () => secret, run, log, logError, waitMs: 1_000 }) };
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

  test("el esquema no distingue mayúsculas (RFC 9110 §11.1): «bearer» o «BEARER» de un proxy también entran", async () => {
    const { handler, run } = montar(SECRETO);
    for (const auth of [`bearer ${SECRETO}`, `BEARER ${SECRETO}`]) {
      expect((await handler(pedir("POST", auth))).status, auth).toBe(200);
    }
    expect(run).toHaveBeenCalledTimes(2);
    // El secreto sí distingue: solo el esquema es insensible.
    expect(bearerMatches(`bearer ${SECRETO.toUpperCase()}`, SECRETO)).toBe(false);
  });

  test("sin CRON_SECRET en el servidor, o con uno corto, nadie entra: ni con la cadena vacía", async () => {
    for (const secret of [undefined, "", "corto"]) {
      const { handler, run, logError } = montar(secret);
      for (const auth of [undefined, "Bearer ", `Bearer ${secret ?? ""}`, `Bearer ${SECRETO}`]) {
        expect((await handler(pedir("POST", auth))).status).toBe(401);
      }
      expect(run).not.toHaveBeenCalled();
      expect(logError, "el aviso sale una vez por instancia, no una por petición anónima").toHaveBeenCalledTimes(1);
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
      waitMs: 1_000,
    });
    const res = await handler(pedir("POST", `Bearer ${SECRETO}`));
    expect(res.status).toBe(500);
    const cuerpo = await res.text();
    expect(cuerpo).toBe(JSON.stringify({ ok: false }));
    expect(logError).toHaveBeenCalledWith("el turno no pudo correr", expect.any(Error));
  });

  test("si el turno no responde (el pooler colgado), la ruta contesta 504 a su hora y lo deja en el log, antes de que Vercel la mate", async () => {
    vi.useFakeTimers();
    try {
      const logError = vi.fn();
      const log = vi.fn();
      let tarde: ((err: Error) => void) | undefined;
      const handler = createTickHandler({
        secret: () => SECRETO,
        run: () => new Promise<TickSummary>((_resolve, reject) => { tarde = reject; }), // nunca responde
        log,
        logError,
        waitMs: 48_000,
      });
      const respuesta = handler(pedir("POST", `Bearer ${SECRETO}`));
      await vi.advanceTimersByTimeAsync(47_999);
      expect(logError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const res = await respuesta;
      expect(res.status).toBe(504);
      expect(await res.text()).toBe(JSON.stringify({ ok: false }));
      expect(log).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(String(logError.mock.calls[0]![0])).toMatch(/el turno no respondió a tiempo \(48000 ms; espera 48000 ms\)/);
      // Si al final termina con error, se anota; no queda una promesa rechazada sin atender.
      tarde?.(new Error("Connection terminated"));
      await vi.advanceTimersByTimeAsync(0);
      expect(logError).toHaveBeenLastCalledWith("el turno terminó con error después de responder 504", expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  test("la ruta no pide sesión (la protege su Bearer) y el resumen del log es una línea", () => {
    expect(esRutaPublica("/api/cron/tick")).toBe(true);
    // Solo el turno: otra ruta bajo /api/cron nace protegida por la sesión.
    expect(esRutaPublica("/api/cron")).toBe(false);
    expect(esRutaPublica("/api/cron/otra")).toBe(false);
    expect(tickLogLine({ ...RESUMEN, ran: [{ ...RESUMEN.ran[0]!, cut: true, status: "failed" }] })).toContain("outbound.dispatch:failed(cortado)");
    expect(JSON.parse(tickLogLine(RESUMEN))).toMatchObject({ planMs: 41 });
    expect(JSON.parse(tickLogLine(RESUMEN))).not.toHaveProperty("orphanedBossJobs");
    expect(JSON.parse(tickLogLine({ ...RESUMEN, orphanedBossJobs: 2 }))).toMatchObject({ orphanedBossJobs: 2 });
  });
});

/** El reloj de las pruebas de la firma: 2026-10-04T12:00:00Z, en segundos y en ms. */
const AHORA_S = 1_791_115_200;
const AHORA_MS = AHORA_S * 1000;

/** Las cabeceras que manda el cron de Supabase, firmadas con `secreto` en el segundo `ts`. */
const firmadas = (ts: number | string, secreto = SECRETO, firma?: string): Record<string, string> => ({
  [TICK_TIMESTAMP_HEADER]: String(ts),
  [TICK_SIGNATURE_HEADER]: firma ?? tickSignature(String(ts), secreto),
});

describe("la firma del cron de Supabase (CIM-7): sin el secreto en la cola de pg_net", () => {
  function montarConReloj(secret: string | undefined) {
    const run = vi.fn<(budgetMs: number) => Promise<TickSummary>>(async () => RESUMEN);
    const logError = vi.fn();
    const handler = createTickHandler({ secret: () => secret, now: () => AHORA_MS, run, log: vi.fn(), logError, waitMs: 1_000 });
    return { handler, run, logError };
  }
  const pedirFirmado = (headers: Record<string, string>, method: "GET" | "POST" = "POST") =>
    new Request("https://on-cue.test/api/cron/tick", { method, headers });

  test("la firma es HMAC-SHA256 del timestamp con CRON_SECRET, en hexadecimal minúscula (lo que da pgcrypto)", () => {
    // Vector fijo, para que un cambio de algoritmo o de mensaje no pase en silencio.
    expect(tickSignature("1791115200", SECRETO)).toBe(tickSignature("1791115200", SECRETO).toLowerCase());
    expect(tickSignature("1791115200", SECRETO)).toMatch(/^[0-9a-f]{64}$/);
    expect(tickSignature("1791115200", SECRETO)).not.toBe(tickSignature("1791115201", SECRETO));
    // RFC 4231, caso 2: la clave es el secreto y el mensaje el timestamp, no al revés.
    expect(tickSignature("what do ya want for nothing?", "Jefe")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  test("una firma válida, por POST: corre el turno y devuelve el resumen", async () => {
    const { handler, run } = montarConReloj(SECRETO);
    const res = await handler(pedirFirmado(firmadas(AHORA_S)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESUMEN);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test(`dentro de ±${TICK_SIGNATURE_WINDOW_S} s entra; un segundo más, no`, async () => {
    const { handler, run } = montarConReloj(SECRETO);
    for (const ts of [AHORA_S - TICK_SIGNATURE_WINDOW_S, AHORA_S + TICK_SIGNATURE_WINDOW_S]) {
      expect((await handler(pedirFirmado(firmadas(ts)))).status, String(ts - AHORA_S)).toBe(200);
    }
    for (const ts of [AHORA_S - TICK_SIGNATURE_WINDOW_S - 1, AHORA_S + TICK_SIGNATURE_WINDOW_S + 1]) {
      expect((await handler(pedirFirmado(firmadas(ts)))).status, String(ts - AHORA_S)).toBe(401);
    }
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("rechaza con el mismo 401 vacío: la de hace 120 s, una futura, una alterada y la ausencia", async () => {
    const { handler, run } = montarConReloj(SECRETO);
    const buena = tickSignature(String(AHORA_S), SECRETO);
    const alterada = (buena[0] === "0" ? "1" : "0") + buena.slice(1);
    const casos: Array<[string, Record<string, string>]> = [
      ["de hace 120 s", firmadas(AHORA_S - 120)],
      ["futura (+120 s)", firmadas(AHORA_S + 120)],
      ["muy futura (+1 día)", firmadas(AHORA_S + 86_400)],
      ["alterada (un hexadecimal)", firmadas(AHORA_S, SECRETO, alterada)],
      ["firma de otro timestamp", { [TICK_TIMESTAMP_HEADER]: String(AHORA_S), [TICK_SIGNATURE_HEADER]: tickSignature(String(AHORA_S - 1), SECRETO) }],
      ["con otro secreto", firmadas(AHORA_S, "b".repeat(64))],
      ["sin ninguna cabecera", {}],
      ["solo el timestamp", { [TICK_TIMESTAMP_HEADER]: String(AHORA_S) }],
      ["solo la firma", { [TICK_SIGNATURE_HEADER]: buena }],
    ];
    for (const [nombre, headers] of casos) {
      const res = await handler(pedirFirmado(headers));
      expect(res.status, nombre).toBe(401);
      expect(await res.text(), nombre).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("mal formadas: también 401, aunque el HMAC del texto recibido cuadre", async () => {
    const { handler, run } = montarConReloj(SECRETO);
    const buena = tickSignature(String(AHORA_S), SECRETO);
    for (const ts of [`+${AHORA_S}`, `${AHORA_S}.0`, ` ${AHORA_S}`, `${AHORA_S}e0`, "-1", "", "1".repeat(13)]) {
      expect((await handler(pedirFirmado(firmadas(ts)))).status, JSON.stringify(ts)).toBe(401);
    }
    for (const firma of [buena.toUpperCase(), `${buena}00`, buena.slice(0, -2), `sha256=${buena}`, Buffer.from(buena, "hex").toString("base64")]) {
      expect((await handler(pedirFirmado(firmadas(AHORA_S, SECRETO, firma)))).status, firma).toBe(401);
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("sin CRON_SECRET en el servidor, o con uno corto, ninguna firma entra: tampoco la hecha con la cadena vacía", async () => {
    for (const secret of [undefined, "", "corto"]) {
      const { handler, run } = montarConReloj(secret);
      for (const clave of ["", secret ?? "", SECRETO]) {
        expect((await handler(pedirFirmado(firmadas(AHORA_S, clave)))).status).toBe(401);
      }
      expect(run).not.toHaveBeenCalled();
    }
    expect(signatureMatches(new Headers(firmadas(AHORA_S, "x".repeat(CRON_SECRET_MIN_LENGTH))), "x".repeat(CRON_SECRET_MIN_LENGTH), AHORA_MS)).toBe(true);
    expect(signatureMatches(new Headers(firmadas(AHORA_S, "x".repeat(CRON_SECRET_MIN_LENGTH - 1))), "x".repeat(CRON_SECRET_MIN_LENGTH - 1), AHORA_MS)).toBe(false);
  });

  test("el Bearer sigue entrando (Vercel Cron en la opción A, y curl a mano), y convive con la firma", async () => {
    const { handler, run } = montarConReloj(SECRETO);
    expect((await handler(pedir("GET", `Bearer ${SECRETO}`))).status).toBe(200);
    // Un Bearer bueno con una firma caducada entra por el Bearer; una firma buena con un Bearer malo, por la firma.
    expect((await handler(pedirFirmado({ ...firmadas(AHORA_S - 120), authorization: `Bearer ${SECRETO}` }))).status).toBe(200);
    expect((await handler(pedirFirmado({ ...firmadas(AHORA_S), authorization: "Bearer otro" }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(3);
  });

  test("el cron de Supabase (db/ops/cron-tick.sql) manda exactamente estas cabeceras, y ningún Authorization", () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "..");
    const sql = readFileSync(join(raiz, "db", "ops", "cron-tick.sql"), "utf8");
    const comando = /\$tick\$([\s\S]*?)\$tick\$/.exec(sql)?.[1] ?? "";
    expect(comando, "el comando de la tarea, entre $tick$").not.toBe("");
    // Las cabeceras HTTP no distinguen mayúsculas; la ruta las lee en minúscula.
    const cabeceras = [...comando.matchAll(/'(X-[A-Za-z-]+)'/g)].map((m) => m[1]!.toLowerCase()).sort();
    expect(cabeceras).toEqual([TICK_SIGNATURE_HEADER, TICK_TIMESTAMP_HEADER].sort());
    expect(comando).not.toMatch(/Authorization|Bearer/i);
    expect(comando).toMatch(/encode\(extensions\.hmac\(/);
  });
});

/** Las route.ts bajo app/api/cron, relativas a esa carpeta. */
function rutasDeCron(): string[] {
  const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const out: string[] = [];
  const recorrer = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name === "route.ts") out.push(p);
    }
  };
  recorrer(raiz);
  return out.map((p) => relative(raiz, p));
}

describe("las rutas de cron", () => {
  test("cada app/api/cron/**/route.ts pasa por el guard del Bearer (createTickHandler o bearerMatches)", () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const rutas = rutasDeCron();
    expect(rutas).toContain(join("tick", "route.ts"));
    for (const r of rutas) {
      const fuente = readFileSync(join(raiz, r), "utf8");
      expect(/\b(createTickHandler|bearerMatches)\b/.test(fuente), `${r} no exige el Bearer de CRON_SECRET`).toBe(true);
    }
  });
});
