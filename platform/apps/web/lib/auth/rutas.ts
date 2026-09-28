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
  "/auth", //             el callback del enlace mágico, /auth/confirm (el clic que lo canjea), /auth/comprobar y /auth/salir
  "/legal", //            términos y privacidad: se leen ANTES de dejar el correo
  "/kit", //              la galería del kit: es documentación del equipo, no datos
  "/cotizacion", //       la cotización que se le manda a una marca (COT-3)
  "/reporte", //          el reporte de campaña que abre la marca (CAM-6)
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

/** Origen ficticio contra el que se resuelve `next`: si el resultado sale de él, `next` no era una ruta nuestra. */
const ORIGEN_PROPIO = "http://on-cue.invalid";

/**
 * Cualquier carácter de control (el tabulador y el salto de línea
 * incluidos), cualquier espacio —también los de Unicode— y la barra
 * invertida. Ver `destinoSeguro`.
 */
const CARACTERES_PROHIBIDOS = /[\u0000-\u001F\u007F\s\\]/u;

/**
 * A dónde volver después de entrar. Solo se acepta una ruta de ESTA
 * aplicación: un `next=https://otra-cosa` convertiría el login en un
 * redirector abierto, que es la forma más barata de hacer phishing con
 * un dominio legítimo.
 *
 * Dos barreras, porque mirar el principio de la cadena no basta
 * (ronda 3): el parser de URL del navegador y el de Node QUITAN el
 * tabulador y el salto de línea antes de interpretar, así que
 * `/\t/evil.com` pasaba el «no empieza por //» y acababa siendo
 * `//evil.com`, que es otro dominio. Por eso:
 *
 *   1. fuera todo carácter de control, todo espacio y la barra
 *      invertida (`/\evil.com` también es absoluta para el navegador);
 *   2. y además se RESUELVE contra un origen propio con el mismo parser
 *      que usarán el navegador y `new URL(destino, origin)` del
 *      callback. Si el resultado cambia de origen, no era una ruta
 *      nuestra. Lo que se devuelve es lo que el parser entendió
 *      (ruta + query + fragmento), no la cadena de entrada.
 */
export function destinoSeguro(next: string | null | undefined, porDefecto = "/resumen"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return porDefecto;
  if (CARACTERES_PROHIBIDOS.test(next)) return porDefecto;

  let url: URL;
  try {
    url = new URL(next, ORIGEN_PROPIO);
  } catch {
    return porDefecto;
  }
  if (url.origin !== ORIGEN_PROPIO) return porDefecto;
  if (esRutaPublica(url.pathname)) return porDefecto;
  return `${url.pathname}${url.search}${url.hash}`;
}
