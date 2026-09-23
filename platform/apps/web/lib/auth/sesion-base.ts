/**
 * Lo que la sesión necesita en los DOS runtimes: el middleware (Edge) y
 * el servidor de Node (páginas, server actions, route handlers). Sin
 * "server-only" y sin nada de Node a propósito: si algo de aquí se
 * moviera a lib/auth/session.ts, el middleware dejaría de poder usarlo.
 *
 * Ronda 4: la sesión se pregunta a Supabase UNA vez por petición.
 * Antes el middleware llamaba a `getUser()` para refrescar la sesión y,
 * en la misma petición, `getSesion()` volvía a llamar a `getUser()`: dos
 * idas y vueltas a Supabase Auth en cada navegación y en cada server
 * action (medido en el log del GoTrue falso), con la latencia fija de
 * Vercel a ca-central pagada dos veces y el límite de peticiones de Auth
 * consumido al doble. Ahora el middleware, que es quien tiene que
 * llamar a `getUser()` para refrescar, deja el resultado YA VERIFICADO
 * en una cabecera de la petición, y getSesion la lee.
 *
 * Por qué eso es seguro: la cabecera la escribe el middleware con
 * `NextResponse.next({ request: { headers } })`, y ese mecanismo
 * REEMPLAZA las cabeceras que ve el resto de la aplicación por las que
 * el middleware pasa. Antes de escribirla, el middleware BORRA
 * cualquier cabecera con ese nombre que traiga la petición, en todos
 * sus caminos (también en los que no llaman a Supabase). Así que lo que
 * lee getSesion solo puede venir del middleware. Lo prueba
 * middleware.test.ts con una cabecera falsificada.
 */
import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";

/**
 * Quién entró, según Supabase. Es lo ÚNICO que la web acepta como
 * prueba de identidad; de aquí salen el correo y el id que el cliente
 * de base fija en cada transacción.
 *
 * `authUserId` es el id de Supabase (auth.users), que NO es el id de
 * app_user. La fila de app_user se encuentra por correo —el seed y
 * cualquier invitación la crean antes de que esa persona entre por
 * primera vez— y desde su primer inicio de sesión queda ligada a este
 * id: otra cuenta con el mismo correo no la hereda.
 */
export interface Sesion {
  authUserId: string;
  email: string;
  /** El nombre que la persona puso en Google o similar, si vino. */
  nombre: string | null;
}

/** La cabecera interna con la sesión verificada. Nunca la manda un navegador: el middleware la borra. */
export const CABECERA_SESION = "x-on-cue-sesion";

/** Valor de la cabecera cuando Supabase no pudo contestar (red, 5xx, 429). */
export const SESION_NO_VERIFICADA = "fallo";

/**
 * De un usuario de Supabase a una Sesion, o null si no sirve como
 * identidad. Lo usan el middleware y /auth/callback.
 *
 * El correo VERIFICADO es toda la frontera entre inquilinos: de él
 * salen la fila de app_user y, con ella, las membresías. Si Supabase
 * alguna vez entrega un usuario con el correo sin confirmar —alguien
 * enciende las contraseñas o apaga «Confirm email» en el panel—,
 * cualquiera podría registrarse con el correo de otra persona y
 * quedarse con su espacio. Ese ajuste del panel sigue en el README,
 * pero como segunda barrera: la primera es esta línea.
 */
export function sesionDeUsuario(user: User | null | undefined): Sesion | null {
  const email = user?.email?.trim();
  if (!user || !email) return null;
  if (!user.email_confirmed_at) return null;
  return { authUserId: user.id, email, nombre: nombreDeMetadata(user.user_metadata) };
}

/**
 * El nombre que el proveedor mandó en `user_metadata`, si mandó alguno.
 * Con el enlace mágico casi nunca viene —el correo es lo único que se
 * pide— pero con Google sí, y entonces es mejor punto de partida que
 * deducirlo del correo.
 */
export function nombreDeMetadata(meta: unknown): string | null {
  const m = meta as { name?: unknown; full_name?: unknown } | null;
  const valor = [m?.full_name, m?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return valor?.trim() ?? null;
}

/**
 * ¿El error de Supabase dice «no hay sesión» o «no pude contestar»? Lo
 * segundo es un fallo de red (AuthRetryableFetchError), un 5xx o un
 * 429: ninguno dice nada de quién eres, así que no pueden convertirse
 * en «no hay nadie».
 */
export function esFalloDelProveedor(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status >= 500 || status === 429);
}

/**
 * La sesión como valor de cabecera. `encodeURIComponent` y no base64:
 * los valores de una cabecera tienen que ser ASCII, el nombre puede
 * llevar tildes («Laura Méndez»), y así funciona igual en Edge que en
 * Node sin Buffer.
 */
export function codificarSesion(sesion: Sesion): string {
  return encodeURIComponent(JSON.stringify(sesion));
}

/**
 * Lo que dice la cabecera: la sesión, `"fallo"` si el middleware no
 * pudo verificarla, o null si no hay (o no es legible, que para quien
 * lee es lo mismo: nadie entra con una cabecera rota).
 */
export function leerCabeceraSesion(valor: string | null | undefined): Sesion | typeof SESION_NO_VERIFICADA | null {
  if (!valor) return null;
  if (valor === SESION_NO_VERIFICADA) return SESION_NO_VERIFICADA;
  try {
    const s = JSON.parse(decodeURIComponent(valor)) as Partial<Sesion> | null;
    if (!s || typeof s.authUserId !== "string" || typeof s.email !== "string" || !s.authUserId || !s.email) return null;
    const nombre = typeof s.nombre === "string" ? s.nombre : null;
    return { authUserId: s.authUserId, email: s.email, nombre };
  } catch {
    return null;
  }
}
