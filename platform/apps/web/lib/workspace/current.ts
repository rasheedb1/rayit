import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { Identity } from "@mc/db";
import { AuthIdentityMismatchError, type MyWorkspace } from "@mc/db/queries/identidad";
import { isAuthConfigured, type Env } from "@/lib/auth/config";
import { getSesion, type Sesion } from "@/lib/auth/session";
import { leerOCrearSesion } from "@/lib/auth/sincronizar";
import { espacioDeLaCookie } from "./elegir";

/**
 * El workspace actual: la ÚNICA costura entre la sesión y la base.
 *
 * Desde CIM-3 sale de la sesión de Supabase; la cookie firmada
 * `mc.workspace` solo dice CUÁL de mis espacios prefiero. El orden:
 *
 *   1. ¿hay sesión? Si no, y Supabase Auth está configurado, a /login.
 *      Siempre. Solo una copia SIN llaves (modo demo) sirve algo sin
 *      sesión (ver abajo).
 *   2. ¿quién soy? Se resuelve SIEMPRE desde el correo verificado de la
 *      sesión: `withIdentity({ email })` y `email = current_user_email()`
 *      (migración sesion_correo_verificado). Nunca desde la cookie.
 *   3. ¿a qué espacios pertenezco? Sale de membership, en la misma
 *      transacción, por `user_id = current_user_id()` (0019).
 *   4. ¿cuál sirvo? El de la cookie SI ESTÁ EN ESA LISTA, y si no el
 *      primero.
 *
 * Por qué así y no al revés (ronda 2, hallazgo 1): antes el id de
 * app_user salía de la propia cookie y luego se preguntaba «¿ese id es
 * miembro?» con RLS fijada a ESE MISMO id, así que la respuesta era
 * siempre sí. La frontera entre inquilinos colgaba de un único HMAC:
 * quien pudiera fabricar una cookie firmada entraba en cualquier
 * espacio. Ahora la cookie no aporta identidad ninguna —solo una
 * preferencia que se comprueba contra la lista que devuelve la base—,
 * así que aunque la firma se rompiera, lo único que se podría hacer con
 * ella es elegir entre los espacios que ya son tuyos.
 *
 * Y NO ESCRIBE: este camino solo hace SELECT (ver lib/auth/sincronizar.ts).
 * Pintar una pantalla no toca `last_seen_at` ni ninguna otra columna.
 *
 * FALLA CERRADO (ronda 3). Antes, sin sesión se servía el espacio de
 * DEMO_WORKSPACE_ID aunque la autenticación estuviera configurada, y
 * toda la protección colgaba del middleware. Bastó una ruta que el
 * matcher no miraba (`/campanas/x.txt` con la cabecera Next-Action de
 * una server action) para leer y escribir el espacio del seed sin
 * sesión. Ahora ESTE es el punto que decide, para cualquier pantalla,
 * server action o route handler que abra una transacción: con llaves y
 * sin sesión, `redirect('/login')` —que Next convierte en la respuesta
 * adecuada en los tres casos— y ningún workspace. El middleware queda
 * como la primera barrera, no como la única.
 *
 * DEMO_WORKSPACE_ID sobrevive como ATAJO DE DESARROLLO y nada más: solo
 * se lee cuando Supabase Auth NO está configurado (una copia sin
 * `make db.unlock`, las pruebas). Con llaves, la variable no existe
 * para este archivo aunque esté fijada.
 *
 * Las consultas reciben el workspace dentro de la transacción
 * (`withWorkspace` de lib/db), nunca como parámetro suelto ni desde un
 * componente.
 */

/** Workspace de la creadora ficticia del seed (db/seed/0002 y 0003). Se entra a él con demo@multicampaign.test. */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo que una petición necesita saber antes de abrir una transacción. */
export interface Contexto {
  workspaceId: string;
  /** Quién es, cuando hay sesión. En modo demo no hay nadie y app.user_id queda NULL. */
  identity?: Identity;
  sesion: Sesion | null;
  /**
   * Mis espacios, ya resueltos. Van aquí para que el marco no vuelva a
   * preguntarlos: el selector los pinta y la pantalla los ignora.
   */
  workspaces: readonly MyWorkspace[];
}

/** Se avisa una vez por proceso, no en cada petición. */
let avisado = false;

/**
 * El workspace de una copia SIN autenticación: el atajo de desarrollo.
 *
 * Con Supabase Auth configurado lanza, sin mirar la variable: no hay
 * ningún camino legítimo que sirva un espacio a quien no tiene sesión,
 * y dejar que esto devolviera algo «por si acaso» es exactamente lo que
 * convertía una ruta mal protegida en una fuga.
 *
 * En producción la variable es obligatoria, con el mismo criterio que
 * from-env.ts aplica a DATABASE_URL: un despliegue sin sesión y sin
 * variable serviría un workspace fijo y codificado leyendo la Supabase
 * real. Si hace falta el del seed en producción a propósito (una demo
 * pública), se dice en voz alta con ALLOW_SEED_WORKSPACE=1.
 */
export function workspaceDeDesarrollo(env: Env = process.env, warn: (message: string) => void = console.warn): string {
  if (isAuthConfigured(env)) {
    throw new Error(
      "Con Supabase Auth configurado no hay espacio sin sesión: DEMO_WORKSPACE_ID solo vale en una copia sin llaves.",
    );
  }
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
          "(NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY) no se llega aquí: sin sesión se va a /login. " +
          "Para servir a propósito el workspace del seed en una copia sin llaves, ALLOW_SEED_WORKSPACE=1.",
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
 * regla que hace que cambiar de espacio cambie lo que se ve, y también
 * la que convierte la cookie en una preferencia y no en un permiso.
 */
export function elegirWorkspaceId(preferido: string | null, mios: readonly { id: string }[]): string | null {
  if (preferido && mios.some((w) => w.id === preferido)) return preferido;
  return mios[0]?.id ?? null;
}

/**
 * El contexto de ESTA petición. `cache` de React lo memoriza: la
 * pantalla, el marco y el selector de espacio preguntan una vez entre
 * los tres, así que toda la resolución cuesta una transacción.
 */
export const getCurrentContext = cache(async (): Promise<Contexto> => {
  const sesion = await getSesion();
  if (!sesion) {
    // Con llaves y sin sesión no hay NADA que servir. `redirect` lanza,
    // así que de aquí no sale ningún workspace.
    if (isAuthConfigured()) redirect("/login");
    return { workspaceId: workspaceDeDesarrollo(), sesion: null, workspaces: [] };
  }

  // Quién soy y qué es mío, desde el correo verificado. Solo da de alta
  // si no hay absolutamente nada que leer (primer inicio de sesión, o
  // un callback que falló a medias).
  const mio = await leerOCrearSesion(sesion).catch((err: unknown) => {
    // Otra cuenta de Auth con el correo de alguien (un buzón
    // reasignado): no se le sirve nada. A /login con su texto, no a un
    // error genérico; el callback ya no deja entrar así, esto cubre una
    // sesión que existiera de antes.
    if (err instanceof AuthIdentityMismatchError) {
      console.error(`[auth] identidad en conflicto (${err.motivo}): cuenta de Auth ${sesion.authUserId}`);
      return null;
    }
    throw err;
  });
  if (!mio) redirect("/login?error=identidad");
  const { userId, workspaces } = mio;

  const preferido = await espacioDeLaCookie(sesion.email);
  const workspaceId = elegirWorkspaceId(preferido?.w ?? null, workspaces);
  if (!workspaceId) {
    // leerOCrearSesion crea uno si no había ninguno, así que llegar
    // aquí sería un fallo suyo, no un estado normal.
    throw new Error(`La sesión de ${sesion.email} no tiene ningún espacio después de sincronizar.`);
  }
  return { workspaceId, identity: { userId, email: sesion.email }, sesion, workspaces };
});

/** El id del workspace actual. Lo usa lib/db; una pantalla no lo necesita. */
export async function getCurrentWorkspaceId(): Promise<string> {
  return (await getCurrentContext()).workspaceId;
}
