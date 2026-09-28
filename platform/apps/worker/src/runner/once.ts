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
 *     alguna running viva (< timeout + 30 s)   → otra pasada lo tiene
 *       (timeout: el de la definición, o el sliceS del turno que la abrió)
 *     alguna ok o skipped, o un fallo que
 *       pidió no reintentar (retry: false)   → al día, no corre
 *     intentos ≥ max_attempts                → reintentos agotados hasta
 *                                              el próximo tick (se avisa)
 *     el último intento empezó hace menos
 *       de su backoff                        → espera (`backoff`)
 *     si no                                  → corre, attempt = intentos + 1
 *   (intentos = partial o failed reintentables + running colgadas;
 *    backoff = WORKER_RETRY_DELAY_S·2^(intentos−1), con techo
 *    WORKER_RETRY_DELAY_MAX_S: el de pg-boss en el proceso largo)
 *
 * Así una pasada corre lo vencido, la siguiente no repite lo ya corrido
 * y un fallo se reintenta en una pasada posterior, pasada su espera,
 * hasta max_attempts: la misma regla de reintento que el proceso largo
 * (worker.ts, queueOptionsFor en boss.ts), sin el jitter de pg-boss.
 *
 * Encadenamiento (JobOptions.after): igual que en el proceso largo, si
 * un job termina ok o partial con processed > 0, lo que corre después
 * se corre enseguida, con `{ source: 'chain', after }` en el payload. En
 * una pasada cada job corre como mucho una vez.
 *
 * Las corridas van una detrás de otra: primero lo que no corre después
 * de nada (collect.*), luego lo encadenado (compute.*), y dentro de cada
 * nivel por tick, el más viejo primero. Con timeout_s de 60–600 s por
 * job, una pasada completa cabe de sobra en el límite de un runner de
 * GitHub. Cómo se recorre esa pila es lo único que cambia el modo por
 * turnos (`walk`, abajo).
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
 * Modo por turnos (CIM-7, src/tick.ts): la misma pasada, recorrida por
 * src/turno/recorrer.ts (presupuesto, varios recorredores) a través de
 * `walk`. Aquí queda solo lo que comparte con --once: el reclamo, el
 * estado de los ticks en una consulta, el backoff del reintento y el
 * corte. A la corrida que empieza el turno le da como timeout_s lo que
 * le queda (`deadline`); la que aun así se pasa termina `failed` con
 * `timeout` y `metadata.tickCut`, en la misma escritura que cierra la
 * fila (RunInput.closeMetadata). Un corte no gasta un intento: el turno
 * siguiente la retoma (reason `resume`), hasta MAX_TICK_CUTS cortes por
 * tick del cron.
 *
 * Lo que tocó CIM-7 (Rasheed) en runner/, la carpeta de Nicolás, y por
 * qué, en apps/worker/README.md («Por turnos · lo que se tocó en
 * runner/»). Pendiente de su revisión antes del merge a main.
 */
import { randomUUID } from 'node:crypto';
import type { QuotaManager, ConnectorHttpOverrides, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import { TICK_CUT_KEY } from '@mc/db/queries/worker';
import { createQuota, EXPIRE_MARGIN_S, JOB_LOCK_PREFIX, recordSkipped, SKIPPED_NO_HANDLER } from './comun.ts';
import type { Env, WorkerConfig } from './config.ts';
import { CronError, lastTick } from './cron.ts';
import type { Queryable, WorkerDatabase } from './db.ts';
import { loadJobDefinitions } from './definitions.ts';
import type { Logger } from './logger.ts';
import { JobRegistry, type JobDefinition, type JobRegistration } from './registry.ts';
import { CHAIN_SOURCE, executeRun, JobItemsFailedError, JobTimeoutError, type RunOutcome, type RunStatus } from './run.ts';

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
  /** Cómo se recorre lo pendiente. Por defecto, --once: sequentialWalk. El turno (CIM-7) pone el suyo. */
  walk?: Walk;
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

/**
 * budget: vencido pero sin tiempo en el turno para empezarlo; sigue vencido para el siguiente.
 * backoff: falló hace menos de su espera de reintento (retryDelayFor); la pasada que llegue después lo reintenta.
 */
export type OnceSkipReason = 'up_to_date' | 'running' | 'retries_exhausted' | 'backoff' | 'no_handler' | 'no_cron' | 'disabled' | 'shutting_down' | 'budget';

export interface OnceSummary {
  /** ISO del reloj con el que se calcularon los ticks. */
  at: string;
  runs: OnceRun[];
  skipped: Array<{ job: string; reason: OnceSkipReason }>;
  /** Corridas que terminaron failed. */
  failedRuns: number;
  /** Jobs vencidos que no llegaron a empezar porque llegó una señal. */
  interrupted: number;
  /** Lo que tardó la planificación (definiciones, estado de los ticks): el costo de un turno sin nada vencido. */
  planMs: number;
}

/** El proceso sale con 1 si hubo una corrida fallida o una pasada interrumpida: el cron externo la marca en rojo. */
export function onceExitCode(s: OnceSummary): 0 | 1 {
  return s.failedRuns > 0 || s.interrupted > 0 ? 1 : 0;
}

/** Marca en job_run.metadata de una corrida que el job pidió no reintentar (`retry: false`). */
export const NO_RETRY_KEY = 'noRetry';
/** Marca en job_run.metadata de una corrida que cortó el presupuesto del turno (CIM-7): no cuenta como intento. La lee también la salud (@mc/db/queries/worker). */
export { TICK_CUT_KEY };
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
  /** Cuándo empezó el último intento fallido del tick (lo que cuenta en `attempts`); null si no hay. */
  lastFailedAt: Date | null;
}

const EMPTY_STATE: TickState = { done: 0, attempts: 0, running: 0, cuts: 0, lastFailedAt: null };

/** La espera entre reintentos, la misma que el proceso largo da a pg-boss (queueOptionsFor en boss.ts). */
export interface RetryBackoff {
  /** WORKER_RETRY_DELAY_S: la espera tras el primer fallo. */
  delayS: number;
  /** WORKER_RETRY_DELAY_MAX_S: el techo. */
  maxS: number;
}

export function retryBackoffFrom(config: Pick<WorkerConfig, 'retryDelayS' | 'retryDelayMaxS'>): RetryBackoff {
  return { delayS: config.retryDelayS, maxS: config.retryDelayMaxS };
}

/**
 * Cuánto se espera antes del reintento que sigue a `attempts` fallos:
 * delayS·2^(attempts−1), con techo maxS. Es el backoff exponencial de
 * pg-boss (retryBackoff: true, retryDelay, retryDelayMax) sin su jitter.
 */
export function retryDelayMs(attempts: number, backoff: RetryBackoff): number {
  if (attempts <= 0) return 0;
  const s = Math.min(backoff.delayS * 2 ** Math.min(attempts - 1, 30), backoff.maxS);
  return Math.max(0, s) * 1000;
}

/** Sin espera entre reintentos: lo que usa claimRun si quien llama no pasa la de su configuración. */
const NO_BACKOFF: RetryBackoff = { delayS: 0, maxS: 0 };

/** La marca en la metadata del reclamo: el timeout que de verdad tiene la corrida en un turno (CIM-7). */
export const SLICE_KEY = 'sliceS';

interface StateQuery {
  def: JobDefinition;
  coverFrom: Date;
}

/**
 * El estado de varios jobs, cada uno desde su `coverFrom`, en UNA
 * consulta (un turno sin nada vencido gasta una conexión y no una por
 * definición), contando solo las corridas globales: una corrida
 * encadenada o manual de UN workspace no cubre el tick de todos.
 *
 *   done      ok o skipped; o partial/failed que pidió no reintentar
 *   attempts  partial o failed que sí se reintentan, y las `running`
 *             colgadas, para que max_attempts también las cuente
 *   running   `running` viva, EMPIECE CUANDO EMPIECE: una corrida de
 *             antes del tick que sigue en marcha tampoco se pisa
 *   cuts      failed por el presupuesto de un turno (tickCut): no son
 *             intentos, el turno siguiente las retoma (MAX_TICK_CUTS)
 *
 * Una `running` está viva mientras no pase su timeout más
 * EXPIRE_MARGIN_S: el de job_definition o, si la abrió un turno, el que
 * tuvo de verdad (metadata.sliceS, unos 40 s). Así la fila de un turno
 * que murió a mitad (Vercel lo mató, un redeploy) deja de bloquear su job
 * al minuto y no a los timeout_s (600 s en collect.post_metrics).
 */
async function tickStates(db: Queryable, items: readonly StateQuery[], now: Date): Promise<Map<string, TickState>> {
  const out = new Map<string, TickState>();
  if (items.length === 0) return out;
  const { rows } = await db.query<Omit<TickState, 'lastFailedAt'> & { job_id: string; last_failed_at: Date | string | null }>(
    `WITH t(job_id, cover_from, timeout_s) AS (SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::int[])),
          r AS (
            SELECT t.job_id, t.cover_from, j.status, j.started_at, j.metadata,
                   j.started_at > $4::timestamptz - make_interval(secs => (coalesce(
                     CASE WHEN j.metadata->>'${SLICE_KEY}' ~ '^[0-9]{1,6}$' THEN (j.metadata->>'${SLICE_KEY}')::int END,
                     t.timeout_s) + ${EXPIRE_MARGIN_S})::double precision) AS live
              FROM t JOIN job_run j
                ON j.job_id = t.job_id AND j.workspace_id IS NULL AND (j.started_at >= t.cover_from OR j.status = 'running'))
     SELECT t.job_id,
            count(r.job_id) FILTER (WHERE r.started_at >= r.cover_from AND (
                r.status IN ('ok','skipped')
                OR (r.status IN ('partial','failed') AND (r.metadata->>'${NO_RETRY_KEY}')::boolean IS TRUE)))::int AS done,
            count(r.job_id) FILTER (WHERE r.started_at >= r.cover_from AND (
                (r.status IN ('partial','failed') AND (r.metadata->>'${NO_RETRY_KEY}')::boolean IS NOT TRUE
                   AND (r.metadata->>'${TICK_CUT_KEY}')::boolean IS NOT TRUE)
                OR (r.status = 'running' AND NOT r.live)))::int AS attempts,
            count(r.job_id) FILTER (WHERE r.status = 'running' AND r.live)::int AS running,
            count(r.job_id) FILTER (WHERE r.started_at >= r.cover_from AND r.status = 'failed'
                AND (r.metadata->>'${TICK_CUT_KEY}')::boolean IS TRUE)::int AS cuts,
            max(r.started_at) FILTER (WHERE r.started_at >= r.cover_from AND (
                (r.status IN ('partial','failed') AND (r.metadata->>'${NO_RETRY_KEY}')::boolean IS NOT TRUE
                   AND (r.metadata->>'${TICK_CUT_KEY}')::boolean IS NOT TRUE)
                OR (r.status = 'running' AND NOT r.live))) AS last_failed_at
       FROM t LEFT JOIN r ON r.job_id = t.job_id
      GROUP BY t.job_id`,
    [items.map((i) => i.def.id), items.map((i) => i.coverFrom.toISOString()), items.map((i) => i.def.timeoutS), now.toISOString()],
  );
  for (const r of rows) {
    out.set(r.job_id, {
      done: Number(r.done ?? 0),
      attempts: Number(r.attempts ?? 0),
      running: Number(r.running ?? 0),
      cuts: Number(r.cuts ?? 0),
      lastFailedAt: r.last_failed_at ? new Date(r.last_failed_at) : null,
    });
  }
  return out;
}

async function tickState(db: Queryable, def: JobDefinition, coverFrom: Date, now: Date): Promise<TickState> {
  return (await tickStates(db, [{ def, coverFrom }], now)).get(def.id) ?? EMPTY_STATE;
}

/**
 * Lo que dice el estado de un tick: si toca correr, con qué intento y por qué; si no, por qué no.
 *
 * Un fallo espera su backoff antes del reintento, como en el proceso
 * largo: sin esto, en modo por turnos (una pasada por minuto) un
 * proveedor caído o que responde 429 recibiría max_attempts golpes en
 * max_attempts minutos. La espera se mide desde que EMPEZÓ el intento
 * fallido (started_at, que se escribe con el reloj de la pasada, el
 * mismo de `now`; finished_at lo pone el now() de la base).
 */
function verdict(state: TickState, def: JobDefinition, now: Date, backoff: RetryBackoff): { skip: OnceSkipReason } | { attempt: number; reason: OnceReason } {
  if (state.running > 0) return { skip: 'running' };
  if (state.done > 0) return { skip: 'up_to_date' };
  if (state.attempts >= def.maxAttempts || state.cuts >= MAX_TICK_CUTS) return { skip: 'retries_exhausted' };
  if (state.attempts > 0 && state.lastFailedAt && now.getTime() < state.lastFailedAt.getTime() + retryDelayMs(state.attempts, backoff)) {
    return { skip: 'backoff' };
  }
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
 * La fila «sin handler» (recordSkipped) de las definiciones sin handler,
 * pero solo de las que todavía no la tienen como última: se mira en una
 * consulta, y la transacción con candado de recordSkipped se abre solo
 * cuando hace falta escribir (una vez por job, no una cada turno).
 */
async function recordUnhandled(db: WorkerDatabase, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await db.query<{ job_id: string; status: string; error: string | null }>(
    `SELECT DISTINCT ON (job_id) job_id, status, error FROM job_run WHERE job_id = ANY($1::text[]) ORDER BY job_id, id DESC`,
    [ids],
  );
  const marked = new Set(rows.filter((r) => r.status === 'skipped' && r.error === SKIPPED_NO_HANDLER).map((r) => r.job_id));
  for (const id of ids) if (!marked.has(id)) await recordSkipped(db, id);
}

/**
 * Qué toca correr ahora: lo de arriba antes que lo encadenado, y luego por tick. Deja constancia de los que no tienen handler, como el proceso largo.
 * El estado de todos los ticks sale de una sola consulta (tickStates): un turno sin nada vencido (CIM-7) son tres consultas por una conexión.
 */
export async function planOnce(db: WorkerDatabase, config: WorkerConfig, registry: JobRegistry, now: Date, logger: Logger): Promise<{ due: DueJob[]; skipped: OnceSummary['skipped']; definitions: JobDefinition[] }> {
  const all = await loadJobDefinitions(db);
  const allById = new Map(all.map((d) => [d.id, d]));
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;

  type Planned = DueJob | { job: string; reason: OnceSkipReason };
  const planned: Planned[] = [];
  const candidates: Array<{ index: number; def: JobDefinition; registration: JobRegistration; tick: Date; coverFrom: Date }> = [];
  const unhandled: string[] = [];
  for (const def of definitions) {
    if (!def.enabled) {
      planned.push({ job: def.id, reason: 'disabled' });
      continue;
    }
    const registration = registry.get(def.id);
    if (!registration) {
      unhandled.push(def.id);
      planned.push({ job: def.id, reason: 'no_handler' });
      continue;
    }
    const tick = safeTick(def, now, logger);
    if (!tick) {
      planned.push({ job: def.id, reason: 'no_cron' });
      continue;
    }
    candidates.push({ index: planned.length, def, registration, tick, coverFrom: coverFromFor(def, tick, registry, allById, now, logger) });
    planned.push({ job: def.id, reason: 'up_to_date' }); // se reemplaza abajo con su veredicto
  }
  await recordUnhandled(db, unhandled);

  const states = await tickStates(db, candidates, now);
  const backoff = retryBackoffFrom(config);
  for (const c of candidates) {
    const state = states.get(c.def.id) ?? EMPTY_STATE;
    const v = verdict(state, c.def, now, backoff);
    if ('skip' in v) {
      if (v.skip === 'retries_exhausted') {
        logger.warn('reintentos agotados hasta el próximo tick', { job: c.def.id, tick: c.tick.toISOString(), attempts: state.attempts, cuts: state.cuts, maxAttempts: c.def.maxAttempts });
      }
      planned[c.index] = { job: c.def.id, reason: v.skip };
    } else {
      planned[c.index] = { def: c.def, registration: c.registration, coverFrom: c.coverFrom, attempt: v.attempt, reason: v.reason };
    }
  }
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
function shouldRetry(outcome: Pick<RunOutcome, 'status' | 'result' | 'error'>, registration: JobRegistration): boolean {
  if (outcome.status === 'ok') return false;
  const itemFailure = outcome.status === 'partial' || outcome.error instanceof JobItemsFailedError;
  return itemFailure ? (outcome.result?.retry ?? registration.options.retryOnItemFailure) : true;
}

/** Una corrida por reclamar. Exportada para las pruebas del reclamo (test/once-reclamo.test.ts). */
export interface PendingRun {
  def: JobDefinition;
  registration: JobRegistration;
  payload: Record<string, unknown>;
  /** Desde cuándo cubre su tick; null en un encadenado, que corre siempre que no haya otra viva. */
  coverFrom: Date | null;
  reason: OnceReason;
}

export type Claim = { runId: number; attempt: number; reason: OnceReason } | { skip: OnceSkipReason };

/**
 * Reclama una corrida: con el candado del job, relee el estado de su
 * tick y, si sigue tocando, abre la fila `running` (started_at = el
 * reloj de la pasada, el mismo con el que se calculan los ticks) en la
 * misma transacción. Quien llega segundo espera el candado y ve esa
 * fila. Un encadenado solo mira que no haya otra viva.
 *
 * El candado es lo único que lo hace atómico en Postgres de verdad (READ
 * COMMITTED, dos conexiones): sin él las dos transacciones leen «nada
 * corriendo» antes de que ninguna inserte. test/once-reclamo.test.ts lo
 * comprueba intercalándolas, y test/tick-postgres.test.ts con dos pools.
 *
 * `sliceS`, en un turno, es el timeout que va a tener la corrida: queda
 * en la metadata del reclamo para que tickStates dé por muerta a tiempo
 * la fila de un turno que no llegó a cerrarla.
 */
export async function claimRun(db: WorkerDatabase, item: PendingRun, at: Date, bossJobId: string, sliceS?: number, backoff: RetryBackoff = NO_BACKOFF): Promise<Claim> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${JOB_LOCK_PREFIX}${item.def.id}`]);
    const state = await tickState(tx, item.def, item.coverFrom ?? at, at);
    let attempt = 1;
    let reason = item.reason;
    if (item.coverFrom) {
      const v = verdict(state, item.def, at, backoff);
      if ('skip' in v) return v;
      ({ attempt, reason } = v);
    } else if (state.running > 0) {
      return { skip: 'running' };
    }
    const { rows } = await tx.query<{ id: number | string }>(
      `INSERT INTO job_run (job_id, status, attempt, started_at, metadata)
       VALUES ($1, 'running', $2, $3::timestamptz, $4::jsonb) RETURNING id`,
      [item.def.id, attempt, at.toISOString(), JSON.stringify({ bossJobId, ...(sliceS !== undefined ? { [SLICE_KEY]: sliceS } : {}) })],
    );
    return { runId: Number(rows[0]?.id), attempt, reason };
  });
}

/**
 * Cómo se recorre la pila de lo pendiente: el punto de extensión del modo
 * por turnos (CIM-7). --once usa sequentialWalk; el turno, el suyo
 * (src/turno/recorrer.ts: presupuesto, varios recorredores, lo urgente
 * primero). El recorrido solo decide QUÉ empieza y CUÁNDO: el reclamo,
 * la corrida, las marcas y el encadenado los hace `run`.
 */
export interface WalkControl {
  /** La pila: el siguiente sale del final. `run` apila aquí lo encadenado. */
  readonly pending: PendingRun[];
  /** Los jobs que ya empezaron en esta pasada: cada uno corre como mucho una vez. */
  readonly ran: ReadonlySet<string>;
  readonly signal?: AbortSignal;
  /**
   * Reclama y corre `item`, y apila lo que va después. Con `deadline` (ms de
   * Date.now()), la corrida tiene como timeout_s lo que queda hasta ahí, si
   * es menos que el suyo; si aun así se pasa, termina con tickCut y el
   * turno siguiente la retoma sin gastar un intento.
   */
  run(item: PendingRun, deadline?: number): Promise<void>;
  /** Un pendiente que no empieza, y por qué (shutting_down cuenta como pasada interrumpida). */
  skip(item: PendingRun, reason: OnceSkipReason): void;
}

export type Walk = (control: WalkControl) => Promise<void>;

/** --once: una corrida detrás de otra, sin límite de tiempo; con la señal abortada no empieza nada más. */
export const sequentialWalk: Walk = async (c) => {
  while (c.pending.length > 0) {
    const next = c.pending.pop()!;
    if (c.ran.has(next.def.id)) continue;
    if (c.signal?.aborted) {
      c.skip(next, 'shutting_down');
      continue;
    }
    await c.run(next);
  }
};

export async function runOnce(opts: RunOnceOptions): Promise<OnceSummary> {
  const { config, db, logger } = opts;
  const env = opts.env ?? process.env;
  const clock = opts.now ?? (() => new Date());
  const now = clock();
  const registry = new JobRegistry(opts.jobs);
  const backoff = retryBackoffFrom(config);
  // La cuota (platform.limits) se lee solo si algo va a correr: un turno sin nada vencido no la necesita.
  let quota: Promise<QuotaManager> | null = opts.quota ? Promise.resolve(opts.quota) : null;
  const getQuota = () => (quota ??= createQuota(db, logger, opts.now, opts.http));

  const planStarted = Date.now();
  const { due, skipped, definitions } = await planOnce(db, config, registry, now, logger);
  const planMs = Date.now() - planStarted;
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const enabledIds = new Set(definitions.filter((d) => d.enabled).map((d) => d.id));
  logger.info('pasada: lo vencido', { at: now.toISOString(), due: due.map((d) => d.def.id), groups: config.groups ?? 'todos' });

  const runs: OnceRun[] = [];
  const ran = new Set<string>();
  let interrupted = 0;
  // Una pila: el encadenado corre enseguida después de su job de arriba.
  const pending: PendingRun[] =
    due.map((d) => ({ def: d.def, registration: d.registration, payload: { job: d.def.id, source: ONCE_SOURCE }, coverFrom: d.coverFrom, reason: d.reason })).reverse();

  const run = async (next: PendingRun, deadline?: number): Promise<void> => {
    ran.add(next.def.id); // antes de cualquier await: otro recorredor ya no lo toma
    const bossJobId = `once:${randomUUID()}`;
    const runQuota = await getQuota();
    // En un turno, el job tiene lo que queda del presupuesto como timeout_s:
    // el que se mide por su timeout (outbound.dispatch) termina solo, a tiempo.
    const sliceS = deadline !== undefined ? Math.max(1, Math.floor((deadline - Date.now()) / 1000)) : next.def.timeoutS;
    const sliced = sliceS < next.def.timeoutS;
    const definition = sliced ? { ...next.def, timeoutS: sliceS } : next.def;
    const claim = await claimRun(db, next, clock(), bossJobId, sliced ? sliceS : undefined, backoff);
    if ('skip' in claim) {
      skipped.push({ job: next.def.id, reason: claim.skip });
      return;
    }
    // Las marcas van en la misma escritura que cierra la fila (closeMetadata):
    // otra pasada nunca ve un corte contado como intento.
    const closeMetadata = (o: Pick<RunOutcome, 'status' | 'result' | 'error'>): Record<string, unknown> | undefined => {
      // Un corte no es un fallo del job: el turno siguiente lo retoma sin gastar un intento.
      if (sliced && o.error instanceof JobTimeoutError) return { [TICK_CUT_KEY]: true };
      // La pasada siguiente lo da por cubierto, como pg-boss cuando no se lanza.
      if (o.status !== 'ok' && !shouldRetry(o, next.registration)) return { [NO_RETRY_KEY]: true };
      return undefined;
    };
    const outcome = await executeRun(
      { definition, registration: next.registration, payload: next.payload, attempt: claim.attempt, bossJobId, signal: opts.signal, runId: claim.runId, closeMetadata },
      { db, logger, secrets: opts.secrets, refreshers: opts.refreshers, quota: runQuota, http: opts.http, env, now: opts.now },
    );
    const cut = sliced && outcome.error instanceof JobTimeoutError;
    if (cut) {
      logger.warn('corrida cortada por el presupuesto del turno: el siguiente la retoma', { job: next.def.id, runId: outcome.runId, sliceS, timeoutS: next.def.timeoutS });
    } else if (outcome.status !== 'ok' && !shouldRetry(outcome, next.registration)) {
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
  const skip = (item: PendingRun, reason: OnceSkipReason): void => {
    skipped.push({ job: item.def.id, reason });
    if (reason === 'shutting_down') interrupted++;
  };

  await (opts.walk ?? sequentialWalk)({ pending, ran, signal: opts.signal, run, skip });

  const failedRuns = runs.filter((r) => r.status === 'failed' && !r.cut).length;
  const summary: OnceSummary = { at: now.toISOString(), runs, skipped, failedRuns, interrupted, planMs };
  const cut = runs.filter((r) => r.cut).map((r) => r.job);
  const noTime = skipped.filter((s) => s.reason === 'budget').map((s) => s.job);
  logger.info('pasada terminada', {
    runs: runs.map((r) => `${r.job}:${r.status}`),
    upToDate: skipped.filter((s) => s.reason === 'up_to_date').map((s) => s.job),
    exhausted: skipped.filter((s) => s.reason === 'retries_exhausted').map((s) => s.job),
    ...(cut.length || noTime.length ? { cut, noTime } : {}),
    failedRuns,
    interrupted,
    exitCode: onceExitCode(summary),
  });
  if (interrupted > 0) logger.warn('pasada interrumpida: estos jobs vencidos no empezaron', { jobs: skipped.filter((s) => s.reason === 'shutting_down').map((s) => s.job) });
  return summary;
}
