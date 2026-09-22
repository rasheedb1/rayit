import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthConfig } from "./config";

/**
 * El cliente de Supabase Auth del SERVIDOR: páginas, server actions y
 * route handlers. La sesión vive en cookies httpOnly que este cliente
 * lee y escribe por `cookies()` de Next.
 *
 * Nunca se usa para leer datos del producto: eso es @mc/db con RLS por
 * workspace. Aquí solo se pregunta quién entró.
 */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const { url, anonKey } = requireAuthConfig();
  const store = await cookies();
  return createServerClient(url, anonKey, {
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
