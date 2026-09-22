import "server-only";
import { cache } from "react";
import { isMemberOf } from "@mc/db/queries/identidad";
import type { Identity } from "@mc/db";
import { getSesion, type Sesion } from "@/lib/auth/session";
import { sincronizarSesion } from "@/lib/auth/sincronizar";
import { withIdentity } from "@/lib/db/cliente";
import { espacioDeLaCookie } from "./elegir";

/**
 * El workspace actual: la ÚNICA costura entre la sesión y la base.
 *
 * Desde CIM-3 sale de la sesión de Supabase y de la cookie firmada
 * `mc.workspace`, en este orden:
 *
 *   1. ¿hay sesión? Si no, la web va en modo demo (ver abajo).
 *   2. ¿la cookie trae un espacio, con firma válida y del correo de
 *      ESTA sesión? Entonces se comprueba la membresía contra la base,
 *      en cada petición. Una persona a la que le quitaron el acceso
 *      deja de ver ese espacio en la siguiente, no cuando caduque su
 *      cookie.
 *   3. Si no hay cookie usable, se sincroniza la sesión (app_user,
 *      membresías y, si no tiene ninguna, su primer espacio) y se sirve
 *      el primero.
 *
 * DEMO_WORKSPACE_ID sobrevive como ATAJO DE DESARROLLO y nada más: solo
 * se mira cuando no hay sesión, que con Supabase Auth configurado solo
 * ocurre en las rutas públicas y en las pruebas. Una sesión SIEMPRE
 * manda sobre la variable.
 *
 * Las consultas reciben el workspace dentro de la transacción
 * (`withWorkspace` de lib/db), nunca como parámetro suelto ni desde un
 * componente.
 */

/** Workspace de la creadora ficticia del seed (db/seed/0003, docs/propuestas/CIM-8.md). */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Env = Readonly<Record<string, string | undefined>>;

/** Lo que una petición necesita saber antes de abrir una transacción. */
export interface Contexto {
  workspaceId: string;
  /** Quién es, cuando hay sesión. En modo demo no hay nadie y app.user_id queda NULL. */
  identity?: Identity;
  sesion: Sesion | null;
}

/** Se avisa una vez por proceso, no en cada petición. */
let avisado = false;

/**
 * El workspace cuando NO hay sesión: el atajo de desarrollo.
 *
 * En producción la variable es obligatoria, con el mismo criterio que
 * from-env.ts aplica a DATABASE_URL: un despliegue sin sesión y sin
 * variable serviría un workspace fijo y codificado leyendo la Supabase
 * real. Si hace falta el del seed en producción a propósito (una demo
 * pública), se dice en voz alta con ALLOW_SEED_WORKSPACE=1.
 */
export function workspaceDeDesarrollo(env: Env = process.env, warn: (message: string) => void = console.warn): string {
  const id = env.DEMO_WORKSPACE_ID?.trim();
  const produccion = env.NODE_ENV === "production";
  if (id) {
    if (!UUID_RE.test(id)) {
      throw new Error(`DEMO_WORKSPACE_ID no es un UUID: "${id}". Debe ser el id de una fila de workspace.`);
    }
    if (produccion && !avisado) {
      avisado = true;
      warn("[workspace] DEMO_WORKSPACE_ID es un atajo de desarrollo y está fijado en producción: sin sesión se sirve ese espacio");
    }
    return id;
  }
  if (produccion) {
    if (env.ALLOW_SEED_WORKSPACE !== "1") {
      throw new Error(
        "Sin sesión y sin DEMO_WORKSPACE_ID no hay workspace que servir. Con Supabase Auth configurado " +
          "(NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY) esto no debería pasar: el middleware manda a " +
          "/login antes. Para servir a propósito el workspace del seed, ALLOW_SEED_WORKSPACE=1.",
      );
    }
    if (!avisado) {
      avisado = true;
      warn("[workspace] ALLOW_SEED_WORKSPACE=1: producción sirve el workspace del seed a quien no tiene sesión");
    }
  }
  return SEED_WORKSPACE_ID;
}

/**
 * Cuál de mis espacios se sirve: el que dice la cookie si sigue siendo
 * mío, y si no el primero (el más antiguo, que es donde la gente tiene
 * su trabajo). Aparte y sin dependencias para poder probarlo: es la
 * regla que hace que cambiar de espacio cambie lo que se ve.
 */
export function elegirWorkspaceId(preferido: string | null, mios: readonly { id: string }[]): string | null {
  if (preferido && mios.some((w) => w.id === preferido)) return preferido;
  return mios[0]?.id ?? null;
}

/**
 * El contexto de ESTA petición. `cache` de React lo memoriza: la
 * pantalla, el marco y el selector de espacio preguntan una vez entre
 * los tres, y la comprobación de membresía se hace una sola vez.
 */
export const getCurrentContext = cache(async (): Promise<Contexto> => {
  const sesion = await getSesion();
  if (!sesion) return { workspaceId: workspaceDeDesarrollo(), sesion: null };

  const elegido = await espacioDeLaCookie(sesion.email);
  if (elegido) {
    const identity: Identity = { userId: elegido.u, email: sesion.email };
    const esMiembro = await withIdentity(identity, (tx) => isMemberOf(tx, elegido.w, elegido.u));
    if (esMiembro) return { workspaceId: elegido.w, identity, sesion };
  }

  // Sin cookie usable: se resuelve desde la base. Es también el camino
  // del primer inicio de sesión, que crea la persona y su espacio.
  const { userId, workspaces } = await sincronizarSesion(sesion);
  const workspaceId = elegirWorkspaceId(elegido?.w ?? null, workspaces);
  if (!workspaceId) {
    // sincronizarSesion crea uno si no había ninguno, así que llegar
    // aquí sería un fallo suyo, no un estado normal.
    throw new Error(`La sesión de ${sesion.email} no tiene ningún espacio después de sincronizar.`);
  }
  return { workspaceId, identity: { userId, email: sesion.email }, sesion };
});

/** El id del workspace actual. Lo usa lib/db; una pantalla no lo necesita. */
export async function getCurrentWorkspaceId(): Promise<string> {
  return (await getCurrentContext()).workspaceId;
}
