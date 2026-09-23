import "server-only";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";

/**
 * «Este navegador pidió un enlace para ESTE correo», para frenar el
 * login CSRF del enlace mágico.
 *
 * El ataque: alguien pide un enlace para SU propio correo y le manda a
 * la víctima la URL de /auth/confirm con su token_hash. La víctima pulsa
 * «Entrar a On Cue» y queda dentro de la cuenta del atacante, y todo lo
 * que registre después (tarifas, facturas, contactos de marcas) acaba en
 * el espacio del atacante. El enlace con `?code=` (PKCE) no tiene este
 * problema —el verificador vive en el navegador que lo pidió—, pero el
 * de `token_hash` sirve en cualquier navegador, que es justo para lo que
 * se eligió (README, «Autenticación»).
 *
 * La defensa: /login deja aquí una cookie con la huella del correo
 * pedido; /auth/confirm, tras canjear, mira si la sesión nueva es de ese
 * correo. Si lo es, entra directo. Si no —otro dispositivo, otro
 * navegador, o un enlace que no pidió—, pasa por /auth/comprobar, que
 * dice «Entraste como x@y» con «No soy yo, cerrar sesión». Es un clic de
 * más solo en el caso raro, y además el correo de la sesión se ve
 * siempre en el menú del selector de espacio.
 *
 * La cookie guarda un SHA-256 del correo en minúsculas, no el correo:
 * no hace falta leerlo, solo compararlo. Dura lo que dura el enlace (una
 * hora) y se borra al canjear.
 */
export const COOKIE_PEDIDO = "mc.enlace";

/** Lo que dura el enlace del correo en Supabase (MESSAGES.login.enviado: «caduca en una hora»). */
const DURACION_S = 60 * 60;

export function huellaDeCorreo(correo: string): string {
  return createHash("sha256").update(correo.trim().toLowerCase()).digest("base64url");
}

/** Tras mandar el enlace: este navegador lo pidió para este correo. */
export async function marcarPedido(correo: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_PEDIDO, huellaDeCorreo(correo), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DURACION_S,
  });
}

/**
 * ¿Pidió ESTE navegador un enlace para este correo? Se consume: después
 * de mirarla, la cookie se borra, así que sirve para un canje y nada más.
 */
export async function consumirPedido(correo: string): Promise<boolean> {
  const store = await cookies();
  const valor = store.get(COOKIE_PEDIDO)?.value;
  if (valor !== undefined) store.delete(COOKIE_PEDIDO);
  return valor === huellaDeCorreo(correo);
}
