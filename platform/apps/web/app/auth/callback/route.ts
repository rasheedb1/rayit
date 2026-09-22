import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { isAuthConfigured } from "@/lib/auth/config";
import { destinoSeguro } from "@/lib/auth/rutas";
import { nombreDeMetadata } from "@/lib/auth/session";
import { registrarEntrada } from "@/lib/auth/sincronizar";
import { createServerSupabase } from "@/lib/auth/supabase";
import { elegirWorkspaceId } from "@/lib/workspace/current";
import { espacioDeLaCookie, recordarEspacio } from "@/lib/workspace/elegir";

/**
 * Donde aterriza el enlace del correo.
 *
 * Dos formas, porque Supabase manda una u otra según la plantilla del
 * correo: `?code=` (PKCE, la de por defecto desde @supabase/ssr) y
 * `?token_hash=&type=`. Las dos terminan igual: sesión abierta en
 * cookies httpOnly (lib/auth/cookies.ts) y persona sincronizada.
 *
 * Sincronizar es lo que convierte «un correo verificado» en «alguien
 * que puede trabajar»: su fila de app_user, sus membresías y, si no
 * tenía ninguna, su primer espacio de creadora con su ficha. Todo
 * dentro de transacciones con identidad (ver lib/auth/sincronizar.ts);
 * nada de esto pasa por el navegador. Este es además el ÚNICO sitio del
 * camino normal que escribe: las pantallas solo leen.
 *
 * Y antes de redirigir se deja firmada la cookie `mc.workspace`, para
 * que la siguiente petición sirva el espacio en el que se estaba
 * trabajando y no el más antiguo.
 *
 * Los errores van a /login?error=… con un código corto: lo que dice el
 * proveedor no se enseña ni se registra tal cual.
 */

/**
 * Los `type` que Supabase pone en un enlace de correo. Lista blanca
 * explícita porque el valor llega de la URL: `verifyOtp` recibe una
 * unión de tipos y un `as EmailOtpType` sobre un parámetro sin validar
 * es exactamente la clase de cosa que este archivo comprueba en `code`,
 * en `error` y en `next`.
 */
const TIPOS = ["magiclink", "signup", "email", "recovery", "invite", "email_change"] as const;

function esTipoDeCorreo(tipo: string | null): tipo is EmailOtpType {
  return tipo !== null && (TIPOS as readonly string[]).includes(tipo);
}

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
    nombre = nombreDeMetadata(data.user.user_metadata);
  } else if (tokenHash && tipo) {
    if (!esTipoDeCorreo(tipo)) return enlaceInvalido(alLogin, "type desconocido");
    const { data, error } = await supabase.auth.verifyOtp({ type: tipo, token_hash: tokenHash });
    if (error || !data.user?.email) return enlaceInvalido(alLogin, error?.message);
    email = data.user.email;
    nombre = nombreDeMetadata(data.user.user_metadata);
  } else {
    return enlaceInvalido(alLogin, "la URL no trae ni code ni token_hash");
  }

  try {
    const { userId, workspaces } = await registrarEntrada({ email, nombre });
    // Volver a entrar por el enlace mágico no debería devolver a nadie
    // a su espacio más antiguo si estaba trabajando en otro: la regla
    // de preferencia es la misma de cada petición.
    const previo = await espacioDeLaCookie(email);
    const workspaceId = elegirWorkspaceId(previo?.w ?? null, workspaces);
    if (workspaceId) await recordarEspacio({ w: workspaceId, u: userId, e: email });
  } catch (err) {
    console.error("[auth] no se pudo sincronizar la sesión", err);
    // La sesión ya está abierta (el intercambio de arriba escribió la
    // cookie sb-…), así que hay que cerrarla ANTES de mandar a /login:
    // si no, /login ve una sesión viva, redirige a /resumen y la
    // persona se queda dentro, sin espacio y sin ver el error. Este
    // caso no es teórico: es lo que pasa contra una base sin la
    // migración 0022.
    await supabase.auth.signOut().catch((e: unknown) => console.error("[auth] no se pudo cerrar la sesión a medias", e));
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
