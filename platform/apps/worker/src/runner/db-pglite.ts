/**
 * Postgres embebido (pglite) para pruebas, para `--pglite`/`--demo` y
 * para cualquier máquina sin Docker. Es Postgres 16 de verdad compilado
 * a WASM: corren todas las migraciones del repo (incluida 0014, los
 * privilegios de mc_worker), los roles, RLS y pg-boss.
 *
 * Una sola sesión, así que el cambio de rol no puede ser por conexión:
 * cada consulta de negocio va dentro de una transacción con
 * `SET LOCAL ROLE mc_worker`, que se deshace al terminar. pg-boss, que
 * comparte la sesión, sigue corriendo como superusuario. Es el mismo
 * reparto de roles que en Supabase, con otra mecánica.
 *
 * Está en su propio módulo para que el arranque normal (Postgres real)
 * no cargue el WASM ni dependa de @electric-sql/pglite.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { fromPglite } from 'pg-boss';
import { quoteIdent, type BossConnection, type Queryable, type QueryResult, type RoleCheck, type Row, type WorkerDatabase } from './db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'db', 'migrations');

export interface PgliteDatabaseOptions {
  setRole: string | null;
  /** Directorio con *.sql a aplicar en orden; por defecto las migraciones del repo. */
  migrationsDir?: string;
}

const ROLE_SQL = `SELECT current_user AS current_user, session_user AS session_user,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls`;

export class PgliteDatabase implements WorkerDatabase {
  readonly kind = 'pglite' as const;
  readonly #db: PGlite;
  readonly #setRole: string | null;

  private constructor(db: PGlite, setRole: string | null) {
    this.#db = db;
    this.#setRole = setRole;
  }

  static async open(opts: PgliteDatabaseOptions): Promise<PgliteDatabase> {
    const db = await PGlite.create({ extensions: { citext, pg_trgm } });
    const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) await db.exec(await readFile(join(dir, f), 'utf8'));
    return new PgliteDatabase(db, opts.setRole);
  }

  /** Acceso directo como superusuario: para sembrar datos en pruebas y demos. */
  get raw(): PGlite {
    return this.#db;
  }

  bossConnection(): BossConnection {
    return { db: fromPglite(this.#db), backend: 'pglite' };
  }

  async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    if (!this.#setRole) return this.#run<R>(this.#db, text, params);
    return this.transaction((tx) => tx.query<R>(text, params));
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      if (this.#setRole) await tx.query(`SET LOCAL ROLE ${quoteIdent(this.#setRole)}`);
      const q: Queryable = { query: (text, params = []) => this.#run(tx, text, params) };
      return fn(q);
    });
  }

  async #run<R extends Row>(target: PGlite | Transaction, text: string, params: readonly unknown[]): Promise<QueryResult<R>> {
    const res = await target.query<R>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  async whoAmI(): Promise<RoleCheck> {
    const { rows } = await this.query(ROLE_SQL);
    const row = rows[0];
    return {
      currentUser: String(row?.['current_user'] ?? ''),
      sessionUser: String(row?.['session_user'] ?? ''),
      bypassRls: row?.['bypass_rls'] === true,
    };
  }

  async close(): Promise<void> {
    await this.#db.close();
  }
}
