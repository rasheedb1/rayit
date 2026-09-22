import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getCurrentWorkspaceId } from "./workspace";

/**
 * Una sola base por proceso, compartida con Finanzas: la misma llave en
 * globalThis que app/(app)/finanzas/_lib/db.ts, para que en modo demo no
 * se levanten dos Postgres embebidos. TODO(CIM-2): esto pasa a
 * packages/db (client.ts) y los dos módulos importan de ahí.
 */
declare global {
  var __mcFinanzasDb: Promise<{ db: Db; mode: DbMode }> | undefined;
}

export function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcFinanzasDb) {
    globalThis.__mcFinanzasDb = createDbFromEnv().then((r) => {
      if (r.mode === "embedded") {
        console.warn("[conexiones] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo).");
      }
      return r;
    });
    globalThis.__mcFinanzasDb.catch(() => {
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
