import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getCurrentWorkspaceId } from "./workspace";

/**
 * La conexión a la base de la web, compartida por todos los módulos
 * (Finanzas, Campañas…). Una sola base por proceso, guardada en
 * globalThis para sobrevivir a la recarga en caliente de Next en
 * desarrollo: sin esto, cada cambio de archivo levantaría otro Postgres
 * embebido en modo demo.
 *
 * PROVISIONAL: TODO(CIM-2) cuando packages/db exponga el cliente real
 * con withWorkspace, esto se reduce a reexportarlo; TODO(CIM-3) el
 * workspace saldrá de la sesión (lib/workspace/), no de ./workspace.
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
