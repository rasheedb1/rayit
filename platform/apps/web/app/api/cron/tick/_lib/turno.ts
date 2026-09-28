import { createHash, timingSafeEqual } from "node:crypto";
import type { TickSummary } from "@mc/worker/tick";

/**
 * La ruta del turno del worker (CIM-7), separada de route.ts para poder
 * probarla sin base ni worker: quién llama, qué se le contesta y qué se
 * escribe en el log.
 *
 * Solo entra quien trae `Authorization: Bearer <CRON_SECRET>`: el cron
 * de Supabase (pg_net, POST; db/ops/cron-tick.sql) o Vercel Cron (GET,
 * que manda esa misma cabecera cuando el proyecto tiene CRON_SECRET).
 * Lo demás recibe un 401 vacío, igual si falta la cabecera, si no
 * coincide o si el servidor no tiene secreto: desde fuera no se
 * distingue un caso de otro.
 */

/** Lo que dura un turno: por debajo de maxDuration (60 s en route.ts) con margen para cerrar el pool y responder. */
export const TICK_BUDGET_MS = 45_000;
/** Un secreto más corto no se acepta (`openssl rand -hex 32` da 64 caracteres). */
export const CRON_SECRET_MIN_LENGTH = 32;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * ¿Trae el Bearer correcto? En tiempo constante: se comparan los SHA-256
 * de las dos cadenas (misma longitud siempre) con timingSafeEqual, así
 * que ni el contenido ni la longitud del secreto se filtran por el
 * tiempo de respuesta.
 */
export function bearerMatches(authorization: string | null, secret: string | undefined): boolean {
  const configured = typeof secret === "string" && secret.length >= CRON_SECRET_MIN_LENGTH;
  // El esquema no distingue mayúsculas (RFC 9110 §11.1): «bearer …» de un proxy también vale.
  const given = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1] ?? "";
  const same = timingSafeEqual(sha256(given), sha256(configured ? secret : ""));
  return configured && given.length > 0 && same;
}

/** La línea del log: qué corrió, cuánto tardó y qué quedó, sin ids de filas ni datos de nadie. */
export function tickLogLine(s: TickSummary): string {
  return JSON.stringify({
    at: s.at,
    elapsedMs: s.elapsedMs,
    budgetMs: s.budgetMs,
    ran: s.ran.map((r) => `${r.job}:${r.status}${r.cut ? "(cortado)" : ""}:${r.processed}/${r.failed}:${r.durationMs}ms`),
    left: s.left.map((l) => `${l.job}:${l.reason}`),
    upToDate: s.upToDate,
    exhausted: s.exhausted,
    failedRuns: s.failedRuns,
    planMs: s.planMs,
    ...(s.orphanedBossJobs ? { orphanedBossJobs: s.orphanedBossJobs } : {}),
  });
}

export interface TickRouteDeps {
  /** CRON_SECRET del entorno. Se lee en cada petición: rotarlo no pide redesplegar el código. */
  secret: () => string | undefined;
  /** Un turno con la base del worker (runTickFromEnv de @mc/worker/tick). */
  run: (budgetMs: number) => Promise<TickSummary>;
  /**
   * Cuánto espera la ruta al turno antes de responder 504 por su cuenta:
   * el presupuesto más lo que el turno se da para cerrar el pool
   * (route.ts: TICK_BUDGET_MS + TICK_CLOSE_MS), por debajo de maxDuration.
   * Si algo que el presupuesto no acota se cuelga (el pooler, el SET
   * ROLE), el log dice «no respondió a tiempo» antes de que Vercel mate
   * la función sin dejar rastro.
   */
  waitMs: number;
  log?: (line: string) => void;
  logError?: (message: string, err?: unknown) => void;
}

const NO_STORE = { "cache-control": "no-store" } as const;

/** Lo que devuelve la espera cuando el turno no respondió en waitMs. */
const LATE = Symbol("tarde");

/** El turno, o LATE si no responde en `ms`. El turno sigue en segundo plano: lo corta su presupuesto o Vercel. */
async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), ms); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createTickHandler(deps: TickRouteDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.info("[cron/tick]", line));
  const logError = deps.logError ?? ((message: string, err?: unknown) => console.error("[cron/tick]", message, err ?? ""));
  // El aviso de «sin CRON_SECRET» sale una vez por instancia: la URL es
  // pública y cualquiera que la golpee llenaría el log, y el aviso útil se
  // perdería entre el ruido. El 401 sigue igual para todos.
  let avisado = false;
  return async function tick(req: Request): Promise<Response> {
    const secret = deps.secret();
    if (!bearerMatches(req.headers.get("authorization"), secret)) {
      if ((!secret || secret.length < CRON_SECRET_MIN_LENGTH) && !avisado) {
        avisado = true;
        logError("CRON_SECRET falta o es corto: ningún turno puede entrar (apps/worker/README.md, «Por turnos»)");
      }
      return new Response(null, { status: 401, headers: NO_STORE });
    }
    avisado = false;
    const started = Date.now();
    try {
      const work = deps.run(TICK_BUDGET_MS);
      const summary = await withinMs(work, deps.waitMs);
      if (summary === LATE) {
        // Si termina después, que su error no quede sin atender (el turno ya se dio por perdido).
        work.catch((err: unknown) => logError("el turno terminó con error después de responder 504", err));
        logError(`el turno no respondió a tiempo (${Date.now() - started} ms; espera ${deps.waitMs} ms): ¿pooler colgado o sin conexiones? make cron.status`);
        return Response.json({ ok: false }, { status: 504, headers: NO_STORE });
      }
      log(tickLogLine(summary));
      return Response.json(summary, { headers: NO_STORE });
    } catch (err) {
      // El detalle va al log; al que llama (pg_net guarda la respuesta) no se le cuenta nada de la base.
      logError("el turno no pudo correr", err);
      return Response.json({ ok: false }, { status: 500, headers: NO_STORE });
    }
  };
}
