/**
 * El worker «por turnos» (CIM-7): una llamada, un turno, y se apaga.
 *
 * Sirve para correr el worker donde no hay un proceso siempre encendido:
 * una función de Vercel (apps/web/app/api/cron/tick/route.ts) a la que
 * alguien llama cada minuto. Quién llama es lo único que cambia entre
 * las dos opciones que decidió Rasheed el 27-sep:
 *
 *   B (hoy)      Vercel Hobby + pg_cron de Supabase: db/ops/cron-tick.sql
 *                programa un net.http_post a /api/cron/tick cada minuto.
 *   A (después)  Vercel Pro + Vercel Cron: `crons` en vercel.json llama a
 *                la misma ruta por GET, y `make cron.uninstall` apaga B.
 *
 * Un turno es la pasada de --once (runner/once.ts) con un presupuesto:
 *
 *   1. Programa: por cada job_definition habilitada con cron y handler,
 *      su último tick y las corridas globales de job_run desde ahí dicen
 *      si está vencido (la cola es job_run, sin pg-boss). Cada corrida se
 *      RECLAMA con un candado por job antes de empezar: dos turnos a la
 *      vez, o uno repetido, no corren dos veces lo mismo.
 *   2. Procesa lo vencido, hasta TICK_CONCURRENCY corridas a la vez, y
 *      no empieza ninguna si quedan menos de minSliceMs. Cada corrida
 *      tiene como timeout_s lo que queda del turno: la que se mide por su
 *      timeout (outbound.dispatch) termina sola y devuelve a su cola lo
 *      que no intentó; la que se pasa termina `failed` con `tickCut`, que
 *      no gasta un intento, y el turno siguiente la retoma. Nada queda
 *      `running` para siempre: una fila de un turno muerto deja de estar
 *      viva a los timeout_s + 30 s, como en --once.
 *   3. Devuelve un resumen: qué corrió, cuánto tardó, qué quedó.
 *
 * Los handlers, el SET ROLE mc_worker, los secretos y los refreshers son
 * los del proceso largo (src/recursos.ts): el turno no tiene lógica de
 * negocio propia. Sin nada vencido sale tras unas pocas consultas, sin
 * esperar a nada: Vercel Hobby cobra la CPU activa.
 *
 * El turno no se corre a la vez que el proceso largo (`pnpm --filter
 * @mc/worker start`): pg-boss no mira job_run y correrían dos veces.
 */
import type { ConnectorHttpOverrides, QuotaManager, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import { allJobs } from './jobs/index.ts';
import { channelModeFrom } from './jobs/ventas/canales/index.ts';
import { buildRefreshers, buildSecrets } from './recursos.ts';
import { loadConfig, type Env } from './runner/config.ts';
import { PostgresDatabase, type WorkerDatabase } from './runner/db.ts';
import { createLogger, isLogLevel, type Logger } from './runner/logger.ts';
import { runOnce, type OnceBudget, type OnceReason, type OnceSummary } from './runner/once.ts';
import type { JobRegistration } from './runner/registry.ts';
import type { RunStatus } from './runner/run.ts';
import { assertRole } from './runner/worker.ts';

/** Lo que el turno se guarda al final del presupuesto para cerrar las filas de job_run y responder. */
export const TICK_MARGIN_MS = 5_000;
/** Lo mínimo que tiene que quedar para empezar una corrida. */
export const TICK_MIN_SLICE_MS = 10_000;
/** Corridas a la vez dentro de un turno. */
export const TICK_CONCURRENCY = 4;
/** Conexiones del turno (las corridas más el reclamo), si no se fija WORKER_JOB_POOL_MAX. */
export const TICK_POOL_MAX = 5;
/** El presupuesto más corto que tiene sentido: con menos no cabe ni el margen. */
export const TICK_MIN_BUDGET_MS = 1_000;
/** Lo que se espera a que el pool se cierre antes de responder igual (closeWithin). */
export const TICK_CLOSE_MS = 3_000;

export interface RunTickOptions {
  /** La base del worker: conexión en modo sesión con SET ROLE mc_worker (o el embebido en pruebas). */
  db: WorkerDatabase;
  /** Cuánto puede durar el turno, en milisegundos de reloj de pared. */
  budgetMs: number;
  /** El reloj con el que se calculan los ticks del cron. Por defecto, el de verdad. */
  now?: () => Date;
  /** Las variables del worker (las mismas de src/runner/config.ts). Por defecto, process.env. */
  env?: Env;
  /** Lo de abajo solo para las pruebas: jobs, logger, secretos, refreshers, cuota, red y concurrencia. */
  jobs?: readonly JobRegistration[];
  logger?: Logger;
  secrets?: SecretStore;
  refreshers?: TokenRefresherRegistry;
  quota?: QuotaManager;
  http?: ConnectorHttpOverrides;
  concurrency?: number;
}

export interface TickRun {
  job: string;
  reason: OnceReason;
  status: RunStatus;
  processed: number;
  failed: number;
  durationMs: number;
  /** El presupuesto se acabó antes que el job: el turno siguiente lo retoma. */
  cut: boolean;
}

/** Por qué un job vencido quedó para después: sin tiempo para empezarlo, cortado a medias, o lo tiene otro turno. */
export type TickLeftReason = 'budget' | 'cut' | 'running' | 'shutting_down';

export interface TickSummary {
  /** El reloj del turno, ISO. */
  at: string;
  budgetMs: number;
  elapsedMs: number;
  ran: TickRun[];
  left: Array<{ job: string; reason: TickLeftReason }>;
  /** Jobs que ya estaban al día. */
  upToDate: number;
  /** Jobs con los intentos (o los cortes) agotados hasta su próximo tick. */
  exhausted: string[];
  /** Corridas que terminaron failed por el job (un corte del turno no cuenta). */
  failedRuns: number;
}

/** El presupuesto de la pasada: el margen y el mínimo para empezar, acotados para presupuestos cortos. */
export function tickBudget(budgetMs: number, startedAt: number = Date.now()): OnceBudget {
  const marginMs = Math.min(TICK_MARGIN_MS, Math.floor(budgetMs * 0.2));
  return { deadline: startedAt + budgetMs - marginMs, minSliceMs: Math.min(TICK_MIN_SLICE_MS, Math.floor(budgetMs * 0.25)) };
}

const LEFT_REASONS: ReadonlySet<string> = new Set<TickLeftReason>(['budget', 'running', 'shutting_down']);

export function toTickSummary(s: OnceSummary, budgetMs: number, elapsedMs: number): TickSummary {
  return {
    at: s.at,
    budgetMs,
    elapsedMs,
    ran: s.runs.map((r) => ({ job: r.job, reason: r.reason, status: r.status, processed: r.processed, failed: r.failed, durationMs: r.durationMs, cut: r.cut })),
    left: [
      ...s.runs.filter((r) => r.cut).map((r) => ({ job: r.job, reason: 'cut' as const })),
      ...s.skipped.filter((x) => LEFT_REASONS.has(x.reason)).map((x) => ({ job: x.job, reason: x.reason as TickLeftReason })),
    ],
    upToDate: s.skipped.filter((x) => x.reason === 'up_to_date').length,
    exhausted: s.skipped.filter((x) => x.reason === 'retries_exhausted').map((x) => x.job),
    failedRuns: s.failedRuns,
  };
}

/** El logger de un turno: JSON por línea y, sin LOG_LEVEL, solo avisos y errores (el resumen lo escribe quien llama). */
export function tickLogger(env: Env): Logger {
  return createLogger({ level: isLogLevel(env['LOG_LEVEL']) ? env['LOG_LEVEL'] : 'warn', bindings: { app: 'mc-worker', mode: 'tick' } });
}

/** Un turno sobre una base ya abierta. No la cierra. */
export async function runTick(opts: RunTickOptions): Promise<TickSummary> {
  const started = Date.now();
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < TICK_MIN_BUDGET_MS) {
    throw new RangeError(`budgetMs debe ser un número ≥ ${TICK_MIN_BUDGET_MS}; recibió ${opts.budgetMs}`);
  }
  const env = opts.env ?? process.env;
  const config = loadConfig(env, { mode: opts.db.kind });
  const logger = opts.logger ?? tickLogger(env);
  // La misma guardia que el arranque del proceso (src/index.ts): el canal falso nunca contra la base compartida.
  channelModeFrom(env, { databaseUrl: config.databaseUrl, embedded: config.mode === 'pglite' });
  await assertRole(opts.db, config, logger);

  const summary = await runOnce({
    config,
    db: opts.db,
    logger,
    jobs: opts.jobs ?? allJobs,
    secrets: opts.secrets ?? buildSecrets(config, opts.db, logger, env),
    refreshers: opts.refreshers ?? buildRefreshers(config, logger, env, { missingAppsLevel: 'debug' }),
    env,
    now: opts.now,
    quota: opts.quota,
    http: opts.http,
    budget: tickBudget(opts.budgetMs, started),
    concurrency: opts.concurrency ?? TICK_CONCURRENCY,
  });
  return toTickSummary(summary, opts.budgetMs, Date.now() - started);
}

export interface RunTickFromEnvOptions {
  budgetMs: number;
  env?: Env;
  now?: () => Date;
  logger?: Logger;
}

/**
 * Un turno con la base del entorno: WORKER_DATABASE_URL (o
 * DATABASE_URL_DIRECT), modo sesión (:5432), SET ROLE WORKER_SET_ROLE
 * (mc_worker). Abre el pool, corre y lo cierra: una función que se
 * congela entre llamadas no deja conexiones de sesión tomadas.
 */
export async function runTickFromEnv(opts: RunTickFromEnvOptions): Promise<TickSummary> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? tickLogger(env);
  const config = loadConfig(env, { mode: 'postgres', ...(env['WORKER_JOB_POOL_MAX'] ? {} : { jobPoolMax: TICK_POOL_MAX }) });
  const db = new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: config.jobPoolMax,
    bossPoolMax: 1,
    applicationName: `${config.applicationName}:tick`,
    sslRootCert: config.sslRootCert,
    onError: (err) => logger.error('error en el pool de conexiones', { err }),
  });
  try {
    return await runTick({ db, budgetMs: opts.budgetMs, env, now: opts.now, logger });
  } finally {
    await closeWithin(db, TICK_CLOSE_MS, logger);
  }
}

/**
 * pool.end() espera a que se devuelvan las conexiones prestadas. Si un
 * job cortado no mira ctx.signal y sigue con una, la respuesta no puede
 * quedarse esperándolo hasta que Vercel mate la función: se responde a
 * los TICK_CLOSE_MS y el pool se cierra cuando la suelte.
 */
async function closeWithin(db: WorkerDatabase, ms: number, logger: Logger): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), ms); });
  const closed = db.close().then(() => 'closed' as const, () => 'closed' as const);
  const outcome = await Promise.race([closed, late]);
  clearTimeout(timer);
  if (outcome === 'late') logger.warn('el pool no se cerró a tiempo: un job cortado sigue con una conexión', { waitedMs: ms });
}
