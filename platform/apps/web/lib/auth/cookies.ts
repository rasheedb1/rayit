/**
 * Cómo se escribe la cookie de sesión de Supabase.
 *
 * @supabase/ssr la escribe con los valores por defecto de la librería
 * si no se le dice otra cosa: sin httpOnly y sin Secure. Medido contra
 * el build de producción salía
 * `sb-<ref>-auth-token=…; Path=/; Max-Age=34560000; SameSite=lax`, y
 * dentro de ese valor van el access token Y el refresh token. Sin
 * httpOnly, cualquier XSS se lleva una sesión de 400 días leyendo
 * `document.cookie`; sin Secure, viaja en claro si algo cae a http.
 *
 * Va aparte, en un módulo sin dependencias, porque los DOS clientes que
 * abren sesión —lib/auth/supabase.ts (páginas, acciones y el callback)
 * y middleware.ts (runtime Edge)— tienen que escribirla igual: si uno
 * pusiera httpOnly y el otro no, el refresco del middleware reescribiría
 * la cookie con los permisos flojos.
 *
 * `sameSite: "lax"` es el valor que hace falta para que el enlace del
 * correo —una navegación de arriba a /auth/callback desde el dominio de
 * Supabase— llegue con la cookie del verificador PKCE.
 */
import type { CookieOptions } from "@supabase/ssr";

export const COOKIE_SESION: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
};

/** El prefijo de las cookies de Supabase Auth: `sb-<ref>-auth-token`. */
export const PREFIJO_COOKIE_SESION = "sb-";

/** ¿Trae esta petición alguna cookie de sesión de Supabase? */
export function hayCookieDeSesion(cookies: readonly { name: string }[]): boolean {
  return cookies.some((c) => c.name.startsWith(PREFIJO_COOKIE_SESION));
}
