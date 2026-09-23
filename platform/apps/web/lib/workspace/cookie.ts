/**
 * La cookie `mc.workspace`: en cuál de mis espacios estoy trabajando.
 *
 * ESTA COOKIE NO DA PERMISO: es una PREFERENCIA. Dice «de mis
 * espacios, estaba trabajando en este». Quién eres lo decide siempre el
 * correo verificado de la sesión de Supabase, y a qué espacios
 * perteneces lo decide la base bajo RLS; `lib/workspace/current.ts`
 * resuelve las dos cosas sin mirar la cookie y solo después comprueba
 * si el espacio que la cookie pide está en esa lista. Si no está, se
 * ignora. Por eso una cookie falsificada no sirve para entrar en el
 * espacio de nadie: lo más que se puede pedir con ella es uno de los
 * que ya son tuyos.
 *
 * (Hasta la ronda 2 no era así: el id de app_user salía de la propia
 * cookie y la comprobación de membresía corría con ESE id, de modo que
 * siempre decía que sí. Toda la frontera entre inquilinos colgaba de
 * este HMAC. Si algún día alguien vuelve a leer `u` como identidad,
 * vuelve el agujero.)
 *
 * Aun así va firmada (HMAC-SHA256) con el mismo sello que usa la cookie
 * de OAuth, derivado de TOKEN_ENCRYPTION_KEY con una etiqueta propia:
 * la misma clave maestra no firma dos cosas distintas. La firma es lo
 * que evita que un valor cualquiera del navegador se cuele como
 * preferencia y, con el correo dentro, ata la cookie a la sesión:
 * cerrar sesión y entrar con otra cuenta en el mismo navegador no
 * hereda el espacio de la anterior.
 *
 * Sin TOKEN_ENCRYPTION_KEY (una máquina sin `make db.unlock`) no se
 * firma ni se abre nada: se devuelve null, la web sirve el primer
 * espacio de la persona y el selector lo dice. No se inventa una clave
 * por defecto, que sería una firma que cualquiera puede reproducir.
 */
import { currentMasterKey, deriveKey, keyringFromEnv, openSealedValue, sealValue } from "@mc/connectors";
import type { Env } from "@/lib/auth/config";

export const COOKIE_WORKSPACE = "mc.workspace";

/** Un mes. Es una preferencia de navegación, no la sesión: esa la maneja Supabase. */
export const COOKIE_WORKSPACE_MAX_AGE_S = 30 * 24 * 60 * 60;

const SELLO_INFO = "on-cue/workspace-cookie/v1";

export interface EspacioElegido {
  /** Workspace actual: lo único que se usa, y solo si está entre los míos. */
  w: string;
  /**
   * Fila de app_user de quien lo eligió. Se guarda para poder depurar y
   * para que la cookie siga siendo legible por quien la escribió; NO se
   * usa como identidad en ninguna parte (ver arriba).
   */
  u: string;
  /** Correo de la sesión que lo eligió. */
  e: string;
}

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
