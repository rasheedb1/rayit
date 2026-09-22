import "server-only";
import { cookies } from "next/headers";
import { abrirEspacio, COOKIE_WORKSPACE, COOKIE_WORKSPACE_MAX_AGE_S, sellarEspacio, type EspacioElegido } from "./cookie";

/**
 * Escribir y borrar la cookie del espacio elegido. Aparte de cookie.ts
 * —que solo firma y abre, sin saber de Next— para que esa parte se
 * pueda probar sin una petición de por medio.
 *
 * Solo se puede llamar desde donde Next permite escribir cookies: un
 * route handler o una server action. Desde una página (Server
 * Component) no; por eso lib/workspace/current.ts sabe resolver el
 * espacio sin cookie, y la cookie es un atajo, no la fuente de verdad.
 */

/** Deja firmado el espacio elegido. Si la máquina no tiene clave de firma, no escribe nada. */
export async function recordarEspacio(elegido: EspacioElegido): Promise<boolean> {
  const valor = sellarEspacio(elegido);
  if (!valor) return false;
  const store = await cookies();
  store.set(COOKIE_WORKSPACE, valor, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_WORKSPACE_MAX_AGE_S,
  });
  return true;
}

/** Al cerrar sesión: el espacio elegido se va con ella. */
export async function olvidarEspacio(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_WORKSPACE);
}

/** El espacio que dice la cookie, si su firma vale y es de este correo. */
export async function espacioDeLaCookie(correo: string): Promise<EspacioElegido | null> {
  const store = await cookies();
  return abrirEspacio(store.get(COOKIE_WORKSPACE)?.value, correo);
}
