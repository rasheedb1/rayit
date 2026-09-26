/**
 * La bitácora de las llamadas de outreach: una fila por intento en
 * api_call_log, con `provider` ('gmail' | 'unipile') en vez de
 * platform_id y la cuenta de canal en channel_account_id (migración
 * canales_outreach). Sin cuerpo, sin token, sin destinatario: solo lo que hace falta
 * para explicar por qué una cuenta se cayó o por qué un envío esperó.
 */
import type { SqlExecutor } from '../log/postgres.ts';
import type { OutreachProvider } from './errors.ts';

/** Exactamente las columnas de api_call_log que escribe un conector de outreach. */
export interface OutreachCallLogEntry {
  provider: OutreachProvider;
  channel_account_id: string | null;
  /** Endpoint lógico: 'gmail.messages.send', 'unipile.users.invite'… */
  endpoint: string;
  http_status: number | null;
  ok: boolean;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  rate_limited: boolean;
  retry_after_s: number | null;
}

export interface OutreachCallLogSink {
  /** Nunca tumba la llamada que registra: el cliente captura su error y sigue. */
  record(entry: OutreachCallLogEntry): Promise<void>;
}

export class InMemoryOutreachCallLog implements OutreachCallLogSink {
  readonly entries: OutreachCallLogEntry[] = [];

  async record(entry: OutreachCallLogEntry): Promise<void> {
    this.entries.push({ ...entry });
  }

  /** Vuelca lo acumulado en otro sink (el de la transacción que por fin tiene la cuenta). */
  async flushTo(sink: OutreachCallLogSink, channelAccountId?: string | null): Promise<void> {
    for (const e of this.entries.splice(0)) {
      await sink.record(channelAccountId === undefined ? e : { ...e, channel_account_id: e.channel_account_id ?? channelAccountId });
    }
  }
}

export class PostgresOutreachCallLog implements OutreachCallLogSink {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async record(e: OutreachCallLogEntry): Promise<void> {
    await this.#db.query(
      `INSERT INTO api_call_log
         (provider, channel_account_id, endpoint, http_status, ok, error_code, error_message, request_units, duration_ms, rate_limited, retry_after_s)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10)`,
      [e.provider, e.channel_account_id, e.endpoint, e.http_status, e.ok, e.error_code, e.error_message, e.duration_ms, e.rate_limited, e.retry_after_s],
    );
  }
}

export const NULL_OUTREACH_CALL_LOG: OutreachCallLogSink = { async record() {} };
