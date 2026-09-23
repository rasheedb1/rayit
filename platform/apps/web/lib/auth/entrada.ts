import "server-only";
import type { EmailOtpType, SupabaseClient, User } from "@supabase/supabase-js";
import { AuthIdentityMismatchError } from "@mc/db/queries/identidad";
import { elegirWorkspaceId } from "@/lib/workspace/current";
import { espacioDeLaCookie, recordarEspacio } from "@/lib/workspace/elegir";
import { sesionDeUsuario } from "./sesion-base";
import { registrarEntrada } from "./sincronizar";

/**
 * Lo que pasa DESPUÉS de que Supabase abre la sesión, igual para las dos
 * puertas: /auth/callback (el enlace con `?code=`) y /auth/confirm (el
 * enlace con `token_hash`, que se canjea con un clic). Antes vivía en el
 * route handler del callback y la segunda puerta lo habría copiado.
 *
 * Sincronizar es lo que convierte «un correo verificado» en «alguien
 * que puede trabajar»: su fila de app_user (ligada a su cuenta de
 * Auth), sus membresías y, si no tenía ninguna, su primer espacio de
 * creadora con su ficha. Todo dentro de transacciones con identidad
 * (lib/auth/sincronizar.ts); nada pasa por el navegador. Y antes de
 * volver se deja firmada la cookie `mc.workspace`, para que la
 * siguiente petición sirva el espacio en el que se estaba trabajando.
 */

/** Los códigos de error que /login sabe contar (app/login/page.tsx). */
export type CodigoDeEntrada = "enlace" | "otro_navegador" | "cancelado" | "sesion" | "identidad";

/**
 * Los `type` que Supabase pone en un enlace de correo. Lista blanca
 * explícita porque el valor llega de la URL: `verifyOtp` recibe una
 * unión de tipos y un `as EmailOtpType` sobre un parámetro sin validar
 * es exactamente la clase de cosa que se comprueba en `code`, en
 * `error` y en `next`.
 */
const TIPOS_DE_CORREO = ["magiclink", "signup", "email", "recovery", "invite", "email_change"] as const;

export function esTipoDeCorreo(tipo: string | null | undefined): tipo is EmailOtpType {
  return typeof tipo === "string" && (TIPOS_DE_CORREO as readonly string[]).includes(tipo);
}

/**
 * Deja entrar a quien Supabase acaba de autenticar, o cierra la sesión
 * a medias y dice por qué no. `null` es «dentro».
 */
export async function completarEntrada(supabase: SupabaseClient, usuario: User | null): Promise<CodigoDeEntrada | null> {
  // Sin correo verificado no hay identidad (`sesionDeUsuario`). El
  // intercambio YA abrió la sesión, así que se cierra antes de mandar a
  // /login: si no, quedaría una cookie viva que ninguna pantalla acepta.
  const sesion = sesionDeUsuario(usuario);
  if (!sesion) {
    await cerrarAMedias(supabase);
    return enlaceInvalido("usuario sin correo verificado");
  }
  const { email, nombre, authUserId } = sesion;

  try {
    const { userId, workspaces } = await registrarEntrada({ email, nombre, authUserId });
    // Volver a entrar por el enlace mágico no debería devolver a nadie
    // a su espacio más antiguo si estaba trabajando en otro: la regla
    // de preferencia es la misma de cada petición.
    const previo = await espacioDeLaCookie(email);
    const workspaceId = elegirWorkspaceId(previo?.w ?? null, workspaces);
    if (workspaceId) await recordarEspacio({ w: workspaceId, u: userId, e: email });
    return null;
  } catch (err) {
    // La sesión ya está abierta (el intercambio escribió la cookie
    // sb-…), así que hay que cerrarla ANTES de mandar a /login: si no,
    // el middleware ve una sesión viva, redirige a /resumen y la persona
    // se queda dentro, sin espacio y sin ver el error. Este caso no es
    // teórico: es lo que pasa contra una base sin la migración de sesión.
    await cerrarAMedias(supabase);
    if (err instanceof AuthIdentityMismatchError) {
      // Una cuenta de Auth distinta de la que es dueña de la fila de ese
      // correo (buzón reasignado), o esta cuenta con otro correo. No
      // entra. Se registra sin el correo: el id de la fila basta.
      console.error(
        `[auth] identidad en conflicto (${err.motivo}): cuenta de Auth ${authUserId}, app_user ${err.appUserId ?? "desconocido"}`,
      );
      return "identidad";
    }
    console.error("[auth] no se pudo sincronizar la sesión", err);
    return "sesion";
  }
}

/**
 * Un enlace que no abre es lo primero que se pregunta cuando alguien no
 * puede entrar: caducó, ya se usó, se abrió en otro navegador, o la
 * plantilla del correo manda algo que no esperamos. El motivo va al log
 * del servidor —sin el token, que sí es secreto— y a la persona le
 * llega el texto de /login para ese código.
 */
export function enlaceInvalido(motivo: string, codigo: CodigoDeEntrada = "enlace"): CodigoDeEntrada {
  console.warn(`[auth] enlace no válido: ${motivo}`);
  return codigo;
}

/**
 * Cierra la sesión que el intercambio acaba de abrir, SOLO en este
 * navegador (`scope: 'local'`): si la persona tiene otra sesión buena
 * en otro dispositivo, una entrada fallida aquí no tiene por qué
 * tumbarla.
 */
async function cerrarAMedias(supabase: SupabaseClient): Promise<void> {
  await supabase.auth
    .signOut({ scope: "local" })
    .catch((e: unknown) => console.error("[auth] no se pudo cerrar la sesión a medias", e));
}

/**
 * Los `error_code` con los que Supabase dice que el ENLACE no sirve:
 * caducó, ya se usó (también cuando un escáner lo abrió antes), o el
 * flujo PKCE se perdió. Es el fallo más frecuente del enlace mágico, y
 * llega como `?error=access_denied&error_code=otp_expired`: antes todo
 * `?error=` se contaba como «Se canceló la entrada», que es justo el
 * texto equivocado.
 */
const CODIGOS_DE_ENLACE = new Set(["otp_expired", "otp_disabled", "flow_state_expired", "flow_state_not_found"]);

/**
 * Qué decir cuando la URL trae un error, o null si no trae ninguno.
 *
 *   error_code de enlace               → «ese enlace ya no sirve»
 *   access_denied SIN error_code       → «se canceló» (la persona dijo
 *                                         que no en la pantalla del
 *                                         proveedor, p. ej. Google)
 *   cualquier otra cosa                → «ese enlace ya no sirve», que
 *                                         es lo accionable: pedir otro.
 */
export function codigoDeError(params: URLSearchParams): CodigoDeEntrada | null {
  const error = params.get("error");
  const codigo = params.get("error_code");
  if (!error && !codigo) return null;
  if (codigo && CODIGOS_DE_ENLACE.has(codigo)) return enlaceInvalido(`error_code=${codigo}`);
  if (error === "access_denied" && !codigo) {
    console.warn("[auth] entrada cancelada en el proveedor");
    return "cancelado";
  }
  return enlaceInvalido(`error=${error ?? ""} error_code=${codigo ?? ""}`);
}
