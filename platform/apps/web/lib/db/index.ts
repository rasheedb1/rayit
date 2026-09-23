import "server-only";
import { createDbFromEnv, type Db, type DbMode, type WorkspaceTx } from "@mc/db";
import { getWorkspace } from "@mc/db/queries/cimientos";
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

/**
 * Los workspaces que ya se comprobó que existen en esta base, en este
 * proceso. Se vacía con closeDb: otra base, otra comprobación.
 */
const existentes = new Set<string>();

/**
 * Abre una transacción con el workspace actual fijado y ejecuta fn.
 *
 * La PRIMERA vez que ve un workspace en el proceso, comprueba dentro de
 * la misma transacción que la fila exista (getWorkspace lanza «El
 * workspace … no existe en esta base» si no). Sin esto, un
 * DEMO_WORKSPACE_ID que no corresponde a ninguna fila se veía de dos
 * formas según el módulo: Finanzas y Ventas leen la fila workspace para
 * formatear y caían en su frontera, pero Campañas y Conexiones no la
 * leen y pintaban «Todavía no hay campañas» como si fuera un workspace
 * nuevo. Aquí se decide una vez, para todos los módulos —también para
 * el próximo—, y el error cae en la frontera del segmento (app).
 *
 * La comprobación va aquí y no en el layout de (app) porque un error del
 * layout lo recoge la frontera del segmento PADRE, que ya no pinta el
 * Shell. Y se recuerda el éxito por proceso para no pagar una consulta
 * más en cada transacción.
 */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { db } = await getDb();
  const id = getCurrentWorkspaceId();
  return db.withWorkspace(id, async (tx) => {
    if (!existentes.has(id)) {
      await getWorkspace(tx);
      existentes.add(id);
    }
    return fn(tx);
  });
}

/** Contra qué corre la web: 'postgres' (DATABASE_URL) o 'embedded' (modo demo). */
export async function getDbMode(): Promise<DbMode> {
  return (await getDb()).mode;
}

/** Cierra la base del proceso. Solo para pruebas y para el apagado; una pantalla nunca la cierra. */
export async function closeDb(): Promise<void> {
  const abierta = globalThis.__mcDb;
  globalThis.__mcDb = undefined;
  existentes.clear();
  if (!abierta) return;
  const { db } = await abierta;
  await db.close();
}
