import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { isAuthConfigured } from "./config";
import { hayCookieDeSesion } from "./cookies";
import { CABECERA_SESION, leerCabeceraSesion, SESION_NO_VERIFICADA, type Sesion } from "./sesion-base";

export type { Sesion } from "./sesion-base";

/**
 * Quién entró en ESTA petición.
 *
 * Ronda 4: ya no pregunta a Supabase. Lo hace el middleware, que tiene
 * que llamar a `getUser()` de todos modos para refrescar la sesión, y
 * deja el resultado verificado en una cabecera interna que él mismo
 * borra de lo que manda el navegador (lib/auth/sesion-base.ts explica
 * por qué eso es seguro). Una navegación con sesión pasa de dos idas y
 * vueltas a Supabase Auth a una.
 *
 * `getUser()` y no `getSession()` sigue siendo la regla: el middleware
 * pregunta al servidor de Supabase, no se cree la cookie.
 *
 * Tres salidas, y la diferencia importa:
 *
 *   Sesion   hay usuario y su correo está VERIFICADO.
 *   null     no hay sesión, caducó, el correo no está verificado, o la
 *            petición no pasó por el middleware (no hay cabecera): se
 *            falla cerrado.
 *   lanza    Supabase no pudo contestar (red, 5xx, 429). No es lo mismo
 *            que no tener sesión: lo recoge el error.tsx del segmento,
 *            con su «Reintentar». El middleware, en ese caso, deja pasar
 *            la petición en vez de mandarla a /login.
 *
 * Además exige que siga habiendo cookie de sesión. La cabecera describe
 * la petición tal como llegó; si una server action cierra la sesión y
 * redirige, Next pinta el destino en la MISMA petición, con la cabecera
 * de antes y la cookie ya borrada. Sin esta comprobación, «Cerrar
 * sesión» acababa pintando la aplicación otra vez.
 *
 * `cache` de React lo memoriza por petición: la pantalla, el marco y el
 * selector de espacio preguntan una vez entre los tres.
 */
export const getSesion = cache(async (): Promise<Sesion | null> => {
  if (!isAuthConfigured()) return null;
  const [cabeceras, store] = await Promise.all([headers(), cookies()]);
  if (!hayCookieDeSesion(store.getAll())) return null;
  const leida = leerCabeceraSesion(cabeceras.get(CABECERA_SESION));
  if (leida === SESION_NO_VERIFICADA) {
    throw new Error("No pudimos comprobar la sesión con Supabase Auth: el servicio no respondió.");
  }
  return leida;
});
