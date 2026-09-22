/**
 * Una ejecución de un job, de principio a fin, con su fila en job_run.
 *
 *   INSERT job_run (running) → handler(payload, ctx) → UPDATE job_run
 *
 * Estados finales:
 *   ok       el handler terminó y failed = 0
 *   partial  failed > 0 y processed > 0 (renovó unas conexiones y otras no)
 *   failed   lanzó, agotó timeout_s, o failed > 0 con processed = 0
 *
 * El error en la columna es "Clase: mensaje", sin stack; el stack va al
 * log. La metadata pasa por el redactor antes de guardarse: aunque un
 * handler se equivoque y devuelva un token, no llega a la base.
 */
import { redactSecrets, type SecretStore, type TokenRefresherRegistry } from '@mc/connectors';
import type { Env } from './config.ts';
import type { JobDatabase } from './db.ts';
import type { Logger } from './logger.ts';
import type { JobContext, JobDefinition, JobRegistration, JobResult } from './registry.ts';

export type RunStatus = 'ok' | 'partial' | 'failed';

export interface RunInput {
  definition: JobDefinition;
  registration: JobRegistration;
  payload: unknown;
  attempt: number;
  /** id del job en pg-boss, para cruzar con pgboss.job si hace falta. */
  bossJobId: string;
  /** Señal de pg-boss (apagado, expiración). Se encadena con el timeout propio. */
  signal?: AbortSignal;
}

export interface RunDeps {
  db: JobDatabase;
  logger: Logger;
  secrets: SecretStore;
  refreshers: TokenRefresherRegistry;
  env: Env;
  now?: () => Date;
}

export interface RunOutcome {
  runId: number;
  status: RunStatus;
  durationMs: number;
  result: JobResult | null;
  error: Error | null;
}

export class JobTimeoutError extends Error {
  readonly timeoutS: number;
  constructor(timeoutS: number) {
    super('timeout');
    this.name = 'JobTimeoutError';
    this.timeoutS = timeoutS;
  }
}

export class JobItemsFailedError extends Error {
  readonly processed: number;
  readonly failed: number;
  constructor(processed: number, failed: number) {
    super(`${failed} elemento(s) fallaron de ${processed + failed}`);
    this.name = 'JobItemsFailedError';
    this.processed = processed;
    this.failed = failed;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_COLUMN_MAX = 1000;

interface PayloadContext {
  workspaceId: string | null;
  entityType: string | null;
  entityId: string | null;
}

export function payloadContext(payload: unknown): PayloadContext {
  const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const uuid = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);
  return {
    workspaceId: uuid(p['workspaceId']),
    entityType: typeof p['entityType'] === 'string' ? p['entityType'].slice(0, 80) : null,
    entityId: uuid(p['entityId']),
  };
}

export function errorColumn(err: unknown): string {
  if (err instanceof JobTimeoutError) return 'timeout';
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, ERROR_COLUMN_MAX);
  return String(err).slice(0, ERROR_COLUMN_MAX);
}

export function statusFor(result: JobResult): RunStatus {
  if (result.failed > 0 && result.processed > 0) return 'partial';
  if (result.failed > 0) return 'failed';
  return 'ok';
}

function validateResult(value: unknown, jobId: string): JobResult {
  if (typeof value !== 'object' || value === null) throw new TypeError(`El handler de ${jobId} no devolvió { processed, failed }`);
  const v = value as Record<string, unknown>;
  const processed = v['processed'];
  const failed = v['failed'];
  if (!Number.isInteger(processed) || (processed as number) < 0 || !Number.isInteger(failed) || (failed as number) < 0) {
    throw new TypeError(`El handler de ${jobId} devolvió processed/failed inválidos`);
  }
  const metadata = v['metadata'];
  return {
    processed: processed as number,
    failed: failed as number,
    metadata: typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : undefined,
  };
}

export async function executeRun(input: RunInput, deps: RunDeps): Promise<RunOutcome> {
  const { definition, registration, payload, attempt, bossJobId } = input;
  const now = deps.now ?? (() => new Date());
  const ctxPayload = payloadContext(payload);

  const inserted = await deps.db.query<{ id: number | string }>(
    `INSERT INTO job_run (job_id, workspace_id, entity_type, entity_id, status, attempt, metadata)
     VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb) RETURNING id`,
    [definition.id, ctxPayload.workspaceId, ctxPayload.entityType, ctxPayload.entityId, attempt, JSON.stringify({ bossJobId })],
  );
  const runId = Number(inserted.rows[0]?.id);
  const logger = deps.logger.child({ job: definition.id, runId, jobId: bossJobId, attempt });

  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(input.signal?.reason ?? new Error('abortado por pg-boss'));
  if (input.signal?.aborted) onOuterAbort();
  else input.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const timeoutMs = definition.timeoutS * 1000;
  const timer = setTimeout(() => abort.abort(new JobTimeoutError(definition.timeoutS)), timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason)));
    if (abort.signal.aborted) fail();
    else abort.signal.addEventListener('abort', fail, { once: true });
  });

  const ctx: JobContext = {
    jobId: definition.id,
    runId,
    attempt,
    workspaceId: ctxPayload.workspaceId ?? undefined,
    definition,
    db: deps.db,
    logger,
    signal: abort.signal,
    secrets: deps.secrets,
    refreshers: deps.refreshers,
    now,
    env: deps.env,
  };

  const started = Date.now();
  logger.info('job iniciado', { timeoutS: definition.timeoutS });

  let result: JobResult | null = null;
  let error: Error | null = null;
  try {
    const handlerPromise = registration.handler(payload as never, ctx);
    // Si el handler sigue vivo después del timeout, no podemos matarlo:
    // solo dejar constancia de que terminó tarde.
    handlerPromise.then(
      () => { if (abort.signal.aborted) logger.warn('el handler terminó después del timeout; su resultado se ignoró'); },
      () => undefined,
    );
    result = validateResult(await Promise.race([handlerPromise, aborted]), definition.id);
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onOuterAbort);
  }

  const durationMs = Date.now() - started;
  const status: RunStatus = error ? 'failed' : statusFor(result!);
  if (!error && status === 'failed' && result) error = new JobItemsFailedError(result.processed, result.failed);

  const metadata = redactSecrets({ ...(result?.metadata ?? {}), bossJobId, ...(error instanceof JobTimeoutError ? { timeoutS: error.timeoutS } : {}) });

  await deps.db.query(
    `UPDATE job_run
        SET status = $2, finished_at = now(), duration_ms = $3, items_processed = $4, items_failed = $5,
            error = $6, metadata = $7::jsonb
      WHERE id = $1`,
    [runId, status, durationMs, result?.processed ?? 0, result?.failed ?? 0, error ? errorColumn(error) : null, JSON.stringify(metadata)],
  );

  const fields = { status, durationMs, processed: result?.processed ?? 0, failed: result?.failed ?? 0 };
  if (status === 'ok') logger.info('job terminado', fields);
  else if (status === 'partial') logger.warn('job terminado con fallos parciales', fields);
  else logger.error('job falló', { ...fields, err: error });

  return { runId, status, durationMs, result, error };
}
