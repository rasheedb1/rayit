import "server-only";
import { cache } from "react";
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
 * `cache` de React lo memoriza por petición: la pantalla, el marco y el
 * selector de espacio preguntan una vez entre los tres.
 */
export const getSesion = cache(async (): Promise<Sesion | null> => {
  if (!isAuthConfigured()) return null;
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  const meta = data.user.user_metadata as { name?: unknown; full_name?: unknown } | null;
  const nombre = [meta?.full_name, meta?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return {
    authUserId: data.user.id,
    email: data.user.email.trim(),
    nombre: nombre?.trim() ?? null,
  };
});
