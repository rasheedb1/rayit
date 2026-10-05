import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { TickSummary } from "@mc/worker/tick";

/**
 * La ruta del turno del worker (CIM-7), separada de route.ts para poder
 * probarla sin base ni worker: quién llama, qué se le contesta y qué se
 * escribe en el log.
 *
 * Entran dos credenciales, las dos derivadas de CRON_SECRET:
 *
 *   · LA FIRMA, la del cron de Supabase (pg_net, POST; db/ops/cron-tick.sql):
 *     `X-On-Cue-Timestamp: <epoch en segundos>` y `X-On-Cue-Signature:
 *     <hex de HMAC-SHA256(timestamp, CRON_SECRET)>`, válida ±90 s del reloj
 *     del servidor. pg_net deja cada petición CON sus cabeceras en
 *     net.http_request_queue hasta que la manda, y esa tabla la alcanza
 *     PUBLIC (pg_net 0.20.4; ver ACCESOS_EN_ESQUEMAS_DECLARADOS en
 *     packages/db/src/esquema.ts): con la firma, lo que queda ahí es un
 *     permiso para UN turno durante minuto y medio, no el secreto.
 *   · EL BEARER, `Authorization: Bearer <CRON_SECRET>`: el que manda Vercel
 *     Cron (GET, opción A) cuando el proyecto tiene CRON_SECRET, y el de
 *     probar a mano con curl. El cron de Supabase ya no lo usa.
 *
 * Repetir una firma dentro de su ventana solo pide otro turno, y un turno
 * repetido no corre nada dos veces: cada corrida se reclama con un candado
 * por job (apps/worker/src/tick.ts). Por eso no se guarda qué firmas ya
 * entraron.
 *
 * Lo demás recibe un 401 vacío, igual si falta la credencial, si no
 * coincide, si la firma caducó o viene del futuro, si está mal formada o
 * si el servidor no tiene secreto: desde fuera no se distingue un caso de
 * otro.
 */

/** Lo que dura un turno: por debajo de maxDuration (60 s en route.ts) con margen para cerrar el pool y responder. */
export const TICK_BUDGET_MS = 45_000;
/**
 * Lo que el turno se da para cerrar su pool antes de responder: el
 * TICK_CLOSE_MS de @mc/worker/tick, copiado aquí para que route.ts no
 * cargue el worker antes de comprobar la credencial (turno.test.ts falla si
 * los dos se separan).
 */
export const TICK_CLOSE_MS = 3_000;
/** Un secreto más corto no se acepta (`openssl rand -hex 32` da 64 caracteres). */
export const CRON_SECRET_MIN_LENGTH = 32;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** La cabecera con el momento de la firma: segundos desde 1970, en decimal. */
export const TICK_TIMESTAMP_HEADER = "x-on-cue-timestamp";
/** La cabecera con la firma: HMAC-SHA256 del timestamp con CRON_SECRET, 64 hexadecimales en minúscula. */
export const TICK_SIGNATURE_HEADER = "x-on-cue-signature";
/** Cuánto vale una firma, hacia atrás y hacia delante del reloj del servidor. */
export const TICK_SIGNATURE_WINDOW_S = 90;

/**
 * La firma de un timestamp, como la calcula el cron en SQL:
 * `encode(extensions.hmac(ts, secreto, 'sha256'), 'hex')` (pgcrypto).
 */
export function tickSignature(timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp, "utf8").digest("hex");
}

/**
 * ¿Trae una firma buena y vigente? El timestamp, solo dígitos (nada de
 * signo, decimales ni espacios) y a ±TICK_SIGNATURE_WINDOW_S de `nowMs`;
 * la firma, 64 hexadecimales en minúscula comparados en tiempo constante
 * con timingSafeEqual (siempre 32 bytes contra 32: una mal formada se
 * compara igual, contra ceros).
 */
export function signatureMatches(headers: Headers, secret: string | undefined, nowMs: number): boolean {
  const configured = typeof secret === "string" && secret.length >= CRON_SECRET_MIN_LENGTH;
  const timestamp = headers.get(TICK_TIMESTAMP_HEADER) ?? "";
  const signature = headers.get(TICK_SIGNATURE_HEADER) ?? "";
  const wellFormed = /^\d{1,12}$/.test(timestamp) && /^[0-9a-f]{64}$/.test(signature);
  const given = wellFormed ? Buffer.from(signature, "hex") : Buffer.alloc(32);
  const expected = Buffer.from(tickSignature(timestamp, configured ? secret : ""), "hex");
  const same = timingSafeEqual(given, expected);
  const fresh = wellFormed && Math.abs(nowMs / 1000 - Number(timestamp)) <= TICK_SIGNATURE_WINDOW_S;
  return configured && wellFormed && fresh && same;
}

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
  /** El reloj contra el que se mide la ventana de la firma (Date.now; las pruebas lo fijan). */
  now?: () => number;
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
  const now = deps.now ?? Date.now;
  return async function tick(req: Request): Promise<Response> {
    const secret = deps.secret();
    // Las dos se evalúan siempre: el tiempo de respuesta no dice cuál se intentó.
    const firma = signatureMatches(req.headers, secret, now());
    const bearer = bearerMatches(req.headers.get("authorization"), secret);
    if (!firma && !bearer) {
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
