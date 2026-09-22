import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getCurrentWorkspaceId } from "@/lib/workspace/current";

/**
 * La base de datos de la web y la ÚNICA forma en que una pantalla abre
 * una transacción: `withWorkspace(fn)`.
 *
 * El cliente crudo NO sale de este módulo. Antes sí (`getDb()` devolvía
 * el `Db` entero) y con él una pantalla podía escribir
 * `db.asWorker(...)` y leer todos los workspaces saltándose RLS, o abrir
 * una transacción de catálogos sin querer. Nadie lo usaba fuera de la
 * prueba de este archivo, así que el ensanche de la costura no compraba
 * nada. Si algún día una pantalla necesita un catálogo, va con nombre
 * en `@mc/db/queries/catalogos`, no por el cliente crudo.
 *
 * El workspace lo pone lib/workspace/current.ts (DEMO_WORKSPACE_ID
 * hasta CIM-3, la sesión después) y lo fija el cliente dentro de la
 * transacción. Ninguna pantalla ni server action recibe ni pasa un
 * workspace_id.
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

/** Abre una transacción con el workspace actual fijado y ejecuta fn. */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withWorkspace(getCurrentWorkspaceId(), fn);
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
