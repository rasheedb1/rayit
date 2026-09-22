/**
 * api_call_log en Postgres. Recibe el ejecutor mínimo que ya tienen el
 * worker (ctx.db) y el cliente provisional de la web (WorkspaceTx):
 * `{ query(text, params) }`. No abre conexiones ni transacciones.
 */
import type { CallLogEntry, CallLogSink } from './sink.ts';

export interface SqlExecutor {
  query(text: string, params?: readonly unknown[]): Promise<unknown>;
}

export class PostgresCallLogSink implements CallLogSink {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async record(e: CallLogEntry): Promise<void> {
    await this.#db.query(
      `INSERT INTO api_call_log
         (connection_id, platform_id, endpoint, http_status, ok, error_code, error_message, request_units, duration_ms, rate_limited, retry_after_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [e.connection_id, e.platform_id, e.endpoint, e.http_status, e.ok, e.error_code, e.error_message, e.request_units, e.duration_ms, e.rate_limited, e.retry_after_s],
    );
  }
}
