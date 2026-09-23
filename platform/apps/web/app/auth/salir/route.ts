import { NextResponse } from "next/server";
import { AuthIdentityMismatchError } from "@mc/db/queries/identidad";
import { cerrarSesionLocal } from "@/lib/auth/salir";
import { getSesion } from "@/lib/auth/session";
import { leerOCrearSesion } from "@/lib/auth/sincronizar";

/**
 * Salida de una sesión con la identidad en conflicto.
 *
 * Una sesión que ya existía puede caer en conflicto de identidad (otra
 * cuenta de Auth con el correo de alguien: un buzón reasignado).
 * lib/workspace/current.ts lo detecta en una página, pero un Server
 * Component no puede escribir cookies, así que antes redirigía a
 * /login?error=identidad con la cookie `sb-…` viva: cualquier URL de la
 * aplicación devolvía al mismo error y en /login no había «Cerrar
 * sesión» a la vista. Ahora redirige AQUÍ, un route handler, que sí
 * puede cerrarla (lib/auth/salir.ts) y después manda a /login con el
 * texto de siempre.
 *
 * Es un GET y cuelga de /auth, que es público: cualquiera puede enlazar
 * esta URL. Por eso no cierra nada porque se lo pidan: vuelve a
 * preguntar a la base y SOLO si la base confirma el conflicto cierra la
 * sesión. A una sesión buena la devuelve a la aplicación intacta (un
 * enlace desde otro sitio no puede echar a nadie), y sin sesión no hay
 * nada que cerrar.
 */
export async function GET(request: Request) {
  const origen = new URL(request.url).origin;
  const ir = (ruta: string) => NextResponse.redirect(new URL(ruta, origen), 303);

  let sesion: Awaited<ReturnType<typeof getSesion>>;
  try {
    sesion = await getSesion();
  } catch {
    // Supabase no contestó: no sabemos quién es. La aplicación lo cuenta
    // con su error.tsx y «Reintentar»; aquí no se cierra nada a ciegas.
    return ir("/resumen");
  }
  if (!sesion) return ir("/login");

  try {
    // La MISMA comprobación que getCurrentContext, no una más ligera: si
    // esta dijera «todo bien» donde aquella dice «conflicto», las dos se
    // mandarían la una a la otra sin fin (p. ej. `otro_correo`, que solo
    // aparece al dar de alta).
    await leerOCrearSesion({ email: sesion.email, authUserId: sesion.authUserId, nombre: sesion.nombre });
  } catch (err) {
    if (!(err instanceof AuthIdentityMismatchError)) throw err;
    console.error(`[auth] identidad en conflicto (${err.motivo}): se cierra la sesión de la cuenta de Auth ${sesion.authUserId}`);
    await cerrarSesionLocal();
    return ir("/login?error=identidad");
  }
  return ir("/resumen");
}
