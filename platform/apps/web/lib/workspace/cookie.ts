/**
 * La cookie `mc.workspace`: en cuál de mis espacios estoy trabajando.
 *
 * No guarda ningún secreto —el id de un workspace no abre nada por sí
 * solo— pero tiene que ser INFALSIFICABLE: si se pudiera editar a mano,
 * cambiar un uuid en el navegador sería pedirle a la base los datos de
 * otro cliente. Por eso va firmada (HMAC-SHA256) con el mismo sello que
 * usa la cookie de OAuth, derivado de TOKEN_ENCRYPTION_KEY con una
 * etiqueta propia: la misma clave maestra no firma dos cosas distintas.
 *
 * Y aun firmada NO basta: `lib/workspace/current.ts` comprueba SIEMPRE
 * la membresía contra la base antes de servir nada. La firma evita que
 * la cookie mienta; la membresía es lo que decide. Una persona a la que
 * le quitaron el acceso deja de verlo en la siguiente petición, no
 * cuando caduque su cookie.
 *
 * El correo va dentro para atar la cookie a la sesión: cerrar sesión y
 * entrar con otra cuenta en el mismo navegador no hereda el espacio de
 * la anterior.
 *
 * Sin TOKEN_ENCRYPTION_KEY (una máquina sin `make db.unlock`) no se
 * firma ni se abre nada: se devuelve null, la web sirve el primer
 * espacio de la persona y el selector lo dice. No se inventa una clave
 * por defecto, que sería una firma que cualquiera puede reproducir.
 */
import { currentMasterKey, deriveKey, keyringFromEnv, openSealedValue, sealValue } from "@mc/connectors";

export const COOKIE_WORKSPACE = "mc.workspace";

/** Un mes. Es una preferencia de navegación, no la sesión: esa la maneja Supabase. */
export const COOKIE_WORKSPACE_MAX_AGE_S = 30 * 24 * 60 * 60;

const SELLO_INFO = "on-cue/workspace-cookie/v1";

export interface EspacioElegido {
  /** Workspace actual. */
  w: string;
  /** Fila de app_user de quien lo eligió. */
  u: string;
  /** Correo de la sesión que lo eligió. */
  e: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** La clave del sello, o null si la máquina no tiene la clave maestra. */
function sello(env: Env): Uint8Array | null {
  try {
    return deriveKey(currentMasterKey(keyringFromEnv(env)), SELLO_INFO);
  } catch {
    return null;
  }
}

/** ¿Se puede firmar la cookie en esta máquina? */
export function puedeFirmar(env: Env = process.env): boolean {
  return sello(env) !== null;
}

/** El valor firmado de la cookie, o null si no hay clave con la que firmar. */
export function sellarEspacio(elegido: EspacioElegido, env: Env = process.env, ahora: Date = new Date()): string | null {
  const key = sello(env);
  if (!key) return null;
  return sealValue(elegido, key, ahora);
}

/**
 * Abre la cookie: firma válida, dentro de plazo y del correo que tiene
 * la sesión ahora. Cualquier otra cosa es null, y quien llama vuelve a
 * elegir espacio desde la base.
 */
export function abrirEspacio(
  valor: string | undefined | null,
  correoDeLaSesion: string,
  env: Env = process.env,
  ahora: Date = new Date(),
): EspacioElegido | null {
  const key = sello(env);
  if (!key || !valor) return null;
  const abierto = openSealedValue<EspacioElegido>(valor, key, ahora, COOKIE_WORKSPACE_MAX_AGE_S * 1000);
  if (!abierto.ok) return null;
  const { w, u, e } = abierto.payload ?? {};
  if (typeof w !== "string" || typeof u !== "string" || typeof e !== "string") return null;
  if (e.toLowerCase() !== correoDeLaSesion.trim().toLowerCase()) return null;
  return { w, u, e };
}
