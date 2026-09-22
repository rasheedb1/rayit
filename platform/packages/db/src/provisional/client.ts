/**
 * Cliente de base PROVISIONAL, hasta que exista packages/db/src/client.ts
 * (CIM-2, Rasheed). Implementa el contrato del backlog: cada consulta
 * corre dentro de una transacción que fija `app.workspace_id` con
 * set_config(…, true), y ninguna consulta recibe el workspace como
 * parámetro suelto: sale del contexto de la transacción (RLS filtra las
 * lecturas; los INSERT usan current_workspace_id()).
 *
 * Cuando CIM-2 llegue, las consultas de queries/finanzas.ts solo
 * necesitan que su `tx` cumpla la interfaz WorkspaceTx de aquí; el
 * cambio es la importación, no las consultas. Detalle en
 * docs/propuestas/FIN-1.md.
 */
import type pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

/** Una transacción con el workspace ya fijado. */
export interface WorkspaceTx extends SqlExecutor {
  readonly workspaceId: string;
}

export interface Db {
  /**
   * Abre una transacción, fija app.workspace_id solo para ella
   * (is_local = true) y ejecuta fn. Commit si resuelve, rollback si lanza.
   */
  withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertWorkspaceId(workspaceId: string): void {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`workspace_id inválido: "${workspaceId}". Debe ser un UUID.`);
  }
}

/**
 * Sobre node-postgres. En Supabase va contra el pooler en modo
 * transacción (DATABASE_URL, :6543): como set_config es local a la
 * transacción, la conexión vuelve limpia al pool.
 */
export function createPgDb(pool: pg.Pool): Db {
  return {
    async withWorkspace(workspaceId, fn) {
      assertWorkspaceId(workspaceId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const tx: WorkspaceTx = {
          workspaceId,
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
}

/** Lo mínimo que usamos de PGlite, para no depender de sus tipos aquí. */
export interface PgliteLike {
  transaction<T>(fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Sobre PGlite (Postgres embebido): pruebas y modo demo sin servidor.
 * PGlite serializa las transacciones, así que dos withWorkspace en
 * paralelo se ejecutan una detrás de otra; eso conserva las garantías
 * pero no ejercita la concurrencia real (para eso, TEST_DATABASE_URL).
 */
export function createPgliteDb(pglite: PgliteLike): Db {
  return {
    async withWorkspace(workspaceId, fn) {
      assertWorkspaceId(workspaceId);
      return pglite.transaction(async (t) => {
        await t.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        const tx: WorkspaceTx = {
          workspaceId,
          query: async (text, params) => {
            const r = await t.query(text, params ? [...params] : undefined);
            return { rows: r.rows as never[] };
          },
        };
        return fn(tx);
      });
    },
    close: () => pglite.close(),
  };
}
