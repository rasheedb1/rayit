import { weeklySourcesFor, type WeeklyHighlight, type WeeklySource } from "@mc/db/queries/resumen-semana";
import type { Permiso } from "@mc/core";
import { isEnabled, moduleBySlug } from "@/content/modules";
import { flags as defaultFlags, type Flags } from "@/content/flags";
import { MESSAGES } from "../messages";
import { hrefDe, PERIODO_POR_DEFECTO } from "./filtro";

/**
 * Las decisiones del bloque «Lo que importa esta semana» (RES-3) que no
 * son SQL ni texto, aparte para poder probarlas sin base:
 *
 *   - qué fuentes se piden: las que los permisos de la sesión abren
 *     (`weeklySourcesFor`, ACC-5) Y cuyo módulo está encendido. Una fila
 *     que lleva a un 404 —sin permiso o con la bandera apagada— no se
 *     enseña, y el «Entendido» tampoco vale sobre ella;
 *   - a dónde lleva cada fila: siempre a su módulo, y el botón dice cuál.
 */

/** El módulo de cada fuente, por su slug de content/modules.ts. */
export const MODULO_DE_FUENTE: Readonly<Record<WeeklySource, string>> = {
  connection: "conexiones",
  channel: "ventas",
  invoice: "finanzas",
  deal: "ventas",
  outlier: "resumen",
};

/** Cuántas filas se ven al abrir el panel; el resto, tras «Ver N más». */
export const FILAS_A_LA_VISTA = 5;

/** Las fuentes que esta sesión puede ver, en el orden de urgencia de @mc/db. */
export function fuentesVisibles(permisos: ReadonlySet<Permiso>, flags: Flags = defaultFlags): WeeklySource[] {
  return weeklySourcesFor(permisos).filter((s) => {
    const m = moduleBySlug(MODULO_DE_FUENTE[s]);
    return m !== undefined && isEnabled(m, flags);
  });
}

/**
 * El enlace de la fila al módulo donde se resuelve:
 *
 *   - la cuenta → /conexiones, donde se reconecta;
 *   - la cuenta de envío → /ventas/canales;
 *   - la factura → su detalle. El recordatorio de FIN-4 lleva el paso en
 *     el action_url (`…?recordatorio=4`) y el detalle lo resalta: se usa
 *     tal cual si es el de ESA factura, y si no, el detalle a secas. Un
 *     action_url es un dato de la base: no se sigue a ciegas;
 *   - el seguimiento → la ficha de la empresa, donde está el negocio;
 *   - el video → Resumen filtrado por su red (hrefDe). No es el clic
 *     principal de su fila: ver `enlacesDeFila`.
 */
export function hrefDeFila(f: WeeklyHighlight): string {
  switch (f.source) {
    case "connection":
      return "/conexiones";
    case "channel":
      return "/ventas/canales";
    case "invoice": {
      const detalle = `/finanzas/facturas/${f.invoiceId}`;
      return f.actionUrl !== null && f.actionUrl.startsWith(detalle) && /^\?recordatorio=\d+$/.test(f.actionUrl.slice(detalle.length))
        ? f.actionUrl
        : detalle;
    }
    case "deal":
      return `/ventas/empresas/${f.companyId}`;
    case "outlier":
      return hrefDe({ days: PERIODO_POR_DEFECTO, platform: f.platformId });
  }
}

export interface Enlace {
  href: string;
  label: string;
  /** Sale de On Cue (el video en su red): se abre aparte. */
  externo: boolean;
}

/** Solo https: un permalink es un dato de la plataforma y no se sigue si no lo es. */
const esExterno = (url: string | null): url is string => url !== null && /^https:\/\//.test(url);

/**
 * Los enlaces de la fila, con el texto que dice a dónde llevan. El del
 * video destacado es el video mismo: no hay todavía ficha de video en On
 * Cue, y «Resumen filtrado por su red» es la página donde ya está el
 * usuario, con cifras agregadas donde el video no aparece; queda de
 * secundario («Ver tus cifras de Instagram»). Sin permalink https, ese
 * es el único.
 */
export function enlacesDeFila(f: WeeklyHighlight, red: string): { principal: Enlace; secundario: Enlace | null } {
  const t = MESSAGES.semana;
  const modulo = (label: string): Enlace => ({ href: hrefDeFila(f), label, externo: false });
  switch (f.source) {
    case "outlier": {
      const cifras = modulo(t.outlier.verCifras(red));
      return esExterno(f.postUrl)
        ? { principal: { href: f.postUrl, label: t.outlier.abrirVideo(red), externo: true }, secundario: cifras }
        : { principal: cifras, secundario: null };
    }
    default:
      return { principal: modulo(t.ir[f.source]), secundario: null };
  }
}
