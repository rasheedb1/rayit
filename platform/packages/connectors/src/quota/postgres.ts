/**
 * api_quota_usage en Postgres: UPSERT sobre los dos índices únicos
 * parciales de la migración 0002 (api_quota_usage_conn_uk cuando hay
 * connection_id; api_quota_usage_app_uk cuando es cuota de app).
 */
import type { SqlExecutor } from '../log/postgres.ts';
import type { PlatformId } from '../types.ts';
import type { QuotaUsageRow, QuotaUsageStore } from './manager.ts';

interface UsageRow extends Record<string, unknown> {
  units_used: number | string;
  calls: number | string;
}

export class PostgresQuotaUsageStore implements QuotaUsageStore {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async load(platformId: PlatformId, connectionId: string | null, day: string): Promise<QuotaUsageRow | null> {
    const res = (await this.#db.query(
      connectionId === null
        ? 'SELECT units_used, calls FROM api_quota_usage WHERE platform_id = $1 AND connection_id IS NULL AND day = $2'
        : 'SELECT units_used, calls FROM api_quota_usage WHERE platform_id = $1 AND connection_id = $3 AND day = $2',
      connectionId === null ? [platformId, day] : [platformId, day, connectionId],
    )) as { rows?: UsageRow[] };
    const row = res.rows?.[0];
    if (!row) return null;
    return { unitsUsed: Number(row.units_used), calls: Number(row.calls) };
  }

  async add(platformId: PlatformId, connectionId: string | null, day: string, units: number, calls: number, unitsLimit: number | null): Promise<void> {
    if (connectionId === null) {
      await this.#db.query(
        `INSERT INTO api_quota_usage (platform_id, connection_id, day, units_used, units_limit, calls)
         VALUES ($1, NULL, $2, $3, $4, $5)
         ON CONFLICT (platform_id, day) WHERE connection_id IS NULL
         DO UPDATE SET units_used = api_quota_usage.units_used + EXCLUDED.units_used,
                       calls = api_quota_usage.calls + EXCLUDED.calls,
                       units_limit = COALESCE(EXCLUDED.units_limit, api_quota_usage.units_limit)`,
        [platformId, day, units, unitsLimit, calls],
      );
      return;
    }
    await this.#db.query(
      `INSERT INTO api_quota_usage (platform_id, connection_id, day, units_used, units_limit, calls)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform_id, connection_id, day) WHERE connection_id IS NOT NULL
       DO UPDATE SET units_used = api_quota_usage.units_used + EXCLUDED.units_used,
                     calls = api_quota_usage.calls + EXCLUDED.calls,
                     units_limit = COALESCE(EXCLUDED.units_limit, api_quota_usage.units_limit)`,
      [platformId, connectionId, day, units, unitsLimit, calls],
    );
  }
}
