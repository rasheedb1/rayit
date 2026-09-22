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
import type { SecretStore, TokenRefresherRegistry } from '@mc/connectors';
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
  now(): Date;
  env: Env;
}

export interface JobResult {
  processed: number;
  failed: number;
  /** Se guarda en job_run.metadata, redactado. Nunca pongas un token aquí. */
  metadata?: Record<string, unknown>;
}

export type JobHandler<P extends object = JobPayload> = (payload: P, ctx: JobContext) => Promise<JobResult>;

export interface JobOptions {
  /**
   * Política de la cola en pg-boss. 'standard' (por defecto) admite N
   * jobs en cola; 'stately' deja uno en cola y uno activo, útil para un
   * cron que no debe apilarse si una corrida se alarga.
   */
  policy?: QueuePolicy;
  /**
   * Si el handler devuelve failed > 0, el runner registra el job_run
   * (partial o failed) y además lanza para que pg-boss reintente hasta
   * max_attempts. Ponlo en false si tus fallos por elemento no mejoran
   * con un reintento inmediato.
   * @default true
   */
  retryOnItemFailure?: boolean;
}

export interface JobRegistration {
  id: string;
  handler: JobHandler<JobPayload>;
  options: Required<JobOptions>;
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
      policy: options.policy ?? 'standard',
      retryOnItemFailure: options.retryOnItemFailure ?? true,
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
