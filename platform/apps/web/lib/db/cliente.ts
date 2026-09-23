import "server-only";
import {
  createDbFromEnv, type Db, type DbMode, type Identity, type IdentityTx, type PublicShareTx, type WorkspaceTx,
} from "@mc/db";

/**
 * La base de la web: quién la abre y cómo se cierra. Aquí NO se decide
 * el workspace —eso es lib/workspace/current.ts— para que esa decisión
 * pueda consultar la base sin importarse a sí misma.
 *
 * El cliente crudo no sale de este módulo. Antes sí (`getDb()` devolvía
 * el `Db` entero) y con él una pantalla podía escribir `db.asWorker(...)`
 * y leer todos los workspaces saltándose RLS. Lo que sale son dos
 * puertas con nombre: `withWorkspaceId` (la que usa lib/db),
 * `withIdentity` (la de la sesión, solo para lib/auth y
 * lib/workspace) y `withPublicShare` (la de los enlaces públicos de
 * Cotizar, que lib/db reexporta con su explicación).
 *
 * Se guarda en globalThis para sobrevivir a la recarga en caliente de
 * Next en desarrollo: sin esto, cada cambio de archivo levantaría otro
 * Postgres embebido.
 */
declare global {
  var __mcDb: Promise<{ db: Db; mode: DbMode }> | undefined;
}

function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcDb) {
    globalThis.__mcDb = createDbFromEnv().then((r) => {
      if (r.mode === "embedded") {
        console.warn(
          "[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo). " +
            "Para ver la base real: make db.unlock y vuelve a arrancar (el script dev de apps/web lee ../../.env.local).",
        );
      }
      return r;
    });
    globalThis.__mcDb.catch(() => {
      // Si falló al arrancar, que la próxima petición lo intente de nuevo.
      globalThis.__mcDb = undefined;
    });
  }
  return globalThis.__mcDb;
}

/** Una transacción con ESE workspace fijado. Quién es «ese» lo decide lib/workspace/current.ts. */
export async function withWorkspaceId<T>(
  workspaceId: string,
  fn: (tx: WorkspaceTx) => Promise<T>,
  identity?: Identity,
): Promise<T> {
  const { db } = await getDb();
  return db.withWorkspace(workspaceId, fn, identity);
}

/**
 * Transacción de la sesión: sin workspace, con la identidad fijada.
 * Solo sirve para app_user, membership y workspace (ver Db.withIdentity
 * en @mc/db); en cualquier otra tabla devuelve cero filas. La usan
 * lib/auth y lib/workspace, no las pantallas.
 */
export async function withIdentity<T>(identity: Identity, fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withIdentity(identity, fn);
}

/**
 * Transacción de un enlace público de Cotizar: sin workspace y sin
 * identidad. Solo la aceptan las funciones públicas de
 * @mc/db/queries/cotizar (ver withPublicShare en lib/db/index.ts).
 */
export async function withPublicShare<T>(fn: (tx: PublicShareTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withPublicShare(fn);
}

/** Contra qué corre la web: 'postgres' (DATABASE_URL) o 'embedded' (modo demo). */
export async function getDbMode(): Promise<DbMode> {
  return (await getDb()).mode;
}

/** Cierra la base del proceso. Solo para pruebas y para el apagado; una pantalla nunca la cierra. */
export async function closeDb(): Promise<void> {
  const abierta = globalThis.__mcDb;
  globalThis.__mcDb = undefined;
  if (!abierta) return;
  const { db } = await abierta;
  await db.close();
}
