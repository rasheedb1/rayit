/**
 * Cliente de base de @mc/db (CIM-2).
 *
 * Contrato con el resto del producto (detalle y ejemplos en README.md):
 *
 *   withWorkspace(id, fn)   Abre una transacción, fija `app.workspace_id`
 *                           con set_config(…, true) —local a la
 *                           transacción— y ejecuta fn con un ORM Drizzle
 *                           y un ejecutor SQL atados a esa transacción.
 *                           Commit si resuelve, rollback si lanza. RLS
 *                           filtra las lecturas y rechaza las escrituras
 *                           de otro workspace. Ninguna consulta recibe el
 *                           workspace como parámetro suelto.
 *
 *   withoutWorkspace(fn)    Transacción sin workspace: solo sirve para
 *                           los catálogos sin RLS (platform, niche,
 *                           pipeline_stage, job_definition, feature_flag,
 *                           signal_source). En las tablas con RLS devuelve
 *                           cero filas, y eso es lo que prueba
 *                           test/rls.test.ts.
 *
 *   asWorker(fn)            SET LOCAL ROLE mc_worker dentro de la
 *                           transacción: salta RLS para los jobs globales
 *                           (renovar todos los tokens por vencer). Solo
 *                           funciona si el rol de conexión es miembro de
 *                           mc_worker; mc_app no lo es a propósito, así
 *                           que la web nunca puede cruzar workspaces.
 *
 * Toda transacción arranca con `SET LOCAL statement_timeout` e
 * `idle_in_transaction_session_timeout` (15 s por defecto, DbOptions):
 * contra el pooler en modo transacción, una petición colgada no puede
 * retener una conexión sin límite.
 *
 * Las manijas `tx.db` y `tx.query` mueren con la transacción: usarlas
 * después (un `return tx` accidental) lanza TransactionClosedError en
 * vez de correr fuera de transacción y sin workspace.
 *
 * Contra Supabase va por el pooler en modo transacción (DATABASE_URL,
 * :6543): como set_config y SET LOCAL son locales a la transacción, la
 * conexión vuelve limpia al pool.
 *
 * Los drivers (pg aquí, PGlite en pglite.ts) solo aportan un TxRunner:
 * abrir la transacción y entregar las dos manijas. La lógica de
 * workspace, rol, timeouts y cierre vive una sola vez, en createDb.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.ts';
import { tlsFor } from './tls.ts';

export type Schema = typeof schema;

/** El ORM atado a la transacción actual: `tx.db.select().from(deal)`. */
export type Orm = PgDatabase<PgQueryResultHKT, Schema>;

export interface QueryResult<T> {
  rows: T[];
}

/** SQL con parámetros posicionales, para las consultas que Drizzle no expresa bien. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface BaseTx extends SqlExecutor {
  readonly db: Orm;
}

/** Una transacción con el workspace ya fijado. */
export interface WorkspaceTx extends BaseTx {
  readonly workspaceId: string;
}

/** Una transacción como mc_worker: RLS no aplica. Cada escritura filtra por workspace_id a mano. */
export type WorkerTx = BaseTx;

export interface Db {
  withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  withoutWorkspace<T>(fn: (tx: BaseTx) => Promise<T>): Promise<T>;
  asWorker<T>(fn: (tx: WorkerTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Para INSERT dentro de withWorkspace: `workspaceId: CURRENT_WORKSPACE`. */
export const CURRENT_WORKSPACE = sql<string>`current_workspace_id()`;

export const WORKER_ROLE = 'mc_worker';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertWorkspaceId(workspaceId: string): void {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`workspace_id inválido: "${workspaceId}". Debe ser un UUID.`);
  }
}

/** Se lanza al usar `tx.db` o `tx.query` después de que su transacción terminó. */
export class TransactionClosedError extends Error {
  constructor() {
    super(
      'Transacción cerrada: tx.db y tx.query solo valen dentro de withWorkspace / withoutWorkspace / asWorker. ' +
        'No devuelvas tx desde fn; devuelve el resultado.',
    );
    this.name = 'TransactionClosedError';
  }
}

/** Ajustes comunes a los dos drivers. */
export interface DbOptions {
  /** `SET LOCAL statement_timeout` al abrir cada transacción, en ms. 0 lo desactiva. */
  statementTimeoutMs?: number;
  /** `SET LOCAL idle_in_transaction_session_timeout`, en ms. 0 lo desactiva. */
  idleInTransactionTimeoutMs?: number;
}

/** Lo que cada driver aporta: una transacción abierta con sus dos manijas. */
export interface TxRunner {
  run<T>(fn: (tx: BaseTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function timeoutMs(value: number | undefined, fallback: number, name: string): number {
  const ms = value ?? fallback;
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`${name} debe ser un entero de milisegundos ≥ 0; recibió ${String(value)}`);
  return ms;
}

/**
 * Envuelve las manijas para que dejen de servir al cerrar. `db` es un
 * Proxy sobre el ORM de Drizzle: cualquier acceso tras el cierre lanza.
 */
function guardTx(raw: BaseTx): { tx: BaseTx; close(): void } {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new TransactionClosedError();
  };
  const db = new Proxy(raw.db, {
    get(target, prop) {
      assertOpen();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const tx: BaseTx = {
    db,
    query: async (text, params) => {
      assertOpen();
      return raw.query(text, params);
    },
  };
  return {
    tx,
    close: () => {
      closed = true;
    },
  };
}

export function createDb(runner: TxRunner, opts: DbOptions = {}): Db {
  const statementTimeout = timeoutMs(opts.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS, 'statementTimeoutMs');
  const idleTimeout = timeoutMs(opts.idleInTransactionTimeoutMs, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS, 'idleInTransactionTimeoutMs');

  /** Una transacción con timeouts fijados y manijas que mueren al salir de fn. */
  const run = <T>(fn: (tx: BaseTx) => Promise<T>): Promise<T> =>
    runner.run(async (raw) => {
      const guard = guardTx(raw);
      try {
        // Enteros validados arriba; SET LOCAL no admite parámetros.
        await guard.tx.query(`SET LOCAL statement_timeout = ${statementTimeout}`);
        await guard.tx.query(`SET LOCAL idle_in_transaction_session_timeout = ${idleTimeout}`);
        return await fn(guard.tx);
      } finally {
        guard.close();
      }
    });

  return {
    async withWorkspace(workspaceId, fn) {
      // async a propósito: un workspace inválido rechaza la promesa en
      // vez de lanzar antes de devolverla, y quien llama solo maneja un camino.
      assertWorkspaceId(workspaceId);
      return run(async (tx) => {
        await tx.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        return fn({ db: tx.db, query: tx.query, workspaceId });
      });
    },
    withoutWorkspace(fn) {
      return run(fn);
    },
    asWorker(fn) {
      return run(async (tx) => {
        try {
          await tx.query(`SET LOCAL ROLE ${WORKER_ROLE}`);
        } catch (err) {
          throw new Error(
            `No se pudo asumir el rol ${WORKER_ROLE}: ${(err as Error).message}. ` +
              'El rol con el que se conecta tiene que ser miembro de mc_worker (docs/propuestas/CON-2.md §3.1); ' +
              'mc_app no lo es a propósito.',
            { cause: err },
          );
        }
        return fn(tx);
      });
    },
    close: () => runner.close(),
  };
}

// ---------------------------------------------------------------------
// node-postgres
// ---------------------------------------------------------------------

export interface PoolOptions extends DbOptions {
  /** Conexiones máximas. Contra el pooler de Supabase basta con pocas. */
  max?: number;
  /** PGSSLROOTCERT: ruta al CA. null = decidir por el host (ver tls.ts). */
  sslRootCert?: string | null;
  applicationName?: string;
  /** Cuánto esperar una conexión libre del pool antes de fallar. */
  connectionTimeoutMillis?: number;
  /** Cuánto vive una conexión ociosa antes de cerrarse. */
  idleTimeoutMillis?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    ssl: tlsFor(connectionString, opts.sslRootCert ?? null),
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'mc-db',
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
  });
}

export function createPgDb(pool: pg.Pool, opts: DbOptions = {}): Db {
  const runner: TxRunner = {
    async run(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: BaseTx = {
          db: drizzle({ client, schema }),
          query: async (text, params) => {
            const r = await client.query(text, params ? [...params] : undefined);
            return { rows: r.rows };
          },
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return createDb(runner, opts);
}
