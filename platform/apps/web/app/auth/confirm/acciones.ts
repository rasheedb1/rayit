"use server";

import { redirect } from "next/navigation";
import { isAuthConfigured } from "@/lib/auth/config";
import { completarEntrada, enlaceInvalido, esTipoDeCorreo } from "@/lib/auth/entrada";
import { destinoSeguro } from "@/lib/auth/rutas";
import { createServerSupabase } from "@/lib/auth/supabase";

/**
 * El clic de /auth/confirm: canjea el `token_hash` del correo por una
 * sesión, por POST.
 *
 * Por qué por POST y no al cargar la página: el token es de un solo
 * uso, y los escáneres de enlaces del correo corporativo (Outlook Safe
 * Links, Mimecast, habituales en agencias) abren con un GET todo enlace
 * que llega, antes que la persona. Un GET que canjeaba el token lo
 * gastaba, y la persona veía «Ese enlace ya no sirve» sin haberlo
 * tocado. Un escáner no envía formularios. Es lo que recomienda
 * Supabase para enlaces de un solo uso.
 *
 * Todo lo que llega del formulario se vuelve a comprobar aquí: el tipo
 * contra la lista blanca y el destino con destinoSeguro.
 *
 * "use server": solo exporta funciones async (ver app/login/acciones.ts).
 */
export async function confirmarEntrada(formData: FormData): Promise<void> {
  const tokenHash = String(formData.get("token_hash") ?? "").trim();
  const tipo = String(formData.get("type") ?? "");
  const destino = destinoSeguro(String(formData.get("next") ?? ""));

  if (!isAuthConfigured()) redirect("/login");
  if (!tokenHash || !esTipoDeCorreo(tipo)) {
    redirect(`/login?error=${enlaceInvalido("token_hash o type ausentes o desconocidos")}`);
  }

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash });
  if (error) redirect(`/login?error=${enlaceInvalido(error.message)}`);

  const fallo = await completarEntrada(supabase, data.user);
  redirect(fallo ? `/login?error=${fallo}` : destino);
}
