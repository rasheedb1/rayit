import "server-only";
import { cache } from "react";
import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";
import { isAuthConfigured } from "./config";
import { createServerSupabase } from "./supabase";

/**
 * Quién entró, según Supabase. Es lo ÚNICO que la web acepta como
 * prueba de identidad; de aquí salen el correo y el id que el cliente
 * de base fija en cada transacción.
 *
 * `authUserId` es el id de Supabase (auth.users), que NO es el id de
 * app_user: la fila de app_user se busca por correo, porque el seed y
 * cualquier invitación futura la crean antes de que esa persona entre
 * por primera vez.
 */
export interface Sesion {
  authUserId: string;
  email: string;
  /** El nombre que la persona puso en Google o similar, si vino. */
  nombre: string | null;
}

/**
 * `getUser()` y no `getSession()`: el segundo se cree la cookie sin
 * preguntar, y la cookie la escribe el navegador. Este pregunta al
 * servidor de Supabase y por eso vale como autenticación.
 *
 * Tres salidas, y la diferencia importa (ronda 3):
 *
 *   Sesion   hay usuario y su correo está VERIFICADO.
 *   null     no hay sesión, caducó, o el correo no está verificado.
 *   lanza    Supabase no pudo contestar (red, 5xx, 429). Antes esto
 *            también era null, y con el atajo de desarrollo detrás
 *            significaba que una caída del proveedor servía el espacio
 *            demo a quien sí tenía sesión. Ahora lo recoge el
 *            error.tsx del segmento, con su «Reintentar».
 *
 * `cache` de React lo memoriza por petición: la pantalla, el marco y el
 * selector de espacio preguntan una vez entre los tres.
 */
export const getSesion = cache(async (): Promise<Sesion | null> => {
  if (!isAuthConfigured()) return null;
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (esFalloDelProveedor(error)) {
      throw new Error("No pudimos comprobar la sesión con Supabase Auth: el servicio no respondió.", { cause: error });
    }
    return null;
  }
  return sesionDeUsuario(data.user);
});

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
 * De un usuario de Supabase a una Sesion, o null si no sirve como
 * identidad. Lo usan getSesion y /auth/callback, que lee el usuario que
 * devuelve el intercambio del código.
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
