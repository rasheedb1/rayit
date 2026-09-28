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
 *   2. Procesa lo vencido, outbound.dispatch primero (TICK_FIRST), hasta
 *      TICK_CONCURRENCY corridas a la vez, y
 *      no empieza ninguna si quedan menos de minSliceMs. Cada corrida
 *      tiene como timeout_s lo que queda del turno: la que se mide por su
 *      timeout (outbound.dispatch) termina sola y devuelve a su cola lo
 *      que no intentó; la que se pasa termina `failed` con `tickCut`, que
 *      no gasta un intento, y el turno siguiente la retoma. Nada queda
 *      `running` para siempre: una fila de un turno muerto deja de estar
 *      viva a los sliceS + 30 s (el timeout que tuvo en el turno, que
 *      queda en su metadata), no a los timeout_s de su definición.
 *   3. Devuelve un resumen: qué corrió, cuánto tardó, qué quedó.
 *
 * Los handlers, el SET ROLE mc_worker, los secretos y los refreshers son
 * los del proceso largo (src/recursos.ts): el turno no tiene lógica de
 * negocio propia. Sin nada vencido sale tras unas pocas consultas, sin
 * esperar a nada: Vercel Hobby cobra la CPU activa.
 *
 * El turno no se corre a la vez que el proceso largo (`pnpm --filter
 * @mc/worker start`): pg-boss no mira job_run y correrían dos veces.
 *
 * La cola del turno es job_run, NO pg-boss: un `boss.send(...)` (un
 * «Recalcular» desde una pantalla, el encadenado del proceso largo) no lo
 * procesa nadie en este modo. Un trabajo a demanda se pide con una fila
 * en job_run o se deja a su cron. Para que no pase en silencio, el turno
 * cuenta lo que espera en pgboss.job y lo devuelve en
 * `orphanedBossJobs`, con un aviso en el log si es mayor que 0.
 */
import type { ConnectorHttpOverrides, QuotaManager, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import { allJobs } from './jobs/index.ts';
import { channelModeFrom } from './jobs/ventas/canales/index.ts';
import { DISPATCH_JOB_ID } from './jobs/ventas/outbound.dispatch.ts';
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
/**
 * Corridas a la vez dentro de un turno. En Hobby el turno es I/O casi
 * todo (proveedores, Anthropic): tres a la vez dan para lo vencido de un
 * minuto sin agotar las conexiones de Supabase (ver TICK_POOL_MAX).
 */
export const TICK_CONCURRENCY = 3;
/**
 * Conexiones del turno, si no se fija WORKER_JOB_POOL_MAX: dos por
 * corrida más una. Una corrida puede tener a la vez una transacción
 * abierta y pedir una segunda conexión (PostgresCallLogSink escribe
 * api_call_log con ctx.db; el reclamo de un encadenado abre la suya), y
 * la planificación, el reclamo y el cierre de la fila usan otra. Con 2·3+1
 * = 7, dos turnos solapados son 14: caben en las 15 de modo sesión que el
 * pooler de Supabase da por usuario y base. test/tick-postgres.test.ts lo
 * mide con TICK_CONCURRENCY corridas que escriben api_call_log dentro de
 * una transacción.
 */
export const TICK_POOL_MAX = TICK_CONCURRENCY * 2 + 1;
/** Jobs que el turno empieza antes que el resto si están vencidos: un toque atrasado es lo único que nota un cliente. */
export const TICK_FIRST: readonly string[] = [DISPATCH_JOB_ID];
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

/**
 * Por qué un job vencido quedó para después: sin tiempo para empezarlo,
 * cortado a medias, lo tiene otro turno, o falló hace menos que su
 * espera de reintento (backoff, la misma que el proceso largo).
 */
export type TickLeftReason = 'budget' | 'cut' | 'running' | 'backoff' | 'shutting_down';

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
  /** Lo que tardó la planificación: sin nada vencido es casi todo el turno (objetivo < 300 ms en Supabase, una conexión). */
  planMs: number;
  /**
   * Trabajos esperando en pgboss.job ('created' o 'retry'). El turno no
   * los procesa (su cola es job_run): mayor que 0 es un boss.send que
   * nadie va a atender. null si no hay esquema pgboss o no se puede leer.
   */
  orphanedBossJobs: number | null;
}

/** El presupuesto de la pasada: el margen y el mínimo para empezar, acotados para presupuestos cortos. */
export function tickBudget(budgetMs: number, startedAt: number = Date.now()): OnceBudget {
  const marginMs = Math.min(TICK_MARGIN_MS, Math.floor(budgetMs * 0.2));
  return { deadline: startedAt + budgetMs - marginMs, minSliceMs: Math.min(TICK_MIN_SLICE_MS, Math.floor(budgetMs * 0.25)) };
}

const LEFT_REASONS: ReadonlySet<string> = new Set<TickLeftReason>(['budget', 'running', 'backoff', 'shutting_down']);

export function toTickSummary(s: OnceSummary, budgetMs: number, elapsedMs: number, orphanedBossJobs: number | null = null): TickSummary {
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
    planMs: s.planMs,
    orphanedBossJobs,
  };
}

/**
 * Cuántos trabajos esperan en pgboss.job. Sin esquema pgboss (el modo por
 * turnos no lo instala) o sin permiso para leerlo, null tras una sola
 * consulta; si existe, una segunda que cuenta.
 */
export async function countOrphanedBossJobs(db: WorkerDatabase, logger: Logger): Promise<number | null> {
  try {
    const { rows } = await db.query<{ readable: boolean }>(
      `SELECT coalesce(has_table_privilege(to_regclass('pgboss.job'), 'SELECT'), false) AS readable`,
    );
    if (!rows[0]?.readable) return null;
    const counted = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created', 'retry')`);
    return Number(counted.rows[0]?.n ?? 0);
  } catch (err) {
    logger.debug('no se pudo contar pgboss.job', { err });
    return null;
  }
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
    first: TICK_FIRST,
  });
  const orphaned = await countOrphanedBossJobs(opts.db, logger);
  if (orphaned !== null && orphaned > 0) {
    logger.warn('hay trabajos en pgboss.job que el modo por turnos no procesa: pídelos con una fila en job_run o déjalos a su cron', { orphanedBossJobs: orphaned });
  }
  return toTickSummary(summary, opts.budgetMs, Date.now() - started, orphaned);
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
  if (config.jobPoolMax < TICK_POOL_MAX) {
    logger.warn('WORKER_JOB_POOL_MAX por debajo de lo que pide el turno: una corrida puede esperar conexión hasta el corte', { jobPoolMax: config.jobPoolMax, needed: TICK_POOL_MAX });
  }
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
