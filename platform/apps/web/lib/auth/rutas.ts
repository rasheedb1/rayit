/**
 * Qué se puede ver sin sesión. Lo aplica middleware.ts, y está aparte
 * para poder probarlo sin levantar Next.
 *
 * La regla es al revés de lo habitual: TODO pide sesión salvo lo que
 * está en esta lista. Una pantalla nueva nace protegida; abrirla es
 * agregar una línea aquí, con su motivo.
 */

/**
 * Prefijos públicos. Cada uno cubre la ruta exacta y todo lo que cuelga
 * de ella (`/login`, `/login/loquesea`).
 */
export const RUTAS_PUBLICAS = [
  "/login", //            la entrada
  "/auth", //             el callback del enlace mágico y el cierre de sesión
  "/kit", //              la galería del kit: es documentación del equipo, no datos
  "/cotizacion", //       la cotización que se le manda a una marca (COT-3)
  "/baja", //             la baja de una secuencia de outreach: la abre quien la recibe (VEN)
  "/api/webhooks", //     lo llaman las plataformas, no un navegador con sesión
] as const;

/**
 * Archivos y rutas internas de Next que nunca pasan por la sesión.
 * El matcher del middleware ya los descarta; esto es el cinturón.
 */
const INTERNAS = ["/_next", "/favicon.ico", "/robots.txt", "/sitemap.xml", "/opengraph-image", "/icon"];

export function esRutaPublica(pathname: string): boolean {
  const ruta = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const publicas: readonly string[] = RUTAS_PUBLICAS;
  return [...publicas, ...INTERNAS].some((p) => ruta === p || ruta.startsWith(`${p}/`));
}

/**
 * A dónde volver después de entrar. Solo se acepta una ruta de ESTA
 * aplicación: un `next=https://otra-cosa` convertiría el login en un
 * redirector abierto, que es la forma más barata de hacer phishing con
 * un dominio legítimo. `//evil.com` y `/\evil.com` también son
 * absolutas para el navegador, así que se descartan igual.
 */
export function destinoSeguro(next: string | null | undefined, porDefecto = "/resumen"): string {
  if (!next) return porDefecto;
  if (!next.startsWith("/")) return porDefecto;
  if (next.startsWith("//") || next.startsWith("/\\")) return porDefecto;
  if (esRutaPublica(next)) return porDefecto;
  return next;
}
