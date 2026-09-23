/**
 * Acceso a la base desde el worker.
 *
 * Hay DOS caminos hacia Postgres, a propósito:
 *
 *   1. pg-boss tiene su propio pool y corre como el rol con el que se
 *      conecta (mc_migrator en Supabase, dueño del esquema pgboss).
 *   2. Las consultas de negocio de los jobs (job_run, social_connection,
 *      api_call_log…) salen por ESTE módulo, que tras conectar hace
 *      `SET ROLE mc_worker`. mc_worker tiene BYPASSRLS porque los jobs
 *      cruzan workspaces (renovar todos los tokens por vencer, por
 *      ejemplo).
 *
 * RIESGO QUE ESO IMPLICA, para quien escriba un job: RLS no te protege.
 * Cada UPDATE/DELETE tiene que filtrar por workspace_id (y por id)
 * explícitamente. Un `UPDATE social_connection SET …` sin WHERE toca
 * todos los clientes. Revisa cada escritura con esa lupa.
 *
 * Por qué NO usa createPgDb/withWorkspace de @mc/db (cerrado en CON-2b):
 * ese cliente abre cada transacción con un workspace fijado para RLS, y
 * el worker corre como mc_worker precisamente para cruzar workspaces;
 * además pg-boss necesita su propio pool sin cambio de rol. Lo que sí se
 * comparte con @mc/db es lo que tiene que ser idéntico: el TLS (abajo) y,
 * en el embebido, el runner de migraciones (db-pglite.ts).
 *
 * El TLS ya no se decide aquí: `hostOf`, `tlsFor` y `resolveTls` salen
 * de @mc/db (una línea de montaje de CIM-2, ronda 4). Antes había dos
 * copias del mismo camino de seguridad —esta leía la CA del disco, la
 * de @mc/db usa la embebida— y solo una tenía prueba; tocar una y no la
 * otra dejaba al worker sin verificar o sin arrancar. Con resolveTls
 * hereda además la guardia contra `?sslmode=…` en la URL.
 */
import { join } from 'node:path';
import { hostOf, PLATFORM_ROOT, resolveTls, tlsFor, type Ssl } from '@mc/db';
import pg from 'pg';
import type { ConstructorOptions } from 'pg-boss';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export type Row = Record<string, unknown>;

export interface Queryable {
  query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** Lo que recibe un job en ctx.db. */
export interface JobDatabase extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export type BossConnection = Pick<ConstructorOptions, 'db' | 'connectionString' | 'ssl' | 'max' | 'application_name' | 'backend'>;

export interface RoleCheck {
  currentUser: string;
  sessionUser: string;
  bypassRls: boolean;
}

export interface WorkerDatabase extends JobDatabase {
  readonly kind: 'postgres' | 'pglite';
  /** Conexión que usa pg-boss (SIN cambio de rol). */
  bossConnection(): BossConnection;
  /** Con qué rol corren las consultas de negocio. */
  whoAmI(): Promise<RoleCheck>;
  close(): Promise<void>;
}

const ROLE_SQL = `SELECT current_user AS current_user, session_user AS session_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls`;

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Nombre de rol inválido: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

function toRoleCheck(row: Row | undefined): RoleCheck {
  return {
    currentUser: String(row?.['current_user'] ?? ''),
    sessionUser: String(row?.['session_user'] ?? ''),
    bypassRls: row?.['bypass_rls'] === true,
  };
}

// ---------------------------------------------------------------------
// Postgres real (Supabase o Docker)
// ---------------------------------------------------------------------

export interface PostgresDatabaseOptions {
  connectionString: string;
  setRole: string | null;
  jobPoolMax: number;
  bossPoolMax: number;
  applicationName: string;
  /** Ruta al CA. null = decidir por el host (localhost sin TLS; lo demás con el CA de Supabase del repo). */
  sslRootCert: string | null;
  onError?: (err: Error) => void;
}

/**
 * Los mismos helpers de TLS que usa la web, reexportados para que el
 * worker no tenga una segunda copia del camino de seguridad. El TLS
 * hacia Supabase lo decide @mc/db con su CA embebida; PGSSLROOTCERT
 * manda si existe, y un `?sslmode=…` en la URL se rechaza en vez de
 * ganar por detrás (packages/db/src/tls.ts).
 */
export { hostOf, tlsFor, PLATFORM_ROOT };
/** El mismo certificado que usa db/migrate.mjs: público y versionado. */
export const SUPABASE_CA_PATH = join(PLATFORM_ROOT, 'db', 'certs', 'supabase-root-2021.crt');

export class PostgresDatabase implements WorkerDatabase {
  readonly kind = 'postgres' as const;
  readonly #pool: pg.Pool;
  readonly #opts: PostgresDatabaseOptions;
  readonly #ssl: Ssl;
  /** La URL ya sin parámetros de TLS: una sola fuente de verdad, también para pg-boss. */
  readonly #connectionString: string;
  /** Clientes del pool que ya hicieron SET ROLE. */
  readonly #prepared = new WeakSet<pg.PoolClient>();

  constructor(opts: PostgresDatabaseOptions) {
    this.#opts = opts;
    const tls = resolveTls(opts.connectionString, opts.sslRootCert);
    this.#ssl = tls.ssl;
    this.#connectionString = tls.connectionString;
    this.#pool = new pg.Pool({
      connectionString: this.#connectionString,
      ssl: this.#ssl,
      max: opts.jobPoolMax,
      application_name: `${opts.applicationName}:jobs`,
    });
    this.#pool.on('error', (err) => opts.onError?.(err));
  }

  bossConnection(): BossConnection {
    return {
      connectionString: this.#connectionString,
      ssl: this.#ssl,
      max: this.#opts.bossPoolMax,
      application_name: `${this.#opts.applicationName}:boss`,
    };
  }

  async #acquire(): Promise<pg.PoolClient> {
    const client = await this.#pool.connect();
    if (this.#opts.setRole && !this.#prepared.has(client)) {
      try {
        await client.query(`SET ROLE ${quoteIdent(this.#opts.setRole)}`);
        this.#prepared.add(client);
      } catch (err) {
        // Un cliente sin el rol correcto no puede volver al pool: se destruye.
        client.release(err instanceof Error ? err : new Error(String(err)));
        throw new Error(
          `No se pudo hacer SET ROLE ${this.#opts.setRole}: ${(err as Error).message}. ` +
          'El rol con el que se conecta el worker tiene que ser miembro de mc_worker (ver docs/propuestas/CON-2.md).',
          { cause: err },
        );
      }
    }
    return client;
  }

  async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const client = await this.#acquire();
    try {
      const res = await client.query<R>(text, params as unknown[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#acquire();
    const tx: Queryable = {
      async query<R extends Row = Row>(text: string, params: readonly unknown[] = []) {
        const res = await client.query<R>(text, params as unknown[]);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      },
    };
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async whoAmI(): Promise<RoleCheck> {
    const { rows } = await this.query(ROLE_SQL);
    return toRoleCheck(rows[0]);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
