import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { isAuthConfigured } from "@/lib/auth/config";
import { destinoSeguro } from "@/lib/auth/rutas";
import { sincronizarSesion } from "@/lib/auth/sincronizar";
import { createServerSupabase } from "@/lib/auth/supabase";
import { recordarEspacio } from "@/lib/workspace/elegir";

/**
 * Donde aterriza el enlace del correo.
 *
 * Dos formas, porque Supabase manda una u otra según la plantilla del
 * correo: `?code=` (PKCE, la de por defecto desde @supabase/ssr) y
 * `?token_hash=&type=`. Las dos terminan igual: sesión abierta en
 * cookies httpOnly y persona sincronizada.
 *
 * Sincronizar es lo que convierte «un correo verificado» en «alguien
 * que puede trabajar»: su fila de app_user, sus membresías y, si no
 * tenía ninguna, su primer espacio de creadora con su ficha. Todo
 * dentro de transacciones con identidad (ver lib/auth/sincronizar.ts);
 * nada de esto pasa por el navegador.
 *
 * Y antes de redirigir se deja firmada la cookie `mc.workspace`, para
 * que la siguiente petición no tenga que volver a preguntarle a la base
 * a qué espacios pertenece.
 *
 * Los errores van a /login?error=… con un código corto: lo que dice el
 * proveedor no se enseña ni se registra tal cual.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const destino = destinoSeguro(url.searchParams.get("next"));
  const alLogin = (error?: string) =>
    NextResponse.redirect(new URL(`/login${error ? `?error=${error}` : ""}`, url.origin));

  if (!isAuthConfigured()) return alLogin();
  // La persona canceló en la pantalla del proveedor, o el enlace ya se usó.
  if (url.searchParams.get("error")) return alLogin("cancelado");

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const tipo = url.searchParams.get("type");

  const supabase = await createServerSupabase();
  let email: string | null = null;
  let nombre: string | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user?.email) return enlaceInvalido(alLogin, error?.message);
    email = data.user.email;
    nombre = nombreDe(data.user.user_metadata);
  } else if (tokenHash && tipo) {
    const { data, error } = await supabase.auth.verifyOtp({ type: tipo as EmailOtpType, token_hash: tokenHash });
    if (error || !data.user?.email) return enlaceInvalido(alLogin, error?.message);
    email = data.user.email;
    nombre = nombreDe(data.user.user_metadata);
  } else {
    return enlaceInvalido(alLogin, "la URL no trae ni code ni token_hash");
  }

  try {
    const { userId, workspaces } = await sincronizarSesion({ email, nombre });
    await recordarEspacio({ w: workspaces[0]!.id, u: userId, e: email });
  } catch (err) {
    console.error("[auth] no se pudo sincronizar la sesión", err);
    return alLogin("sesion");
  }

  return NextResponse.redirect(new URL(destino, url.origin));
}

/**
 * Un enlace que no abre es lo primero que se pregunta cuando alguien no
 * puede entrar: caducó, ya se usó, o la plantilla del correo manda algo
 * que no esperamos. El motivo va al log del servidor —sin el token, que
 * sí es secreto— y a la persona le llega el texto de siempre.
 */
function enlaceInvalido(alLogin: (error?: string) => Response, motivo?: string): Response {
  console.warn(`[auth] enlace no válido: ${motivo ?? "sin detalle"}`);
  return alLogin("enlace");
}

function nombreDe(meta: unknown): string | null {
  const m = meta as { name?: unknown; full_name?: unknown } | null;
  const valor = [m?.full_name, m?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
  return valor?.trim() ?? null;
}
