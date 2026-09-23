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
 *     alguna ok, partial o skipped        → al día, no corre
 *     alguna running dentro de su timeout → otra pasada lo está corriendo
 *     fallidas ≥ max_attempts             → reintentos agotados hasta el
 *                                           próximo tick (se avisa)
 *     si no                               → corre, attempt = fallidas + 1
 *
 * Así una pasada corre lo vencido, la siguiente no repite lo ya corrido
 * y un fallo se reintenta en la pasada siguiente hasta max_attempts,
 * que es lo que hacía pg-boss con su backoff.
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
 * así se solaparan, la fila `running` de la primera hace que la segunda
 * se salte ese job.
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
import { CHAIN_SOURCE, executeRun, type RunStatus } from './run.ts';
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

export type OnceReason = 'vencido' | 'reintento' | 'encadenado';

export interface OnceRun {
  job: string;
  reason: OnceReason;
  /** El tick que se está cubriendo, ISO; null en un encadenado. */
  tick: string | null;
  runId: number;
  status: RunStatus;
  processed: number;
  failed: number;
}

export type OnceSkipReason = 'al_dia' | 'corriendo' | 'reintentos_agotados' | 'sin_handler' | 'sin_cron' | 'deshabilitado' | 'apagando';

export interface OnceSummary {
  /** ISO del reloj con el que se calcularon los ticks. */
  at: string;
  runs: OnceRun[];
  skipped: Array<{ job: string; reason: OnceSkipReason }>;
  /** Corridas que terminaron failed. El proceso sale con 1 si hay alguna. */
  failedRuns: number;
}

interface DueJob {
  def: JobDefinition;
  registration: JobRegistration;
  tick: Date;
  attempt: number;
}

interface TickState extends Record<string, unknown> {
  done: number;
  failed: number;
  running: number;
}

/**
 * El estado de un job desde su último tick, contando solo las corridas
 * globales: una corrida encadenada o manual de UN workspace no cubre el
 * tick de todos.
 */
async function tickState(db: WorkerDatabase, def: JobDefinition, tick: Date, now: Date): Promise<TickState> {
  const vivaDesde = new Date(now.getTime() - (def.timeoutS + EXPIRE_MARGIN_S) * 1000);
  const { rows } = await db.query<TickState>(
    `SELECT count(*) FILTER (WHERE status IN ('ok','partial','skipped'))::int AS done,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'running' AND started_at > $3::timestamptz)::int AS running
       FROM job_run
      WHERE job_id = $1 AND workspace_id IS NULL AND started_at >= $2::timestamptz`,
    [def.id, tick.toISOString(), vivaDesde.toISOString()],
  );
  const r = rows[0];
  return { done: Number(r?.done ?? 0), failed: Number(r?.failed ?? 0), running: Number(r?.running ?? 0) };
}

/** Qué toca correr ahora: lo de arriba antes que lo encadenado, y luego por tick. Deja constancia de los que no tienen handler, como el proceso largo. */
export async function planOnce(db: WorkerDatabase, config: WorkerConfig, registry: JobRegistry, now: Date, logger: Logger): Promise<{ due: DueJob[]; skipped: OnceSummary['skipped']; definitions: JobDefinition[] }> {
  const all = await loadJobDefinitions(db);
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;
  const due: DueJob[] = [];
  const skipped: OnceSummary['skipped'] = [];

  for (const def of definitions) {
    if (!def.enabled) { skipped.push({ job: def.id, reason: 'deshabilitado' }); continue; }
    const registration = registry.get(def.id);
    if (!registration) {
      await recordSkipped(db, def.id);
      skipped.push({ job: def.id, reason: 'sin_handler' });
      continue;
    }
    let tick: Date | null = null;
    try {
      tick = def.defaultCron ? lastTick(def.defaultCron, now) : null;
    } catch (err) {
      if (!(err instanceof CronError)) throw err;
      logger.error('cron inválido en job_definition: el job no corre en --once', { job: def.id, cron: def.defaultCron, err });
    }
    if (!tick) { skipped.push({ job: def.id, reason: 'sin_cron' }); continue; }

    const state = await tickState(db, def, tick, now);
    if (state.done > 0) { skipped.push({ job: def.id, reason: 'al_dia' }); continue; }
    if (state.running > 0) { skipped.push({ job: def.id, reason: 'corriendo' }); continue; }
    if (state.failed >= def.maxAttempts) {
      logger.warn('reintentos agotados hasta el próximo tick', { job: def.id, tick: tick.toISOString(), failed: state.failed, maxAttempts: def.maxAttempts });
      skipped.push({ job: def.id, reason: 'reintentos_agotados' });
      continue;
    }
    due.push({ def, registration, tick, attempt: state.failed + 1 });
  }

  // Lo de arriba antes que lo de abajo: si compute.baseline corriera
  // antes que collect.post_metrics, el encadenado ya no correría con los
  // datos nuevos. Luego por tick (el más viejo primero) y por id.
  const depth = (id: string): number => {
    const after = registry.get(id)?.options.after ?? [];
    return after.length === 0 ? 0 : 1 + Math.max(...after.map(depth));
  };
  due.sort((a, b) => depth(a.def.id) - depth(b.def.id) || a.tick.getTime() - b.tick.getTime() || a.def.id.localeCompare(b.def.id));
  return { due, skipped, definitions };
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
  // Una pila: el encadenado corre enseguida después de su job de arriba.
  const pending: Array<{ def: JobDefinition; registration: JobRegistration; payload: Record<string, unknown>; attempt: number; tick: Date | null; reason: OnceReason }> =
    due.map((d) => ({ def: d.def, registration: d.registration, payload: { job: d.def.id, source: ONCE_SOURCE }, attempt: d.attempt, tick: d.tick, reason: d.attempt > 1 ? 'reintento' as const : 'vencido' as const })).reverse();

  while (pending.length > 0) {
    const next = pending.pop()!;
    if (ran.has(next.def.id)) continue;
    if (opts.signal?.aborted) {
      skipped.push({ job: next.def.id, reason: 'apagando' });
      continue;
    }
    ran.add(next.def.id);
    const outcome = await executeRun(
      { definition: next.def, registration: next.registration, payload: next.payload, attempt: next.attempt, bossJobId: `once:${randomUUID()}`, signal: opts.signal },
      { db, logger, secrets: opts.secrets, refreshers: opts.refreshers, quota, http: opts.http, env, now: opts.now },
    );
    runs.push({
      job: next.def.id,
      reason: next.reason,
      tick: next.tick?.toISOString() ?? null,
      runId: outcome.runId,
      status: outcome.status,
      processed: outcome.result?.processed ?? 0,
      failed: outcome.result?.failed ?? 0,
    });

    if (outcome.status !== 'failed' && (outcome.result?.processed ?? 0) > 0) {
      const siguientes = registry.next(next.def.id).filter((id) => enabledIds.has(id) && !ran.has(id));
      for (const id of [...siguientes].reverse()) {
        const def = byId.get(id);
        const registration = registry.get(id);
        if (!def || !registration) continue; // de otro grupo (WORKER_GROUPS): lo cubre su cron en su proceso
        pending.push({ def, registration, payload: { source: CHAIN_SOURCE, after: next.def.id }, attempt: 1, tick: null, reason: 'encadenado' });
      }
    }
  }

  const failedRuns = runs.filter((r) => r.status === 'failed').length;
  logger.info('pasada terminada', {
    runs: runs.map((r) => `${r.job}:${r.status}`),
    upToDate: skipped.filter((s) => s.reason === 'al_dia').map((s) => s.job),
    exhausted: skipped.filter((s) => s.reason === 'reintentos_agotados').map((s) => s.job),
    failedRuns,
  });
  return { at: now.toISOString(), runs, skipped, failedRuns };
}
