import "server-only";
import { cookies } from "next/headers";
import { olvidarEspacio } from "@/lib/workspace/elegir";
import { isAuthConfigured } from "./config";
import { PREFIJO_COOKIE_SESION } from "./cookies";
import { createServerSupabase } from "./supabase";

/**
 * Cierra la sesión de ESTE navegador, pase lo que pase con Supabase.
 *
 * `signOut({ scope: 'local' })` y no el global (ver `cerrarSesion` en
 * acciones.ts). Pero supabase-js solo borra la sesión local si la
 * llamada a /logout sale bien o responde 401/403/404: con la red caída
 * o un 5xx devuelve el error y deja la cookie `sb-…` viva. Para «Cerrar
 * sesión», y sobre todo para una identidad en conflicto, eso no vale:
 * la persona seguiría con una cookie que ninguna pantalla acepta. Así
 * que después se borran a mano todas las cookies `sb-…` que queden, y
 * la del espacio elegido.
 *
 * Solo se puede llamar desde donde Next deja escribir cookies: una
 * server action o un route handler.
 */
export async function cerrarSesionLocal(): Promise<void> {
  if (isAuthConfigured()) {
    try {
      const supabase = await createServerSupabase();
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) console.error("[auth] Supabase no confirmó el cierre de sesión; se borran las cookies igual", error.message);
    } catch (err) {
      console.error("[auth] no se pudo llamar a Supabase para cerrar la sesión; se borran las cookies igual", err);
    }
  }
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (name.startsWith(PREFIJO_COOKIE_SESION)) store.delete(name);
  }
  await olvidarEspacio();
}
