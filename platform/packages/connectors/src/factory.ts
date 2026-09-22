/**
 * Fábrica de clientes: lo que el worker cuelga en ctx.connectors.
 *
 * Un HttpCore por ejecución (con el sink de api_call_log sobre ctx.db,
 * la señal del job y el logger del job) y UN QuotaManager por proceso,
 * compartido entre ejecuciones: la cuota es del proceso, no del job.
 */
import { HttpCore, type ConnectorLogger, type FetchLike, type HttpCoreOptions } from './http/client.ts';
import type { SleepFn } from './http/retry.ts';
import type { CallLogSink } from './log/sink.ts';
import type { SqlExecutor } from './log/postgres.ts';
import { DEFAULT_LIMITS, mergeLimits, type LimitsTable } from './quota/limits.ts';
import type { QuotaManager } from './quota/manager.ts';
import type { ConnectionAuth } from './platforms/base.ts';
import { InstagramClient, type InstagramOptions } from './platforms/instagram-api.ts';
import { TikTokAccountsClient, type TikTokAccountsOptions } from './platforms/tiktok-accounts.ts';
import { TikTokDisplayClient, type TikTokDisplayOptions } from './platforms/tiktok-display.ts';
import { YouTubeClient, type YouTubeOptions } from './platforms/youtube-api.ts';
import type { PlatformId } from './types.ts';
import { isPlatformId } from './types.ts';

/** Piezas inyectables para probar sin red ni timers; en producción se dejan vacías. */
export interface ConnectorHttpOverrides {
  fetch?: FetchLike;
  sleep?: SleepFn;
  random?: () => number;
  now?: () => Date;
  timeoutMs?: number;
  retry?: HttpCoreOptions['retry'];
}

export interface ConnectorFactoryOptions {
  callLog: CallLogSink;
  quota: QuotaManager;
  logger?: ConnectorLogger;
  /** Señal por defecto de todas las llamadas (la del job). */
  signal?: AbortSignal;
  http?: ConnectorHttpOverrides;
}

export interface ConnectorFactory {
  readonly core: HttpCore;
  tiktokDisplay(auth: ConnectionAuth, opts?: TikTokDisplayOptions): TikTokDisplayClient;
  tiktokAccounts(auth: ConnectionAuth, businessId: string, opts?: TikTokAccountsOptions): TikTokAccountsClient;
  instagram(auth: ConnectionAuth, opts?: InstagramOptions): InstagramClient;
  youtube(auth: ConnectionAuth, opts?: YouTubeOptions): YouTubeClient;
}

export function createConnectors(opts: ConnectorFactoryOptions): ConnectorFactory {
  const core = new HttpCore({
    callLog: opts.callLog, quota: opts.quota, logger: opts.logger, defaultSignal: opts.signal,
    fetch: opts.http?.fetch, sleep: opts.http?.sleep, random: opts.http?.random, now: opts.http?.now, timeoutMs: opts.http?.timeoutMs, retry: opts.http?.retry,
  });
  return {
    core,
    tiktokDisplay: (auth, o) => new TikTokDisplayClient(core, auth, o),
    tiktokAccounts: (auth, businessId, o) => new TikTokAccountsClient(core, auth, businessId, o),
    instagram: (auth, o) => new InstagramClient(core, auth, o),
    youtube: (auth, o) => new YouTubeClient(core, auth, o),
  };
}

interface PlatformRow extends Record<string, unknown> {
  id: string;
  limits: unknown;
}

/**
 * Lee platform.limits (migración 0002) y lo aplica sobre la tabla por
 * defecto. Vacío hoy: hasta que Rasheed ponga el JSON de
 * docs/propuestas/CON-1.md §1 en el seed 0001, devuelve DEFAULT_LIMITS.
 */
export async function loadPlatformLimits(db: SqlExecutor, logger?: ConnectorLogger): Promise<LimitsTable> {
  const res = (await db.query('SELECT id, limits FROM platform')) as { rows?: PlatformRow[] };
  const overrides: Partial<Record<PlatformId, unknown>> = {};
  for (const row of res.rows ?? []) {
    if (!isPlatformId(row.id)) continue;
    const limits = typeof row.limits === 'string' ? (JSON.parse(row.limits) as unknown) : row.limits;
    if (limits && typeof limits === 'object' && Object.keys(limits as object).length > 0) overrides[row.id] = limits;
  }
  const { limits, ignored } = mergeLimits(DEFAULT_LIMITS, overrides);
  for (const msg of ignored) logger?.warn('platform.limits: entrada ignorada', { detail: msg });
  return limits;
}
