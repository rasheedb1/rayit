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
 *   withCatalogs(fn)        Transacción sin workspace: solo sirve para
 *                           los catálogos sin RLS (platform, niche,
 *                           niche_cpm_benchmark, pipeline_stage,
 *                           signal_source, feature_flag, job_definition).
 *                           En una tabla con RLS devuelve cero filas SIN
 *                           avisar, así que no sale del barril de
 *                           @mc/db: las pantallas leen catálogos por las
 *                           funciones con nombre de queries/catalogos.ts,
 *                           y solo el worker y las pruebas lo abren a
 *                           mano desde @mc/db/client. Se llamaba
 *                           withoutWorkspace, que sonaba a "todos los
 *                           workspaces" — que es lo que hace asWorker.
 *
 *   withPublicShare(fn)     La transacción de los enlaces públicos de
 *                           Cotizar (/kit/<slug>, /cotizacion/<slug>):
 *                           sin workspace, como withCatalogs, pero con
 *                           un tipo propio (PublicShareTx) que solo
 *                           aceptan las tres funciones públicas de
 *                           queries/cotizar.ts. Por sí sola no abre
 *                           nada: lo que se ve lo deciden las funciones
 *                           SECURITY DEFINER de la migración 0026, que
 *                           corren como mc_public_share. Es una
 *                           operación con nombre para que la web no
 *                           tenga que forzar el tipo Db a CatalogDb.
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
 * vez de correr fuera de transacción y sin workspace. Y no solo al
 * acceder a la propiedad: también un constructor de consulta capturado
 * dentro y esperado fuera (`const q = tx.db.select()…` y `await q`
 * después), porque el cliente que Drizzle recibe va envuelto
 * (guardClient).
 *
 * Una transacción no se anida: llamar a withWorkspace / withCatalogs
 * / asWorker desde dentro de otra lanza NestedTransactionError en los
 * dos drivers. Sobre pg abriría una segunda conexión que no ve lo que
 * la primera aún no confirmó; sobre PGlite esperaría para siempre a la
 * transacción que la contiene. Se reutiliza el tx que ya se tiene.
 *
 * Contra Supabase va por el pooler en modo transacción (DATABASE_URL,
 * :6543): como set_config y SET LOCAL son locales a la transacción, la
 * conexión vuelve limpia al pool.
 *
 * Los drivers (pg aquí, PGlite en pglite.ts) solo aportan un TxRunner:
 * abrir la transacción y entregar las dos manijas. La lógica de
 * workspace, rol, timeouts y cierre vive una sola vez, en createDb.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.ts';
import { resolveTls } from './tls.ts';

export type Schema = typeof schema;

/** Cada Db lleva su dueño aquí, para que isInTransaction(db) pueda preguntar por ESE cliente. */
export const TX_OWNER: unique symbol = Symbol.for('mc/db:tx-owner');


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

declare const PUBLIC_SHARE: unique symbol;

/**
 * La transacción de un enlace público (withPublicShare). Es un BaseTx
 * con marca de tipo: las funciones públicas de queries/cotizar.ts solo
 * aceptan esta, así que no se pueden llamar por descuido desde otra
 * transacción, y esta no sirve para ninguna consulta con WorkspaceTx.
 */
export interface PublicShareTx extends BaseTx {
  readonly [PUBLIC_SHARE]: true;
}

/** Una transacción como mc_worker: RLS no aplica. Cada escritura filtra por workspace_id a mano. */
export type WorkerTx = BaseTx;

/**
 * Lo que ve quien recibe una base ya construida (la web, un módulo).
 * No trae withCatalogs a propósito: ver CatalogDb.
 */
export interface Db {
  /** Quién abre las transacciones de este cliente. Lo lee isInTransaction(db); nadie más lo toca. */
  readonly [TX_OWNER]?: object;
  withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T>;
  /** Sin workspace, para los enlaces públicos de Cotizar. Ver PublicShareTx. */
  withPublicShare<T>(fn: (tx: PublicShareTx) => Promise<T>): Promise<T>;
  asWorker<T>(fn: (tx: WorkerTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * La base completa, con la transacción de catálogos. La devuelven las
 * fábricas (createPgDb, createPgliteDb, createEmbeddedDb) y se importa
 * desde `@mc/db/client`, no desde el barril: withCatalogs sobre una
 * tabla con RLS devuelve cero filas en silencio, y quien lo use por
 * descuido buscará el error en la pantalla. Las lecturas de catálogo
 * con nombre están en queries/catalogos.ts.
 */
export interface CatalogDb extends Db {
  withCatalogs<T>(fn: (tx: BaseTx) => Promise<T>): Promise<T>;
}

/** Para INSERT dentro de withWorkspace: `workspaceId: CURRENT_WORKSPACE`. */
export const CURRENT_WORKSPACE = sql<string>`current_workspace_id()`;

export const WORKER_ROLE = 'mc_worker';

export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Para validar ids que llegan de fuera (rutas, formularios) antes de consultar. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function assertWorkspaceId(workspaceId: string): void {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error(`workspace_id inválido: "${workspaceId}". Debe ser un UUID.`);
  }
}

/** Se lanza al usar `tx.db` o `tx.query` después de que su transacción terminó. */
export class TransactionClosedError extends Error {
  constructor() {
    super(
      'Transacción cerrada: tx.db y tx.query solo valen dentro de withWorkspace / withCatalogs / asWorker. ' +
        'No devuelvas tx desde fn; devuelve el resultado.',
    );
    this.name = 'TransactionClosedError';
  }
}

/**
 * Marca de transacción abierta en la cadena asíncrona actual. Guarda el
 * dueño (un objeto por cliente), así que dos bases distintas —la del
 * worker y la de una prueba— no se estorban.
 */
const openTx = new AsyncLocalStorage<object>();

/**
 * ¿La cadena asíncrona actual está dentro de una transacción?
 *
 * Con `db`, pregunta por ese cliente; sin argumento, por cualquiera. Lo
 * usa pglite.ts para negarse a correr `raw` / `admin` dentro de una
 * transacción, que sobre PGlite sería un interbloqueo silencioso.
 */
export function isInTransaction(db?: Db): boolean {
  const owner = openTx.getStore();
  if (owner === undefined) return false;
  if (!db) return true;
  return owner === (db as unknown as Record<symbol, unknown>)[TX_OWNER];
}

/** Se lanza al abrir una transacción desde dentro de otra del mismo cliente. */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      'Transacción anidada: reutiliza el tx que ya tienes. withWorkspace / withCatalogs / asWorker ' +
        'no se llaman desde dentro de otra transacción del mismo cliente.',
    );
    this.name = 'NestedTransactionError';
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
 * Envuelve el cliente del driver (un PoolClient de `pg`, la instancia
 * de PGlite) para que su método de ejecución compruebe, en cada
 * consulta, que la transacción sigue abierta.
 *
 * Es la otra mitad de guardTx, y hace falta porque el Proxy de `tx.db`
 * solo lanza en el ACCESO a una propiedad: un constructor de consulta
 * capturado DENTRO de la transacción y esperado fuera
 *
 *     const q = tx.db.select().from(deal);   // dentro: el acceso pasa
 *     await q;                               // fuera: ya no hay transacción
 *
 * se llevaba la referencia al ejecutor y corría sobre una conexión ya
 * devuelta al pool, fuera de toda transacción y sin workspace fijado.
 * Con el guard aquí, esa espera tardía lanza TransactionClosedError.
 */
export function guardClient<C extends object>(client: C, assertOpen: () => void): C {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== 'query') return fn.bind(target);
      return (...args: unknown[]) => {
        assertOpen();
        return fn.apply(target, args);
      };
    },
  });
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

export function createDb(runner: TxRunner, opts: DbOptions = {}): CatalogDb {
  const statementTimeout = timeoutMs(opts.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS, 'statementTimeoutMs');
  const idleTimeout = timeoutMs(opts.idleInTransactionTimeoutMs, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS, 'idleInTransactionTimeoutMs');

  /**
   * El dueño de las transacciones de ESTE cliente: dentro de fn está en
   * el AsyncLocalStorage, y volver a entrar lanza antes de tocar el
   * driver. Dos bases distintas (la del worker y la de una prueba) no
   * se estorban porque cada una tiene su propio objeto.
   */
  const owner = {};

  /** Una transacción con timeouts fijados y manijas que mueren al salir de fn. */
  const run = async <T>(fn: (tx: BaseTx) => Promise<T>): Promise<T> => {
    if (openTx.getStore() === owner) throw new NestedTransactionError();
    return openTx.run(owner, () =>
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
      }),
    );
  };

  return {
    [TX_OWNER]: owner,
    async withWorkspace(workspaceId, fn) {
      // async a propósito: un workspace inválido rechaza la promesa en
      // vez de lanzar antes de devolverla, y quien llama solo maneja un camino.
      assertWorkspaceId(workspaceId);
      return run(async (tx) => {
        await tx.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
        return fn({ db: tx.db, query: tx.query, workspaceId });
      });
    },
    withCatalogs(fn) {
      return run(fn);
    },
    withPublicShare(fn) {
      // La marca es solo de tipo: en tiempo de ejecución es la misma
      // transacción sin workspace que withCatalogs.
      return run((tx) => fn(tx as PublicShareTx));
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
  /**
   * Qué hacer cuando se rompe una conexión OCIOSA del pool. Sin esto se
   * escribe en console.error; lo que no se puede es dejarlo sin oyente
   * (ver createPool). La web le pasa su logger.
   */
  onError?: (err: Error) => void;
}

/**
 * El pool de `pg` con el TLS decidido en un solo sitio.
 *
 * `pg` re-parsea la cadena de conexión DESPUÉS de la configuración
 * explícita, así que un `?sslmode=…` en la URL ganaría sobre el `ssl`
 * que pasemos aquí: `no-verify` apagaría la verificación, `disable`
 * mandaría texto plano y `require` descartaría la CA embebida. Por eso
 * resolveTls lanza (host con CA propia) o traduce el parámetro y lo
 * borra de la URL (host sin CA propia) antes de construir el Pool.
 *
 * Y el pool SIEMPRE sale con un oyente de 'error'. `pg` emite ese
 * evento en el Pool cuando se rompe una conexión OCIOSA —el pooler de
 * Supabase cierra las ociosas de forma rutinaria, y también lo hace un
 * reinicio de Supavisor o un corte de red—, y un EventEmitter sin
 * oyente de 'error' LANZA: se caería el proceso entero de Next con
 * ERR_UNHANDLED_ERROR, no una petición. No hay nada que hacer con la
 * conexión (el pool ya la descarta), así que basta con dejar rastro.
 */
export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const tls = resolveTls(connectionString, opts.sslRootCert ?? null);
  const pool = new pg.Pool({
    connectionString: tls.connectionString,
    ssl: tls.ssl,
    max: opts.max ?? 5,
    application_name: opts.applicationName ?? 'mc-db',
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
  });
  pool.on('error', (err: Error) => {
    if (opts.onError) opts.onError(err);
    // A stderr y no a console: este paquete no impone un logger (el
    // worker tiene el suyo, la web el de Next) y su lint prohíbe
    // console.* a propósito. Quien quiera el suyo pasa onError.
    else process.stderr.write(`[db] conexión ociosa rota; el pool la descarta y abre otra: ${err.message}\n`);
  });
  return pool;
}

export function createPgDb(pool: pg.Pool, opts: DbOptions = {}): CatalogDb {
  const runner: TxRunner = {
    async run(fn) {
      const client = await pool.connect();
      // Si el ROLLBACK falla la conexión está rota (o a medias): se
      // devuelve al pool con el error para que pg la destruya en vez de
      // prestársela, con la transacción abierta, a la siguiente petición.
      let broken: Error | undefined;
      // Lo que ve Drizzle es el cliente envuelto: una consulta esperada
      // después de que la transacción cerró lanza en vez de correr sobre
      // una conexión ya devuelta al pool (ver guardClient).
      let abierta = true;
      const guarded = guardClient(client, () => {
        if (!abierta) throw new TransactionClosedError();
      });
      try {
        await client.query('BEGIN');
        const tx: BaseTx = {
          db: drizzle({ client: guarded, schema }),
          query: async (text, params) => {
            const r = await client.query(text, params ? [...params] : undefined);
            return { rows: r.rows };
          },
        };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch((e: unknown) => {
          broken = e instanceof Error ? e : new Error(String(e));
        });
        throw err;
      } finally {
        abierta = false;
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
  return createDb(runner, opts);
}
