/**
 * Modo «una pasada» (--once, WRK): corre lo vencido y sale.
 *
 * Es el camino (b) de docs/propuestas/WRK.md: un cron externo (GitHub
 * Actions programado) arranca el worker cada hora, el worker corre lo
 * que toca y se apaga. No hay proceso largo ni pg-boss: la cola es
 * job_run, así que tampoco hace falta el esquema `pgboss` (solo que el
 * rol de conexión pueda hacer SET ROLE mc_worker).
 *
 * Qué está vencido, por cada definición habilitada, con cron y handler
 * (y dentro de WORKER_GROUPS si se definió):
 *
 *   tick = último disparo de default_cron ≤ ahora (cron.ts, UTC)
 *   job_run globales (workspace_id NULL) del job desde ese tick:
 *     alguna running viva (< timeout_s + 30 s) → otra pasada lo tiene
 *     alguna ok o skipped, o un fallo que
 *       pidió no reintentar (retry: false)   → al día, no corre
 *     intentos ≥ max_attempts                → reintentos agotados hasta
 *                                              el próximo tick (se avisa)
 *     si no                                  → corre, attempt = intentos + 1
 *   (intentos = partial o failed reintentables + running colgadas)
 *
 * Así una pasada corre lo vencido, la siguiente no repite lo ya corrido
 * y un fallo se reintenta en la pasada siguiente hasta max_attempts,
 * con la misma regla de reintento que el proceso largo (worker.ts).
 *
 * Encadenamiento (JobOptions.after): igual que en el proceso largo, si
 * un job termina ok o partial con processed > 0, lo que corre después
 * se corre enseguida, con `{ source: 'chain', after }` en el payload. En
 * una pasada cada job corre como mucho una vez.
 *
 * Las corridas van una detrás de otra: primero lo que no corre después
 * de nada (collect.*), luego lo encadenado (compute.*), y dentro de cada
 * nivel por tick, el más viejo primero. Con timeout_s de 60–600 s por job, una
 * pasada completa cabe de sobra en el límite de un runner de GitHub.
 *
 * Dos pasadas a la vez (dos turnos de CIM-7 que se solapan, o un
 * workflow repetido): cada corrida se RECLAMA antes de empezar
 * (claimRun) en una transacción corta con un candado por job
 * (pg_advisory_xact_lock, JOB_LOCK_PREFIX): se relee el estado del tick
 * y, si sigue vencido, se abre ahí mismo la fila `running`. La segunda
 * pasada espera el candado, ve esa fila y se salta el job. El candado
 * dura lo que la transacción: un proceso muerto no lo deja tomado, y su
 * fila `running` deja de estar viva a los timeout_s + 30 s. (Con un
 * proceso largo encendido no hay reclamo: pg-boss no mira job_run; no se
 * corren a la vez.)
 *
 * Modo por turnos (CIM-7, src/tick.ts): la misma pasada con un
 * presupuesto (`budget`). No empieza una corrida si quedan menos de
 * `minSliceMs`; a la que empieza le da como timeout_s lo que queda del
 * turno (un job que se mide por su timeout, como outbound.dispatch,
 * termina solo y devuelve lo que no intentó), y la que aun así se pasa
 * termina `failed` con `timeout` y `metadata.tickCut`. Un corte no
 * gasta un intento: el turno siguiente la retoma (reason `resume`), hasta
 * MAX_TICK_CUTS cortes por tick del cron. Lo que no llegó a empezar
 * queda como `budget` y sigue vencido para el turno siguiente.
 */
import { randomUUID } from 'node:crypto';
import type { QuotaManager, ConnectorHttpOverrides, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import { EXPIRE_MARGIN_S } from './boss.ts';
import type { Env, WorkerConfig } from './config.ts';
import { CronError, lastTick } from './cron.ts';
import type { Queryable, WorkerDatabase } from './db.ts';
import { loadJobDefinitions } from './definitions.ts';
import type { Logger } from './logger.ts';
import { JobRegistry, type JobDefinition, type JobRegistration } from './registry.ts';
import { CHAIN_SOURCE, executeRun, JobItemsFailedError, JobTimeoutError, type RunOutcome, type RunStatus } from './run.ts';
import { createQuota, JOB_LOCK_PREFIX, recordSkipped } from './worker.ts';

/** `source` del payload de una corrida de --once, como `cron` en las de pg-boss. */
export const ONCE_SOURCE = 'once';

export interface RunOnceOptions {
  config: WorkerConfig;
  db: WorkerDatabase;
  logger: Logger;
  jobs: readonly JobRegistration[];
  secrets: SecretStore;
  refreshers: TokenRefresherRegistry;
  env?: Env;
  now?: () => Date;
  quota?: QuotaManager;
  http?: ConnectorHttpOverrides;
  /** SIGTERM del runner: no se empieza nada nuevo y la corrida en curso recibe la señal. */
  signal?: AbortSignal;
  /** El presupuesto de un turno (modo por turnos, CIM-7). Sin él, --once: sin límite de tiempo. */
  budget?: OnceBudget;
  /** Cuántas corridas a la vez. 1 (por defecto, --once): una detrás de otra. */
  concurrency?: number;
}

export interface OnceBudget {
  /** Hasta cuándo puede correr una corrida, en milisegundos de reloj de pared (Date.now()). */
  deadline: number;
  /** Lo mínimo que tiene que quedar para EMPEZAR una corrida. */
  minSliceMs: number;
}

/** due: vencida · retry: tras un fallo · resume: tras un corte del turno · chained: tras el job de arriba. */
export type OnceReason = 'due' | 'retry' | 'resume' | 'chained';

export interface OnceRun {
  job: string;
  reason: OnceReason;
  /** Desde cuándo se está cubriendo el job, ISO; null en un encadenado. */
  tick: string | null;
  runId: number;
  status: RunStatus;
  processed: number;
  failed: number;
  durationMs: number;
  /** Se acabó el presupuesto del turno antes que el job: queda para el turno siguiente. */
  cut: boolean;
}

/** budget: vencido pero sin tiempo en el turno para empezarlo; sigue vencido para el siguiente. */
export type OnceSkipReason = 'up_to_date' | 'running' | 'retries_exhausted' | 'no_handler' | 'no_cron' | 'disabled' | 'shutting_down' | 'budget';

export interface OnceSummary {
  /** ISO del reloj con el que se calcularon los ticks. */
  at: string;
  runs: OnceRun[];
  skipped: Array<{ job: string; reason: OnceSkipReason }>;
  /** Corridas que terminaron failed. */
  failedRuns: number;
  /** Jobs vencidos que no llegaron a empezar porque llegó una señal. */
  interrupted: number;
}

/** El proceso sale con 1 si hubo una corrida fallida o una pasada interrumpida: el cron externo la marca en rojo. */
export function onceExitCode(s: OnceSummary): 0 | 1 {
  return s.failedRuns > 0 || s.interrupted > 0 ? 1 : 0;
}

/** Marca en job_run.metadata de una corrida que el job pidió no reintentar (`retry: false`). */
export const NO_RETRY_KEY = 'noRetry';
/** Marca en job_run.metadata de una corrida que cortó el presupuesto del turno (CIM-7): no cuenta como intento. */
export const TICK_CUT_KEY = 'tickCut';
/**
 * Cortes por presupuesto que se toleran dentro de un mismo tick del cron.
 * Un job que se retoma avanza en cada turno; uno que nunca cabe no puede
 * gastar CPU cada minuto para siempre: pasado este tope espera a su
 * próximo tick, como con max_attempts.
 */
export const MAX_TICK_CUTS = 20;

interface DueJob {
  def: JobDefinition;
  registration: JobRegistration;
  coverFrom: Date;
  attempt: number;
  reason: OnceReason;
}

interface TickState extends Record<string, unknown> {
  done: number;
  attempts: number;
  running: number;
  cuts: number;
}

/**
 * El estado de un job desde `coverFrom`, contando solo las corridas
 * globales: una corrida encadenada o manual de UN workspace no cubre el
 * tick de todos.
 *
 *   done      ok o skipped; o partial/failed que pidió no reintentar
 *   attempts  partial o failed que sí se reintentan, y las `running`
 *             colgadas (más viejas que timeout_s + 30 s: al proceso lo
 *             mataron), para que max_attempts también las cuente
 *   running   `running` viva, EMPIECE CUANDO EMPIECE: una corrida de
 *             antes del tick que sigue en marcha tampoco se pisa
 *   cuts      failed por el presupuesto de un turno (tickCut): no son
 *             intentos, el turno siguiente las retoma (MAX_TICK_CUTS)
 */
async function tickState(db: Queryable, def: JobDefinition, coverFrom: Date, now: Date): Promise<TickState> {
  const liveSince = new Date(now.getTime() - (def.timeoutS + EXPIRE_MARGIN_S) * 1000);
  const { rows } = await db.query<TickState>(
    `SELECT count(*) FILTER (WHERE started_at >= $2::timestamptz AND (
                status IN ('ok','skipped')
                OR (status IN ('partial','failed') AND (metadata->>'${NO_RETRY_KEY}')::boolean IS TRUE)))::int AS done,
            count(*) FILTER (WHERE started_at >= $2::timestamptz AND (
                (status IN ('partial','failed') AND (metadata->>'${NO_RETRY_KEY}')::boolean IS NOT TRUE
                   AND (metadata->>'${TICK_CUT_KEY}')::boolean IS NOT TRUE)
                OR (status = 'running' AND started_at <= $3::timestamptz)))::int AS attempts,
            count(*) FILTER (WHERE status = 'running' AND started_at > $3::timestamptz)::int AS running,
            count(*) FILTER (WHERE started_at >= $2::timestamptz AND status = 'failed'
                AND (metadata->>'${TICK_CUT_KEY}')::boolean IS TRUE)::int AS cuts
       FROM job_run
      WHERE job_id = $1 AND workspace_id IS NULL AND (started_at >= $2::timestamptz OR status = 'running')`,
    [def.id, coverFrom.toISOString(), liveSince.toISOString()],
  );
  const r = rows[0];
  return { done: Number(r?.done ?? 0), attempts: Number(r?.attempts ?? 0), running: Number(r?.running ?? 0), cuts: Number(r?.cuts ?? 0) };
}

/** Lo que dice el estado de un tick: si toca correr, con qué intento y por qué; si no, por qué no. */
function verdict(state: TickState, def: JobDefinition): { skip: OnceSkipReason } | { attempt: number; reason: OnceReason } {
  if (state.running > 0) return { skip: 'running' };
  if (state.done > 0) return { skip: 'up_to_date' };
  if (state.attempts >= def.maxAttempts || state.cuts >= MAX_TICK_CUTS) return { skip: 'retries_exhausted' };
  return { attempt: state.attempts + state.cuts + 1, reason: state.attempts > 0 ? 'retry' : state.cuts > 0 ? 'resume' : 'due' };
}

function safeTick(def: JobDefinition, now: Date, logger: Logger): Date | null {
  if (!def.defaultCron) return null;
  try {
    return lastTick(def.defaultCron, now);
  } catch (err) {
    if (!(err instanceof CronError)) throw err;
    logger.error('cron inválido en job_definition: el job no corre en --once', { job: def.id, cron: def.defaultCron, err });
    return null;
  }
}

/**
 * Desde cuándo cuenta una corrida para cubrir el tick de `def`.
 *
 * Normalmente, su tick. Pero un job encadenado (compute.baseline tras
 * collect.post_metrics) corre en la misma pasada que el de arriba, ANTES
 * de su propio tick (05:18 frente a 05:40): sin esto, la pasada de las
 * 06:17 lo volvería a correr. Así que cuenta también lo que corrió desde
 * el último tick del de arriba, sin ir más atrás de su tick anterior.
 */
function coverFromFor(def: JobDefinition, tick: Date, registry: JobRegistry, all: ReadonlyMap<string, JobDefinition>, now: Date, logger: Logger): Date {
  const upstream = (registry.get(def.id)?.options.after ?? [])
    .map((id) => all.get(id))
    .filter((d): d is JobDefinition => !!d && d.enabled)
    .map((d) => safeTick(d, now, logger))
    .filter((t): t is Date => t !== null);
  if (upstream.length === 0) return tick;
  const latestUpstream = Math.max(...upstream.map((t) => t.getTime()));
  const previous = lastTick(def.defaultCron!, new Date(tick.getTime() - 60_000));
  const from = Math.min(tick.getTime(), latestUpstream);
  return new Date(previous ? Math.max(previous.getTime(), from) : from);
}

/**
 * Qué toca correr ahora: lo de arriba antes que lo encadenado, y luego por tick. Deja constancia de los que no tienen handler, como el proceso largo.
 * Las definiciones se evalúan a la vez (una consulta cada una): un turno sin nada vencido (CIM-7) sale en lo que tarda la más lenta, no en la suma.
 */
export async function planOnce(db: WorkerDatabase, config: WorkerConfig, registry: JobRegistry, now: Date, logger: Logger): Promise<{ due: DueJob[]; skipped: OnceSummary['skipped']; definitions: JobDefinition[] }> {
  const all = await loadJobDefinitions(db);
  const allById = new Map(all.map((d) => [d.id, d]));
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;

  const plan = async (def: JobDefinition): Promise<DueJob | { job: string; reason: OnceSkipReason }> => {
    if (!def.enabled) return { job: def.id, reason: 'disabled' };
    const registration = registry.get(def.id);
    if (!registration) {
      await recordSkipped(db, def.id);
      return { job: def.id, reason: 'no_handler' };
    }
    const tick = safeTick(def, now, logger);
    if (!tick) return { job: def.id, reason: 'no_cron' };

    const coverFrom = coverFromFor(def, tick, registry, allById, now, logger);
    const state = await tickState(db, def, coverFrom, now);
    const v = verdict(state, def);
    if ('skip' in v) {
      if (v.skip === 'retries_exhausted') {
        logger.warn('reintentos agotados hasta el próximo tick', { job: def.id, tick: tick.toISOString(), attempts: state.attempts, cuts: state.cuts, maxAttempts: def.maxAttempts });
      }
      return { job: def.id, reason: v.skip };
    }
    return { def, registration, coverFrom, attempt: v.attempt, reason: v.reason };
  };
  const planned = await Promise.all(definitions.map(plan));
  const due = planned.filter((p): p is DueJob => 'def' in p);
  const skipped: OnceSummary['skipped'] = planned.filter((p): p is { job: string; reason: OnceSkipReason } => !('def' in p));

  // Lo de arriba antes que lo de abajo: si compute.baseline corriera
  // antes que collect.post_metrics, el encadenado ya no correría con los
  // datos nuevos. Luego por tick (el más viejo primero) y por id.
  const depth = (id: string): number => {
    const after = registry.get(id)?.options.after ?? [];
    return after.length === 0 ? 0 : 1 + Math.max(...after.map(depth));
  };
  due.sort((a, b) => depth(a.def.id) - depth(b.def.id) || a.coverFrom.getTime() - b.coverFrom.getTime() || a.def.id.localeCompare(b.def.id));
  return { due, skipped, definitions };
}

/**
 * La misma regla que el proceso largo (worker.ts): un fallo por
 * elementos se reintenta salvo que el job diga `retry: false` o su
 * registro `retryOnItemFailure: false`; un fallo que lanzó, siempre.
 */
function shouldRetry(outcome: RunOutcome, registration: JobRegistration): boolean {
  if (outcome.status === 'ok') return false;
  const itemFailure = outcome.status === 'partial' || outcome.error instanceof JobItemsFailedError;
  return itemFailure ? (outcome.result?.retry ?? registration.options.retryOnItemFailure) : true;
}

interface PendingRun {
  def: JobDefinition;
  registration: JobRegistration;
  payload: Record<string, unknown>;
  /** Desde cuándo cubre su tick; null en un encadenado, que corre siempre que no haya otra viva. */
  coverFrom: Date | null;
  reason: OnceReason;
}

type Claim = { runId: number; attempt: number; reason: OnceReason } | { skip: OnceSkipReason };

/**
 * Reclama una corrida: con el candado del job, relee el estado de su
 * tick y, si sigue tocando, abre la fila `running` (started_at = el
 * reloj de la pasada, el mismo con el que se calculan los ticks) en la
 * misma transacción. Quien llega segundo espera el candado y ve esa
 * fila. Un encadenado solo mira que no haya otra viva.
 */
async function claimRun(db: WorkerDatabase, item: PendingRun, at: Date, bossJobId: string): Promise<Claim> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${JOB_LOCK_PREFIX}${item.def.id}`]);
    const state = await tickState(tx, item.def, item.coverFrom ?? at, at);
    let attempt = 1;
    let reason = item.reason;
    if (item.coverFrom) {
      const v = verdict(state, item.def);
      if ('skip' in v) return v;
      ({ attempt, reason } = v);
    } else if (state.running > 0) {
      return { skip: 'running' };
    }
    const { rows } = await tx.query<{ id: number | string }>(
      `INSERT INTO job_run (job_id, status, attempt, started_at, metadata)
       VALUES ($1, 'running', $2, $3::timestamptz, $4::jsonb) RETURNING id`,
      [item.def.id, attempt, at.toISOString(), JSON.stringify({ bossJobId })],
    );
    return { runId: Number(rows[0]?.id), attempt, reason };
  });
}

export async function runOnce(opts: RunOnceOptions): Promise<OnceSummary> {
  const { config, db, logger, budget } = opts;
  const env = opts.env ?? process.env;
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const registry = new JobRegistry(opts.jobs);
  // La cuota (platform.limits) se lee solo si algo va a correr: un turno sin nada vencido no la necesita.
  let quota: Promise<QuotaManager> | null = opts.quota ? Promise.resolve(opts.quota) : null;
  const getQuota = () => (quota ??= createQuota(db, logger, opts.now, opts.http));

  const { due, skipped, definitions } = await planOnce(db, config, registry, now, logger);
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const enabledIds = new Set(definitions.filter((d) => d.enabled).map((d) => d.id));
  logger.info('pasada: lo vencido', { at: now.toISOString(), due: due.map((d) => d.def.id), groups: config.groups ?? 'todos' });

  const runs: OnceRun[] = [];
  const ran = new Set<string>();
  let interrupted = 0;
  // Una pila: el encadenado corre enseguida después de su job de arriba.
  const pending: PendingRun[] =
    due.map((d) => ({ def: d.def, registration: d.registration, payload: { job: d.def.id, source: ONCE_SOURCE }, coverFrom: d.coverFrom, reason: d.reason })).reverse();

  const run = async (next: PendingRun): Promise<void> => {
    const bossJobId = `once:${randomUUID()}`;
    const runQuota = await getQuota();
    const claim = await claimRun(db, next, clock(), bossJobId);
    if ('skip' in claim) {
      skipped.push({ job: next.def.id, reason: claim.skip });
      return;
    }
    // En un turno, el job tiene lo que queda del presupuesto como timeout_s:
    // el que se mide por su timeout (outbound.dispatch) termina solo, a tiempo.
    const sliceS = budget ? Math.max(1, Math.floor((budget.deadline - Date.now()) / 1000)) : next.def.timeoutS;
    const definition = sliceS < next.def.timeoutS ? { ...next.def, timeoutS: sliceS } : next.def;
    const outcome = await executeRun(
      { definition, registration: next.registration, payload: next.payload, attempt: claim.attempt, bossJobId, signal: opts.signal, runId: claim.runId },
      { db, logger, secrets: opts.secrets, refreshers: opts.refreshers, quota: runQuota, http: opts.http, env, now: opts.now },
    );
    const cut = definition !== next.def && outcome.error instanceof JobTimeoutError;
    if (cut) {
      // No es un fallo del job: el turno siguiente lo retoma sin gastar un intento.
      await db.query(`UPDATE job_run SET metadata = metadata || jsonb_build_object($2::text, true) WHERE id = $1`, [outcome.runId, TICK_CUT_KEY]);
      logger.warn('corrida cortada por el presupuesto del turno: el siguiente la retoma', { job: next.def.id, runId: outcome.runId, sliceS, timeoutS: next.def.timeoutS });
    } else if (outcome.status !== 'ok' && !shouldRetry(outcome, next.registration)) {
      // La pasada siguiente lo da por cubierto, como pg-boss cuando no se lanza.
      await db.query(`UPDATE job_run SET metadata = metadata || jsonb_build_object($2::text, true) WHERE id = $1`, [outcome.runId, NO_RETRY_KEY]);
      logger.info('sin reintento: el job indicó que no ayuda', { job: next.def.id, runId: outcome.runId, status: outcome.status });
    }
    runs.push({
      job: next.def.id,
      reason: claim.reason,
      tick: next.coverFrom?.toISOString() ?? null,
      runId: outcome.runId,
      status: outcome.status,
      processed: outcome.result?.processed ?? 0,
      failed: outcome.result?.failed ?? 0,
      durationMs: outcome.durationMs,
      cut,
    });

    if (outcome.status !== 'failed' && (outcome.result?.processed ?? 0) > 0) {
      const nextIds = registry.next(next.def.id).filter((id) => enabledIds.has(id) && !ran.has(id));
      for (const id of [...nextIds].reverse()) {
        const def = byId.get(id);
        const registration = registry.get(id);
        if (!def || !registration) continue; // de otro grupo (WORKER_GROUPS): lo cubre su cron en su proceso
        pending.push({ def, registration, payload: { source: CHAIN_SOURCE, after: next.def.id }, coverFrom: null, reason: 'chained' });
      }
    }
  };

  // `concurrency` recorredores sobre la misma pila; con 1 (--once), una corrida detrás de otra.
  const walker = async (): Promise<void> => {
    for (let next = pending.pop(); next; next = pending.pop()) {
      if (ran.has(next.def.id)) continue;
      if (opts.signal?.aborted) {
        skipped.push({ job: next.def.id, reason: 'shutting_down' });
        interrupted++;
        continue;
      }
      if (budget && budget.deadline - Date.now() < budget.minSliceMs) {
        skipped.push({ job: next.def.id, reason: 'budget' });
        continue;
      }
      ran.add(next.def.id);
      await run(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(opts.concurrency ?? 1)) }, walker));

  const failedRuns = runs.filter((r) => r.status === 'failed' && !r.cut).length;
  const summary: OnceSummary = { at: now.toISOString(), runs, skipped, failedRuns, interrupted };
  logger.info('pasada terminada', {
    runs: runs.map((r) => `${r.job}:${r.status}`),
    upToDate: skipped.filter((s) => s.reason === 'up_to_date').map((s) => s.job),
    exhausted: skipped.filter((s) => s.reason === 'retries_exhausted').map((s) => s.job),
    ...(budget ? { cut: runs.filter((r) => r.cut).map((r) => r.job), noTime: skipped.filter((s) => s.reason === 'budget').map((s) => s.job) } : {}),
    failedRuns,
    interrupted,
    exitCode: onceExitCode(summary),
  });
  if (interrupted > 0) logger.warn('pasada interrumpida: estos jobs vencidos no empezaron', { jobs: skipped.filter((s) => s.reason === 'shutting_down').map((s) => s.job) });
  return summary;
}
