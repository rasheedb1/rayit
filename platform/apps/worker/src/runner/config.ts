/**
 * Configuración del worker, leída del entorno una sola vez al arrancar.
 * Solo nombres de variables aquí; los valores llegan por .env.local
 * (make db.unlock) o por el entorno de Railway/Fly.
 */
import { isLogLevel, type LogFormat, type LogLevel } from './logger.ts';

export type WorkerMode = 'postgres' | 'pglite';

export interface WorkerConfig {
  mode: WorkerMode;
  /** Cadena de conexión en modo sesión (pooler :5432). null en modo pglite. */
  databaseUrl: string | null;
  /** Rol que asumen las consultas de negocio tras conectar. null = no cambiar de rol. */
  setRole: string | null;
  /** Subconjunto de job_definition.queue que atiende este proceso. null = todas. */
  groups: string[] | null;
  pollIntervalS: number;
  retryDelayS: number;
  retryDelayMaxS: number;
  stopTimeoutS: number;
  bossSchema: string;
  bossPoolMax: number;
  jobPoolMax: number;
  oauthRefreshMarginMinutes: number;
  secretStore: 'env' | 'memory';
  tokenRefresher: 'real' | 'fake';
  logLevel: LogLevel;
  logFormat: LogFormat;
  /** Ruta al certificado raíz para TLS contra Supabase. null = sin TLS (localhost). */
  sslRootCert: string | null;
  applicationName: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const TRANSACTION_POOLER_PORT = '6543';

export function loadConfig(env: Env = process.env, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const mode: WorkerMode = overrides.mode ?? 'postgres';
  const cfg: WorkerConfig = {
    mode,
    databaseUrl: mode === 'pglite' ? null : (env['WORKER_DATABASE_URL'] || env['DATABASE_URL_DIRECT'] || null),
    setRole: parseRole(env['WORKER_SET_ROLE']),
    groups: parseList(env['WORKER_GROUPS']),
    pollIntervalS: envNumber(env, 'WORKER_POLL_S', 2, 0.5),
    retryDelayS: envNumber(env, 'WORKER_RETRY_DELAY_S', 30, 0),
    retryDelayMaxS: envNumber(env, 'WORKER_RETRY_DELAY_MAX_S', 900, 0),
    stopTimeoutS: envNumber(env, 'WORKER_STOP_TIMEOUT_S', 30, 1),
    bossSchema: env['WORKER_BOSS_SCHEMA'] || 'pgboss',
    bossPoolMax: envNumber(env, 'WORKER_BOSS_POOL_MAX', 4, 1),
    jobPoolMax: envNumber(env, 'WORKER_JOB_POOL_MAX', 8, 1),
    oauthRefreshMarginMinutes: envNumber(env, 'OAUTH_REFRESH_MARGIN_MINUTES', 30, 0),
    secretStore: env['SECRET_STORE'] === 'memory' ? 'memory' : 'env',
    tokenRefresher: env['TOKEN_REFRESHER'] === 'fake' ? 'fake' : 'real',
    logLevel: isLogLevel(env['LOG_LEVEL']) ? env['LOG_LEVEL'] : 'info',
    logFormat: env['LOG_FORMAT'] === 'pretty' ? 'pretty' : 'json',
    sslRootCert: env['PGSSLROOTCERT'] || null,
    applicationName: env['WORKER_APPLICATION_NAME'] || 'mc-worker',
    ...overrides,
  };

  if (cfg.mode === 'postgres') {
    if (!cfg.databaseUrl) {
      throw new ConfigError(
        'Falta la cadena de conexión: define DATABASE_URL_DIRECT (o WORKER_DATABASE_URL). ' +
        'En local: make db.unlock. El worker necesita el pooler en modo sesión (:5432), no :6543.',
      );
    }
    if (usesTransactionPooler(cfg.databaseUrl)) {
      throw new ConfigError(
        `La cadena de conexión apunta al pooler de transacción (:${TRANSACTION_POOLER_PORT}). ` +
        'pg-boss y SET ROLE necesitan una sesión estable: usa DATABASE_URL_DIRECT (:5432).',
      );
    }
  }
  return cfg;
}

export function usesTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === TRANSACTION_POOLER_PORT;
  } catch {
    return /:6543(\/|$|\?)/.test(url);
  }
}

function parseRole(raw: string | undefined): string | null {
  if (raw === undefined) return 'mc_worker';
  const v = raw.trim();
  return v === '' || v === 'none' ? null : v;
}

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
}

function envNumber(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} debe ser un número ≥ ${min}; recibió "${raw}"`);
  return n;
}

/** Entero leído del entorno con valor por defecto; lo usan los jobs para sus propios ajustes. */
export function envInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
