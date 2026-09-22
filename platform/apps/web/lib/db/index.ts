import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getCurrentWorkspaceId } from "@/lib/workspace/current";

/**
 * La base de datos de la web, una por proceso, y la ÚNICA forma en que
 * una pantalla abre una transacción: `withWorkspace(fn)`.
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

export function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcDb) {
    globalThis.__mcDb = createDbFromEnv().then((r) => {
      if (r.mode === "embedded") {
        console.warn("[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo).");
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
