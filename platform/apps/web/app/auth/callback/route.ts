import { NextResponse } from "next/server";
import { isAuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { isAuthConfigured } from "@/lib/auth/config";
import { codigoDeError, completarEntrada, enlaceInvalido, type CodigoDeEntrada } from "@/lib/auth/entrada";
import { destinoSeguro } from "@/lib/auth/rutas";
import { createServerSupabase } from "@/lib/auth/supabase";

/**
 * Donde aterriza el enlace del correo.
 *
 * Tres formas de llegar, según la plantilla del correo y lo que pasó
 * por el camino:
 *
 *   ?code=              PKCE, la plantilla por defecto de Supabase. Se
 *                       canjea aquí mismo: un escáner de enlaces no
 *                       tiene la cookie del verificador, así que su GET
 *                       no gasta nada (supabase-js ni llega a llamar).
 *   ?token_hash=&type=  la plantilla que recomienda el README. NO se
 *                       canjea aquí (ronda 4): un GET de un solo uso lo
 *                       gastan los escáneres del correo corporativo
 *                       (Outlook Safe Links, Mimecast) antes que la
 *                       persona. Se reenvía a /auth/confirm, que pide un
 *                       clic y canjea por POST.
 *   ?error=&error_code= Supabase no pudo verificar el enlace y lo dice
 *                       en la URL (lib/auth/entrada.ts, `codigoDeError`).
 *
 * Lo que pasa después de abrir la sesión —sincronizar la persona y su
 * espacio— está en lib/auth/entrada.ts, compartido con /auth/confirm.
 * Los errores van a /login?error=… con un código corto: lo que dice el
 * proveedor no se enseña ni se registra tal cual.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const destino = destinoSeguro(url.searchParams.get("next"));
  const alLogin = (error?: CodigoDeEntrada) =>
    NextResponse.redirect(new URL(`/login${error ? `?error=${error}` : ""}`, url.origin));

  if (!isAuthConfigured()) return alLogin();

  const errorDeUrl = codigoDeError(url.searchParams);
  if (errorDeUrl) return alLogin(errorDeUrl);

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");

  if (!code && tokenHash) {
    // A la página del clic, con los mismos parámetros (y `next` ya
    // saneado). 303: lo que sigue es un GET que no canjea nada.
    const confirmar = new URL("/auth/confirm", url.origin);
    confirmar.searchParams.set("token_hash", tokenHash);
    confirmar.searchParams.set("type", url.searchParams.get("type") ?? "");
    confirmar.searchParams.set("next", destino);
    return NextResponse.redirect(confirmar, 303);
  }

  if (!code) return alLogin(enlaceInvalido("la URL no trae ni code ni token_hash"));

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  // El enlace se pidió en OTRO navegador (el portátil, y se abre en el
  // teléfono o en el navegador interno de Gmail): el verificador PKCE
  // vive en una cookie del navegador donde se pidió y aquí no está.
  // Decir «ese enlace ya no sirve» era falso —pedir otro y abrirlo en
  // el mismo sitio vuelve a fallar—, así que tiene su propio texto. La
  // cura de fondo es la plantilla del correo con token_hash (README,
  // «Autenticación»), que no depende del navegador.
  if (error && isAuthPKCECodeVerifierMissingError(error)) {
    return alLogin(enlaceInvalido(error.message, "otro_navegador"));
  }
  if (error) return alLogin(enlaceInvalido(error.message));

  const fallo = await completarEntrada(supabase, data.user);
  return fallo ? alLogin(fallo) : NextResponse.redirect(new URL(destino, url.origin));
}
