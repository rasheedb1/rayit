import "server-only";
import {
  createDbFromEnv, type Db, type DbMode, type Identity, type IdentityTx, type PublicShareTx, type WorkspaceTx,
} from "@mc/db";
import { createFakeGenerator, createFakeJudge } from "@mc/core/outreach/fake";
import { crearEnlaceDeDemo } from "@mc/db/demo-baja";
import { redactRequestedInProcess } from "@mc/db/queries/outreach";
import { authConfig } from "@/lib/auth/config";

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

/**
 * Adónde apunta el enlace de baja de la demo: APP_URL si está, si no el
 * puerto con el que arrancó la web. Sin ninguno de los dos, null: un
 * enlace sin host no se puede pulsar y no se fabrica (r5).
 */
function baseDeLaDemo(): string | null {
  const app = process.env.APP_URL?.trim();
  if (app && /^https?:\/\//i.test(app)) return app;
  const puerto = process.env.PORT?.trim();
  return puerto && /^\d+$/.test(puerto) ? `http://localhost:${puerto}` : null;
}

/**
 * Solo en modo demo (Postgres embebido, que vive dentro de este proceso):
 * un enlace de baja que se puede pulsar, para recorrer a mano el camino
 * de VEN-15 sin Docker (docs/ventas-outreach.md §5.2). El seed solo
 * guarda hashes de tokens al azar; este lo fabrica como el despachador,
 * sobre el último correo enviado de la demo. Nunca con DATABASE_URL: ahí
 * sería un enlace de baja real. Ni en las pruebas (NODE_ENV=test), ni sin
 * APP_URL o PORT: se imprime solo un enlace que se puede abrir.
 */
async function enlaceDeBajaDeLaDemo(db: Db): Promise<string> {
  // Las pruebas también arrancan la base embebida: ni escriben el enlace ni
  // llenan su salida con él (r5). Y sin una URL absoluta, nada.
  const base = baseDeLaDemo();
  if (process.env.NODE_ENV === "test" || !base) return "";
  try {
    const r = await db.asWorker((tx) => crearEnlaceDeDemo(tx, base));
    if (!r.ok) return "";
    return ` Enlace de baja de prueba (ábrelo sin sesión o en una ventana privada): ${r.url} (a ${r.recipient}).`;
  } catch (err) {
    console.warn("[db] No se pudo crear el enlace de baja de la demo:", err instanceof Error ? err.message : err);
    return "";
  }
}

function getDb(): Promise<{ db: Db; mode: DbMode }> {
  if (!globalThis.__mcDb) {
    // Sin Supabase Auth no existe ningún usuario: las reglas por rol que
    // fallan cerradas (outreach_can_manage, 0038 §7) necesitan la bandera
    // explícita app.auth_disabled. Con Auth configurado no se fija nunca.
    globalThis.__mcDb = createDbFromEnv(process.env, { authDisabled: authConfig() === null }).then(async (r) => {
      if (r.mode === "embedded") {
        const baja = await enlaceDeBajaDeLaDemo(r.db);
        console.warn(
          "[db] Sin DATABASE_URL: Postgres embebido en memoria con el seed (modo demo). " +
            "Para ver la base real: make db.unlock y vuelve a arrancar (el script dev de apps/web lee ../../.env.local)." +
            baja,
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

/**
 * Solo en modo demo (Postgres embebido dentro de este proceso, sin worker
 * que tome la cola): redacta en el momento lo que una persona pidió desde
 * el editor del pitch, con el redactor y el juez falsos (deterministas,
 * sin red ni llave), por el mismo camino que el worker
 * (redactRequestedInProcess, VEN-12). Así «Redactar con IA» se puede
 * probar en la demo. Con DATABASE_URL no hace nada y devuelve false: ahí
 * redacta el worker, con su llave, y un texto de ejemplo nunca toca una
 * base de verdad.
 */
export async function redactarPitchEnLaDemo(touchId: string): Promise<boolean> {
  const { db, mode } = await getDb();
  if (mode !== "embedded") return false;
  const r = await db.asWorker((tx) =>
    redactRequestedInProcess(tx, { touchId, generator: createFakeGenerator(), judge: createFakeJudge(), now: new Date() }),
  );
  return r.status === "returned";
}

/** Cierra la base del proceso. Solo para pruebas y para el apagado; una pantalla nunca la cierra. */
export async function closeDb(): Promise<void> {
  const abierta = globalThis.__mcDb;
  globalThis.__mcDb = undefined;
  if (!abierta) return;
  const { db } = await abierta;
  await db.close();
}
