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
 *      si está vencido (sin pg-boss: job_run es el registro, no una cola). Cada corrida se
 *      RECLAMA con un candado por job antes de empezar: dos turnos a la
 *      vez, o uno repetido, no corren dos veces lo mismo.
 *   2. Procesa lo vencido (src/turno/recorrer.ts), outbound.dispatch
 *      primero (TICK_FIRST), hasta TICK_CONCURRENCY corridas a la vez, y
 *      no empieza ninguna si quedan menos de minSliceMs. Cada corrida
 *      tiene como timeout_s lo que queda del turno: la que se mide por su
 *      timeout (outbound.dispatch) termina sola y devuelve a su cola lo
 *      que no intentó; la que se pasa termina `failed` con `tickCut`, que
 *      no gasta un intento, y el turno siguiente la retoma. Lo encadenado
 *      no empieza antes que su job de arriba, y un fallo espera su
 *      backoff (el del proceso largo) antes del reintento. Nada queda
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
 * @mc/worker start`): pg-boss no mira job_run y correrían dos veces. No
 * es solo una regla: el proceso largo retiene un candado de sesión y el
 * turno, si lo ve en pg_locks, sale sin correr nada con
 * `left: [{ job: '*', reason: 'running' }]`; y el proceso largo no
 * arranca si hubo turnos hace menos de 5 min (runner/exclusion.ts).
 *
 * En modo por turnos NO hay trabajo a demanda: el turno solo corre lo que
 * el cron de job_definition dice que está vencido. Un `boss.send(...)`
 * (un «Recalcular» desde una pantalla) no lo procesa nadie, y una fila
 * escrita a mano en job_run tampoco lo pide (job_run no tiene estado de
 * cola; una fila ok o skipped daría el tick por cubierto y SALTARÍA la
 * corrida). A demanda: esperar al cron o `pnpm --filter @mc/worker once`
 * a mano (README, «Por turnos»). Para que un boss.send no pase en
 * silencio, el turno cuenta lo que espera en pgboss.job y lo devuelve en
 * `orphanedBossJobs`, con un aviso en el log si es mayor que 0 (o si el
 * esquema existe y mc_worker no puede leerlo: 'unreadable').
 *
 * El log de Vercel Hobby guarda poco: el turno escribe una línea por
 * llamada (la ruta) y avisos solo cuando algo pide atención. Lo que se
 * repetiría cada minuto sin cambiar nada (platform.limits con entradas
 * que no se aplican, pgboss.job ilegible) sale una vez por instancia.
 */
import {
  loadPlatformLimits, PostgresQuotaUsageStore, QuotaManager,
  type ConnectorHttpOverrides, type ConnectorLogger, type LimitsTable, type SecretStore, type TokenRefresherRegistry,
} from '@mc/connectors';
import { allJobs } from './jobs/index.ts';
import { channelModeFrom, isLocalDatabase } from './jobs/ventas/canales/index.ts';
import { DISPATCH_JOB_ID } from './jobs/ventas/outbound.dispatch.ts';
import { buildRefreshers, buildSecrets } from './recursos.ts';
import { assertRole } from './runner/comun.ts';
import { ConfigError, loadConfig, type Env, type WorkerConfig } from './runner/config.ts';
import { PostgresDatabase, type WorkerDatabase } from './runner/db.ts';
import { LONG_PROCESS_LOCK, longProcessHoldsLock } from './runner/exclusion.ts';
import { createLogger, isLogLevel, type Logger } from './runner/logger.ts';
import { retryBackoffFrom, runOnce, type OnceReason, type OnceSummary } from './runner/once.ts';
import type { JobRegistration } from './runner/registry.ts';
import type { RunStatus } from './runner/run.ts';
import { turnoWalk, type TurnoBudget } from './turno/recorrer.ts';

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
/**
 * Lo que se espera una conexión nueva (pg, por defecto, espera para
 * siempre). Con el pooler de Supabase colgado o sin clientes libres, el
 * turno falla a los 5 s con su motivo en el log, en vez de quedarse
 * esperando hasta que Vercel mate la función sin dejar rastro.
 */
export const TICK_CONNECT_TIMEOUT_MS = 5_000;

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
 * espera de reintento (backoff, la misma que el proceso largo); o
 * `error`: la base falló al reclamarla o al cerrar su fila (el log dice
 * cuál), y sigue vencida para el turno siguiente.
 */
export type TickLeftReason = 'budget' | 'cut' | 'running' | 'backoff' | 'shutting_down' | 'error';

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
   * nadie va a atender. null si no hay esquema pgboss; 'unreadable' si lo
   * hay pero mc_worker no puede leerlo (falta el GRANT de
   * docs/propuestas/CON-2.md, y el aviso sale en el log).
   */
  orphanedBossJobs: number | 'unreadable' | null;
}

/** El presupuesto de la pasada: el margen y el mínimo para empezar, acotados para presupuestos cortos. */
export function tickBudget(budgetMs: number, startedAt: number = Date.now()): TurnoBudget {
  const marginMs = Math.min(TICK_MARGIN_MS, Math.floor(budgetMs * 0.2));
  return { deadline: startedAt + budgetMs - marginMs, minSliceMs: Math.min(TICK_MIN_SLICE_MS, Math.floor(budgetMs * 0.25)) };
}

const LEFT_REASONS: ReadonlySet<string> = new Set<TickLeftReason>(['budget', 'running', 'backoff', 'shutting_down', 'error']);

export function toTickSummary(s: OnceSummary, budgetMs: number, elapsedMs: number, orphanedBossJobs: TickSummary['orphanedBossJobs'] = null): TickSummary {
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

/** El GRANT que le falta a mc_worker para leer pgboss.job (docs/propuestas/CON-2.md, «El turno y pgboss.job»). */
export const BOSS_READ_GRANT = 'GRANT USAGE ON SCHEMA pgboss TO mc_worker; GRANT SELECT ON pgboss.job TO mc_worker;';

/** El aviso de pgboss.job ilegible sale una vez por instancia: cada minuto sería ruido. */
let bossUnreadableWarned = false;

/**
 * Cuántos trabajos esperan en pgboss.job, en una consulta. Sin esquema
 * pgboss (el modo por turnos no lo instala), null. Con esquema pero sin
 * permiso para leerlo, 'unreadable' y un aviso (una vez por instancia)
 * con el GRANT que falta: pg-boss crea su esquema con el rol de conexión
 * de `--install`, no con mc_worker, y sin el GRANT la red de seguridad
 * quedaría ciega sin decirlo. Si existe y se puede leer, una segunda
 * consulta que cuenta.
 */
export async function countOrphanedBossJobs(db: WorkerDatabase, logger: Logger): Promise<number | 'unreadable' | null> {
  try {
    // Por el catálogo y no con to_regclass('pgboss.job'): sin USAGE en el
    // esquema, to_regclass no devuelve null, lanza «permission denied».
    const { rows } = await db.query<{ exists: boolean; readable: boolean }>(
      `SELECT count(*) > 0 AS exists,
              coalesce(bool_and(has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')), false) AS readable
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pgboss' AND c.relname = 'job'`,
    );
    if (!rows[0]?.exists) return null;
    if (!rows[0].readable) {
      if (!bossUnreadableWarned) {
        bossUnreadableWarned = true;
        logger.warn('pgboss.job existe pero el rol del turno no puede leerlo: los boss.send huérfanos no se ven. Como postgres (supabase-admin), corre el GRANT', { grant: BOSS_READ_GRANT });
      }
      return 'unreadable';
    }
    const counted = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created', 'retry')`);
    return Number(counted.rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn('no se pudo contar pgboss.job', { err });
    return null;
  }
}

/**
 * Cuánto dura en una instancia la lectura de platform.limits. Cambia
 * muy de vez en cuando (a mano, docs/propuestas/CON-1.md); releerla en
 * cada turno era una consulta más por minuto y, con las entradas que no
 * se aplican de la migración 0011, siete avisos por turno en el log.
 */
export const TICK_LIMITS_TTL_MS = 5 * 60_000;

let limitsCache: { limits: LimitsTable; at: number } | null = null;
let limitsIgnoredWarned = false;

/**
 * La cuota del turno: la misma que createQuota (runner/comun.ts) da al
 * proceso largo y a --once —platform.limits sobre api_quota_usage—, con
 * dos diferencias que solo tienen sentido llamando cada minuto:
 * platform.limits se lee como mucho cada TICK_LIMITS_TTL_MS por
 * instancia, y sus «entrada ignorada» van a debug, con UN aviso por
 * instancia que dice cuántas son. El QuotaManager es nuevo en cada
 * turno (su store va sobre la base de ese turno).
 */
export async function tickQuota(db: WorkerDatabase, logger: Logger, now?: () => Date, http?: ConnectorHttpOverrides): Promise<QuotaManager> {
  if (!limitsCache || Date.now() - limitsCache.at > TICK_LIMITS_TTL_MS) {
    let ignored = 0;
    const quiet: ConnectorLogger = {
      debug: (msg, fields) => logger.debug(msg, fields),
      info: (msg, fields) => logger.info(msg, fields),
      warn: (msg, fields) => { ignored++; logger.debug(msg, fields); },
      error: (msg, fields) => logger.error(msg, fields),
    };
    const limits = await loadPlatformLimits(db, quiet);
    if (ignored > 0 && !limitsIgnoredWarned) {
      limitsIgnoredWarned = true;
      logger.warn('platform.limits tiene entradas que no se aplican (el detalle, con LOG_LEVEL=debug; sale una vez por instancia)', { ignored });
    }
    limitsCache = { limits, at: Date.now() };
  }
  return new QuotaManager({ limits: limitsCache.limits, store: new PostgresQuotaUsageStore(db), logger, now, sleep: http?.sleep });
}

/** Solo para las pruebas: olvida lo que el turno guarda por instancia (platform.limits y los avisos que ya salieron). */
export function forgetTickInstanceState(): void {
  limitsCache = null;
  limitsIgnoredWarned = false;
  bossUnreadableWarned = false;
}

/** El logger de un turno: JSON por línea y, sin LOG_LEVEL, solo avisos y errores (el resumen lo escribe quien llama). */
export function tickLogger(env: Env): Logger {
  return createLogger({ level: isLogLevel(env['LOG_LEVEL']) ? env['LOG_LEVEL'] : 'warn', bindings: { app: 'mc-worker', mode: 'tick' } });
}

/** El resumen de un turno que no corrió nada porque el proceso largo tiene el candado: todo queda para después, `running` por otro. */
function longProcessSummary(opts: RunTickOptions, started: number): TickSummary {
  return {
    at: (opts.now?.() ?? new Date()).toISOString(),
    budgetMs: opts.budgetMs,
    elapsedMs: Date.now() - started,
    ran: [],
    left: [{ job: '*', reason: 'running' }],
    upToDate: 0,
    exhausted: [],
    failedRuns: 0,
    planMs: 0,
    orphanedBossJobs: null,
  };
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
  // Con el proceso largo vivo contra esta base, el turno no corre nada: pg-boss no mira job_run (runner/exclusion.ts).
  if (await longProcessHoldsLock(opts.db)) {
    logger.warn('el proceso largo del worker tiene el candado de esta base: el turno no corre nada. Si no debería estar encendido, apágalo (¿un `pnpm --filter @mc/worker start` con el .env.local de producción?)', { lock: LONG_PROCESS_LOCK });
    return longProcessSummary(opts, started);
  }
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
    quota: opts.quota ?? await tickQuota(opts.db, logger, opts.now, opts.http),
    http: opts.http,
    // Cada minuto, un fallo espera su backoff (el de pg-boss en el proceso largo): --once no lo pide.
    backoff: retryBackoffFrom(config),
    walk: turnoWalk({ budget: tickBudget(opts.budgetMs, started), concurrency: opts.concurrency ?? TICK_CONCURRENCY, first: TICK_FIRST, logger }),
  });
  const orphaned = await countOrphanedBossJobs(opts.db, logger);
  if (typeof orphaned === 'number' && orphaned > 0) {
    logger.warn('hay trabajos en pgboss.job que el modo por turnos no procesa: espera a su cron o corre `pnpm --filter @mc/worker once`', { orphanedBossJobs: orphaned });
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
 * ¿Puede correr aquí un turno contra esta base? Contra una base que no es
 * de esta máquina, solo en el despliegue de producción de Vercel
 * (VERCEL_ENV=production): `pnpm --filter @mc/web dev` carga el
 * .env.local de `make db.unlock`, que apunta al Supabase de PRODUCCIÓN, y
 * un curl a la ruta en local correría el turno de verdad (correo real, en
 * paralelo con el cron de producción). TICK_ALLOW_REMOTE=1 lo permite a
 * sabiendas. Es la misma idea que channelModeFrom con el canal falso.
 */
export function assertTickTarget(env: Env, config: Pick<WorkerConfig, 'databaseUrl'>): void {
  if (isLocalDatabase(config.databaseUrl) || env['VERCEL_ENV'] === 'production' || env['TICK_ALLOW_REMOTE'] === '1') return;
  throw new ConfigError(
    'El turno contra una base remota solo corre en el despliegue de producción de Vercel (VERCEL_ENV=production). ' +
      'Para probarlo en local, apunta WORKER_DATABASE_URL a tu Postgres de Docker; con la de .env.local correría contra ' +
      'producción y enviaría de verdad. TICK_ALLOW_REMOTE=1 lo permite a sabiendas.',
  );
}

/**
 * La base de un turno: la del proceso largo (modo sesión, SET ROLE
 * mc_worker), con la espera de conexión acotada (TICK_CONNECT_TIMEOUT_MS)
 * y, en cada conexión, statement_timeout e idle_in_transaction_session_timeout
 * iguales al presupuesto: un job cortado que no mira ctx.signal (o metido
 * en una sentencia larga, como compute.baseline) suelta su conexión a lo
 * sumo `budgetMs` después, en vez de retenerla contra las 15 de modo
 * sesión del pooler mientras la función está congelada.
 */
export function openTickDatabase(config: WorkerConfig, budgetMs: number, logger: Logger): PostgresDatabase {
  return new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: config.jobPoolMax,
    bossPoolMax: 1,
    applicationName: `${config.applicationName}:tick`,
    sslRootCert: config.sslRootCert,
    connectionTimeoutMillis: TICK_CONNECT_TIMEOUT_MS,
    sessionTimeoutMs: budgetMs,
    onError: (err) => logger.error('error en el pool de conexiones', { err }),
  });
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
  assertTickTarget(env, config);
  if (config.jobPoolMax < TICK_POOL_MAX) {
    logger.warn('WORKER_JOB_POOL_MAX por debajo de lo que pide el turno: una corrida puede esperar conexión hasta el corte', { jobPoolMax: config.jobPoolMax, needed: TICK_POOL_MAX });
  }
  const db = openTickDatabase(config, opts.budgetMs, logger);
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
