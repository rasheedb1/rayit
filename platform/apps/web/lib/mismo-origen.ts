import "server-only";
import type { Env } from "./auth/config";
import { OrigenNoConfiguradoError, origenDesde } from "./auth/origen";

/**
 * ¿El POST sale de una página de esta misma aplicación? La única regla
 * de mismo origen para los route handlers que reciben un POST del
 * navegador con la sesión puesta (RES-6, VEN-9): la importación por CSV
 * de Resumen y los inicios de conexión de canales de Ventas.
 *
 * Las server actions las protege Next solo; un route handler no, y un
 * formulario de otro sitio es una petición «simple» que el navegador
 * manda sin preguntar. La cookie de sesión ya es SameSite=Lax (no viaja
 * en un POST de otro sitio), y en modo demo (DEMO_WORKSPACE_ID, sin
 * sesión) ni siquiera hay cookie que la frene: esta es la segunda puerta.
 *
 * La regla:
 *
 *   1. Si el navegador marca la petición (Sec-Fetch-Site) y no es
 *      `same-origin`, se rechaza. `same-site` también: un subdominio
 *      hermano no es esta aplicación.
 *   2. Si trae Origin, tiene que ser el de la propia petición o el
 *      público de la app (lib/auth/origen: APP_URL en producción, que es
 *      el que vale detrás de un proxy). `Origin: null` (un iframe con
 *      sandbox, un documento file://) no coincide con ninguno.
 *   3. Sin ninguna de las dos cabeceras, se acepta: no es un navegador
 *      (todos los actuales mandan Origin en un POST), y quien no es un
 *      navegador no lleva la cookie de nadie, así que no hay petición
 *      falsificada posible.
 *
 * `publicOrigin` se pide solo si hace falta (el Origin no es el de la
 * propia petición), porque resolverlo puede avisar al registro.
 */
export async function isSameOriginPost(
  req: Request,
  publicOrigin: () => Promise<string | null> | string | null,
): Promise<boolean> {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  if (origin === new URL(req.url).origin) return true;
  // Sin origen público configurado (producción sin APP_URL) solo vale el de la propia petición.
  const allowed = await publicOrigin();
  return allowed !== null && origin === allowed;
}

/**
 * El origen público de la app para `isSameOriginPost`, o null si
 * producción no lo tiene configurado (OrigenNoConfiguradoError): sin él
 * solo vale el origen de la propia petición, que es lo más estricto.
 */
export function publicOriginOrNull(req: Request, env: Env = process.env): string | null {
  try {
    return origenDesde(env, req.headers);
  } catch (err) {
    if (err instanceof OrigenNoConfiguradoError) return null;
    throw err;
  }
}
