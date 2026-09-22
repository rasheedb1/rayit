import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthConfig } from "./config";
import { COOKIE_SESION } from "./cookies";

/**
 * El cliente de Supabase Auth del SERVIDOR: páginas, server actions y
 * route handlers. La sesión vive en cookies que este cliente lee y
 * escribe por `cookies()` de Next.
 *
 * `cookieOptions` no es decorativo: sin él, @supabase/ssr escribe
 * `sb-…-auth-token` con los valores por defecto de la librería, que no
 * llevan httpOnly ni Secure, y dentro de esa cookie viajan el access
 * token y el refresh token (ver lib/auth/cookies.ts). Ponerla httpOnly
 * no rompe nada aquí porque no hay cliente de Supabase en el navegador:
 * todo el flujo de sesión se resuelve en el servidor. El día que se
 * añada uno, esto hay que revisarlo junto con él.
 *
 * Nunca se usa para leer datos del producto: eso es @mc/db con RLS por
 * workspace. Aquí solo se pregunta quién entró.
 */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const { url, anonKey } = requireAuthConfig();
  const store = await cookies();
  return createServerClient(url, anonKey, {
    cookieOptions: COOKIE_SESION,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (nuevas) => {
        try {
          for (const { name, value, options } of nuevas) store.set(name, value, options);
        } catch {
          // Un Server Component no puede escribir cookies. No es un
          // error: el middleware ya refrescó la sesión en esta misma
          // petición y dejó las cookies al día.
        }
      },
    },
  });
}
