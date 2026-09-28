/**
 * El contrato entre el runner y los jobs. Es lo más importante que
 * entrega CON-2: cada módulo (ventas, finanzas, campañas…) agrega sus
 * jobs en apps/worker/src/jobs/<modulo>/ sin tocar src/runner/.
 *
 * Cómo se agrega un job:
 *
 *   // apps/worker/src/jobs/finanzas/recordatorios.ts
 *   export const recordatoriosJob = defineJob('finance.reminders', async (payload, ctx) => {
 *     const { rows } = await ctx.db.query('select … where workspace_id = $1', [ws]);
 *     …
 *     return { processed: rows.length, failed: 0 };
 *   });
 *
 *   // apps/worker/src/jobs/finanzas/index.ts
 *   export const finanzasJobs = [recordatoriosJob];
 *
 *   // apps/worker/src/jobs/index.ts  (una línea)
 *   export const allJobs = [...conexionesJobs, ...finanzasJobs];
 *
 * El id tiene que existir en job_definition (migración 0009): de ahí
 * salen cola, cron, timeout, reintentos y concurrencia. Un id sin fila
 * en job_definition no se ejecuta nunca; una fila sin handler queda
 * registrada en job_run como `skipped` al arrancar.
 */
import type { CallLogSink, ConnectorFactory, SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import type { QueuePolicy } from 'pg-boss';
import type { Env } from './config.ts';
import type { JobDatabase } from './db.ts';
import type { Logger } from './logger.ts';

/** Una fila de job_definition. */
export interface JobDefinition {
  id: string;
  labelEs: string;
  queue: string;
  defaultCron: string | null;
  timeoutS: number;
  maxAttempts: number;
  maxConcurrency: number;
  enabled: boolean;
}

/**
 * Lo que puede traer el payload de un job. Si trae estos tres campos, el
 * runner los copia a job_run para poder responder "¿qué pasó con esta
 * conexión?" sin leer logs. Cada job valida el resto de su payload.
 */
export interface JobPayload {
  workspaceId?: string;
  entityType?: string;
  entityId?: string;
}

export interface JobContext {
  /** id de job_definition, p. ej. 'oauth.refresh'. */
  jobId: string;
  /** id de la fila en job_run. */
  runId: number;
  /** Intento, empezando en 1 (lo reporta pg-boss). */
  attempt: number;
  workspaceId: string | undefined;
  definition: JobDefinition;
  /** Corre como mc_worker (BYPASSRLS): filtra por workspace_id en cada escritura. */
  db: JobDatabase;
  logger: Logger;
  /** Se dispara al vencer timeout_s o al apagar el worker: revísala en bucles largos. */
  signal: AbortSignal;
  secrets: SecretStore;
  refreshers: TokenRefresherRegistry;
  /**
   * Clientes de las cuatro APIs (CON-1), ya cableados con api_call_log
   * sobre ctx.db, la cuota compartida del proceso y ctx.signal:
   *   const tiktok = ctx.connectors.tiktokDisplay({ connectionId, tokens });
   *   for await (const page of tiktok.iterateVideos()) { … }
   */
  connectors: ConnectorFactory;
  /** Registrar a mano una llamada saliente que no pasó por un conector (p. ej. oauth.refresh). */
  callLog: CallLogSink;
  now(): Date;
  env: Env;
}

export interface JobResult {
  processed: number;
  failed: number;
  /** Se guarda en job_run.metadata, redactado. Nunca pongas un token aquí. */
  metadata?: Record<string, unknown>;
  /**
   * Si hubo fallos por elemento, ¿conviene que pg-boss reintente ya?
   * Por defecto manda `retryOnItemFailure` de defineJob(). Un job puede
   * devolver `retry: false` cuando sabe que reintentar no ayuda (rate
   * limit con Retry-After largo, conector sin implementar).
   */
  retry?: boolean;
}

export type JobHandler<P extends object = JobPayload> = (payload: P, ctx: JobContext) => Promise<JobResult>;

export interface JobOptions {
  /**
   * Política de la cola en pg-boss. Por defecto: 'stately' si la
   * definición tiene cron (un tick en cola y uno activo: las corridas
   * no se apilan ni se solapan) y 'standard' si no (N jobs en cola, por
   * ejemplo uno por video). En una cola 'stately', un envío manual que
   * no deba colapsar con el cron lleva su propio `singletonKey`.
   */
  policy?: QueuePolicy;
  /**
   * Instancias del job que corren en paralelo en este proceso
   * (`localConcurrency` de pg-boss). Por defecto 1: `max_concurrency`
   * de job_definition es la concurrencia POR PLATAFORMA dentro de una
   * corrida (ctx.definition.maxConcurrency), no el número de corridas.
   * Un job por entidad (video.probe) puede pedir `instances: 'max'`
   * para usar max_concurrency como corridas paralelas.
   */
  instances?: number | 'max';
  /**
   * Si el handler devuelve failed > 0, el runner registra el job_run
   * (partial o failed) y además lanza para que pg-boss reintente hasta
   * max_attempts. Ponlo en false si tus fallos por elemento no mejoran
   * con un reintento inmediato.
   * @default true
   */
  retryOnItemFailure?: boolean;
  /**
   * Encadenamiento por evento: los jobs DESPUÉS de los cuales corre
   * este. Cuando uno de ellos termina con datos nuevos (ok o partial, y
   * processed > 0), el runner encola este con el mismo workspaceId del
   * payload (sin él, para todos). Así compute.baseline corre tras collect.post_metrics
   * aunque la recolección se alargue o se reintente más allá de su hora.
   *
   * El cron de job_definition se queda: es la red de seguridad del día
   * en que el de arriba falle entero, y la ventana de la línea base
   * cambia con el paso del tiempo aunque no lleguen lecturas. Por eso
   * el job de abajo tiene que ser idempotente.
   */
  after?: readonly string[];
}

export interface JobRegistration {
  id: string;
  handler: JobHandler<JobPayload>;
  options: JobOptions & { retryOnItemFailure: boolean; instances: number | 'max'; after: readonly string[] };
}

export function defineJob<P extends object = JobPayload>(id: string, handler: JobHandler<P>, options: JobOptions = {}): JobRegistration {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id)) {
    throw new Error(`El id de job "${id}" no sigue el patrón modulo.accion (como en job_definition)`);
  }
  return {
    id,
    // El payload lo tipa el job; el runner solo lo transporta.
    handler: (payload, ctx) => handler(payload as P, ctx),
    options: {
      policy: options.policy,
      instances: options.instances ?? 1,
      retryOnItemFailure: options.retryOnItemFailure ?? true,
      after: options.after ?? [],
    },
  };
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobRegistration>();

  constructor(registrations: readonly JobRegistration[]) {
    for (const r of registrations) {
      if (this.#jobs.has(r.id)) throw new Error(`El job "${r.id}" está registrado dos veces`);
      this.#jobs.set(r.id, r);
    }
    for (const r of registrations) {
      for (const previo of r.options.after) {
        if (!this.#jobs.has(previo)) throw new Error(`El job "${r.id}" corre después de "${previo}", que no está registrado`);
      }
    }
    // Un ciclo (a tras b, b tras a) encadenaría corridas sin fin.
    for (const r of registrations) {
      const pendientes = [...r.options.after];
      const vistos = new Set<string>();
      while (pendientes.length > 0) {
        const previo = pendientes.pop()!;
        if (previo === r.id) throw new Error(`El encadenamiento de "${r.id}" forma un ciclo`);
        if (vistos.has(previo)) continue;
        vistos.add(previo);
        pendientes.push(...this.#jobs.get(previo)!.options.after);
      }
    }
  }

  /**
   * Los jobs que se encolan cuando `id` termina con datos nuevos: el
   * inverso de `after`, en el orden en que se registraron.
   */
  next(id: string): string[] {
    return [...this.#jobs.values()].filter((r) => r.options.after.includes(id)).map((r) => r.id);
  }

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  get(id: string): JobRegistration | undefined {
    return this.#jobs.get(id);
  }

  ids(): string[] {
    return [...this.#jobs.keys()];
  }

  get size(): number {
    return this.#jobs.size;
  }
}
