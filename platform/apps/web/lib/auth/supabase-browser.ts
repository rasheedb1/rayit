import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthConfig } from "./config";

/**
 * El cliente de Supabase del NAVEGADOR. Existe porque la historia lo
 * pide junto al de servidor, y HOY NO LO USA NINGUNA PANTALLA, a
 * propósito:
 *
 *   - la sesión vive en cookies httpOnly (lib/auth/cookies.ts), así que
 *     este cliente NO la ve: `getUser()` desde aquí devuelve «no hay
 *     sesión» aunque la haya. Es lo que queremos: el access token y el
 *     refresh token no están al alcance de ningún script de la página;
 *   - todo el flujo de entrada (pedir el enlace, canjearlo, cerrar
 *     sesión) corre en el servidor, y los datos del producto se leen con
 *     @mc/db y RLS por workspace, nunca con la API REST de Supabase.
 *
 * Sirve, tal cual, para lo que no necesita sesión (un canal de Realtime
 * público, por ejemplo). El día que una pantalla necesite la sesión en
 * el navegador, hay que decidir con él si la cookie deja de ser
 * httpOnly —y qué se pierde con eso—; no basta con importarlo.
 *
 * Las dos variables se leen con acceso estático (config.ts) para que
 * Next las sustituya en el bundle del navegador.
 */
export function createBrowserSupabase(): SupabaseClient {
  const { url, anonKey } = requireAuthConfig();
  return createBrowserClient(url, anonKey);
}
