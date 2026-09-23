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
 * Dos pasadas a la vez: el workflow lo evita con `concurrency`; si aun
 * así se solaparan (o hubiera un proceso largo encendido), la fila
 * `running` viva de la primera hace que la segunda se salte ese job.
 */
import { randomUUID } from 'node:crypto';
import type { QuotaManager, ConnectorHttpOverrides, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import { EXPIRE_MARGIN_S } from './boss.ts';
import type { Env, WorkerConfig } from './config.ts';
import { CronError, lastTick } from './cron.ts';
import type { WorkerDatabase } from './db.ts';
import { loadJobDefinitions } from './definitions.ts';
import type { Logger } from './logger.ts';
import { JobRegistry, type JobDefinition, type JobRegistration } from './registry.ts';
import { CHAIN_SOURCE, executeRun, JobItemsFailedError, type RunOutcome, type RunStatus } from './run.ts';
import { createQuota, recordSkipped } from './worker.ts';

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
}

export type OnceReason = 'due' | 'retry' | 'chained';

export interface OnceRun {
  job: string;
  reason: OnceReason;
  /** Desde cuándo se está cubriendo el job, ISO; null en un encadenado. */
  tick: string | null;
  runId: number;
  status: RunStatus;
  processed: number;
  failed: number;
}

export type OnceSkipReason = 'up_to_date' | 'running' | 'retries_exhausted' | 'no_handler' | 'no_cron' | 'disabled' | 'shutting_down';

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

interface DueJob {
  def: JobDefinition;
  registration: JobRegistration;
  coverFrom: Date;
  attempt: number;
}

interface TickState extends Record<string, unknown> {
  done: number;
  attempts: number;
  running: number;
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
 */
async function tickState(db: WorkerDatabase, def: JobDefinition, coverFrom: Date, now: Date): Promise<TickState> {
  const liveSince = new Date(now.getTime() - (def.timeoutS + EXPIRE_MARGIN_S) * 1000);
  const { rows } = await db.query<TickState>(
    `SELECT count(*) FILTER (WHERE started_at >= $2::timestamptz AND (
                status IN ('ok','skipped')
                OR (status IN ('partial','failed') AND (metadata->>'${NO_RETRY_KEY}')::boolean IS TRUE)))::int AS done,
            count(*) FILTER (WHERE started_at >= $2::timestamptz AND (
                (status IN ('partial','failed') AND (metadata->>'${NO_RETRY_KEY}')::boolean IS NOT TRUE)
                OR (status = 'running' AND started_at <= $3::timestamptz)))::int AS attempts,
            count(*) FILTER (WHERE status = 'running' AND started_at > $3::timestamptz)::int AS running
       FROM job_run
      WHERE job_id = $1 AND workspace_id IS NULL AND (started_at >= $2::timestamptz OR status = 'running')`,
    [def.id, coverFrom.toISOString(), liveSince.toISOString()],
  );
  const r = rows[0];
  return { done: Number(r?.done ?? 0), attempts: Number(r?.attempts ?? 0), running: Number(r?.running ?? 0) };
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

/** Qué toca correr ahora: lo de arriba antes que lo encadenado, y luego por tick. Deja constancia de los que no tienen handler, como el proceso largo. */
export async function planOnce(db: WorkerDatabase, config: WorkerConfig, registry: JobRegistry, now: Date, logger: Logger): Promise<{ due: DueJob[]; skipped: OnceSummary['skipped']; definitions: JobDefinition[] }> {
  const all = await loadJobDefinitions(db);
  const allById = new Map(all.map((d) => [d.id, d]));
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;
  const due: DueJob[] = [];
  const skipped: OnceSummary['skipped'] = [];

  for (const def of definitions) {
    if (!def.enabled) { skipped.push({ job: def.id, reason: 'disabled' }); continue; }
    const registration = registry.get(def.id);
    if (!registration) {
      await recordSkipped(db, def.id);
      skipped.push({ job: def.id, reason: 'no_handler' });
      continue;
    }
    const tick = safeTick(def, now, logger);
    if (!tick) { skipped.push({ job: def.id, reason: 'no_cron' }); continue; }

    const coverFrom = coverFromFor(def, tick, registry, allById, now, logger);
    const state = await tickState(db, def, coverFrom, now);
    if (state.running > 0) { skipped.push({ job: def.id, reason: 'running' }); continue; }
    if (state.done > 0) { skipped.push({ job: def.id, reason: 'up_to_date' }); continue; }
    if (state.attempts >= def.maxAttempts) {
      logger.warn('reintentos agotados hasta el próximo tick', { job: def.id, tick: tick.toISOString(), attempts: state.attempts, maxAttempts: def.maxAttempts });
      skipped.push({ job: def.id, reason: 'retries_exhausted' });
      continue;
    }
    due.push({ def, registration, coverFrom, attempt: state.attempts + 1 });
  }

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

export async function runOnce(opts: RunOnceOptions): Promise<OnceSummary> {
  const { config, db, logger } = opts;
  const env = opts.env ?? process.env;
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const registry = new JobRegistry(opts.jobs);
  const quota = opts.quota ?? await createQuota(db, logger, opts.now, opts.http);

  const { due, skipped, definitions } = await planOnce(db, config, registry, now, logger);
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const enabledIds = new Set(definitions.filter((d) => d.enabled).map((d) => d.id));
  logger.info('pasada: lo vencido', { at: now.toISOString(), due: due.map((d) => d.def.id), groups: config.groups ?? 'todos' });

  const runs: OnceRun[] = [];
  const ran = new Set<string>();
  let interrupted = 0;
  // Una pila: el encadenado corre enseguida después de su job de arriba.
  const pending: Array<{ def: JobDefinition; registration: JobRegistration; payload: Record<string, unknown>; attempt: number; coverFrom: Date | null; reason: OnceReason }> =
    due.map((d) => ({ def: d.def, registration: d.registration, payload: { job: d.def.id, source: ONCE_SOURCE }, attempt: d.attempt, coverFrom: d.coverFrom, reason: d.attempt > 1 ? 'retry' as const : 'due' as const })).reverse();

  while (pending.length > 0) {
    const next = pending.pop()!;
    if (ran.has(next.def.id)) continue;
    if (opts.signal?.aborted) {
      skipped.push({ job: next.def.id, reason: 'shutting_down' });
      interrupted++;
      continue;
    }
    ran.add(next.def.id);
    const outcome = await executeRun(
      { definition: next.def, registration: next.registration, payload: next.payload, attempt: next.attempt, bossJobId: `once:${randomUUID()}`, signal: opts.signal },
      { db, logger, secrets: opts.secrets, refreshers: opts.refreshers, quota, http: opts.http, env, now: opts.now },
    );
    if (outcome.status !== 'ok' && !shouldRetry(outcome, next.registration)) {
      // La pasada siguiente lo da por cubierto, como pg-boss cuando no se lanza.
      await db.query(`UPDATE job_run SET metadata = metadata || jsonb_build_object($2::text, true) WHERE id = $1`, [outcome.runId, NO_RETRY_KEY]);
      logger.info('sin reintento: el job indicó que no ayuda', { job: next.def.id, runId: outcome.runId, status: outcome.status });
    }
    runs.push({
      job: next.def.id,
      reason: next.reason,
      tick: next.coverFrom?.toISOString() ?? null,
      runId: outcome.runId,
      status: outcome.status,
      processed: outcome.result?.processed ?? 0,
      failed: outcome.result?.failed ?? 0,
    });

    if (outcome.status !== 'failed' && (outcome.result?.processed ?? 0) > 0) {
      const nextIds = registry.next(next.def.id).filter((id) => enabledIds.has(id) && !ran.has(id));
      for (const id of [...nextIds].reverse()) {
        const def = byId.get(id);
        const registration = registry.get(id);
        if (!def || !registration) continue; // de otro grupo (WORKER_GROUPS): lo cubre su cron en su proceso
        pending.push({ def, registration, payload: { source: CHAIN_SOURCE, after: next.def.id }, attempt: 1, coverFrom: null, reason: 'chained' });
      }
    }
  }

  const failedRuns = runs.filter((r) => r.status === 'failed').length;
  const summary: OnceSummary = { at: now.toISOString(), runs, skipped, failedRuns, interrupted };
  logger.info('pasada terminada', {
    runs: runs.map((r) => `${r.job}:${r.status}`),
    upToDate: skipped.filter((s) => s.reason === 'up_to_date').map((s) => s.job),
    exhausted: skipped.filter((s) => s.reason === 'retries_exhausted').map((s) => s.job),
    failedRuns,
    interrupted,
    exitCode: onceExitCode(summary),
  });
  if (interrupted > 0) logger.warn('pasada interrumpida: estos jobs vencidos no empezaron', { jobs: skipped.filter((s) => s.reason === 'shutting_down').map((s) => s.job) });
  return summary;
}
