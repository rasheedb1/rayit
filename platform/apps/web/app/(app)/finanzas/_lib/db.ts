import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getCurrentWorkspaceId } from "./workspace";

/**
 * Una sola base por proceso. Se guarda en globalThis para sobrevivir a
 * la recarga en caliente de Next en desarrollo: sin esto, cada cambio
 * de archivo levantaría otro Postgres embebido.
 */
declare global {
  var __mcFinanzasDb: Promise<{ db: Db; mode: DbMode }> | undefined;
}

export function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcFinanzasDb) {
    globalThis.__mcFinanzasDb = createDbFromEnv().then((r) => {
      if (r.mode === "embedded") {
        console.warn("[finanzas] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo).");
      }
      return r;
    });
    globalThis.__mcFinanzasDb.catch(() => {
      // Si falló al arrancar, que la próxima petición lo intente de nuevo.
      globalThis.__mcFinanzasDb = undefined;
    });
  }
  return globalThis.__mcFinanzasDb;
}

/** Abre una transacción con el workspace actual fijado y ejecuta fn. */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  return db.withWorkspace(getCurrentWorkspaceId(), fn);
}
