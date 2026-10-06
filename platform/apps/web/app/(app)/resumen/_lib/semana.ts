import { weeklySourcesFor, type WeeklyHighlight, type WeeklySource } from "@mc/db/queries/resumen-semana";
import type { Permiso } from "@mc/core";
import { isEnabled, moduleBySlug } from "@/content/modules";
import { flags as defaultFlags, type Flags } from "@/content/flags";
import { hrefDe, PERIODO_POR_DEFECTO } from "./filtro";

/**
 * Las dos decisiones del bloque «Lo que importa esta semana» (RES-3) que
 * no son SQL ni texto, aparte para poder probarlas sin base:
 *
 *   - qué fuentes se piden: las que los permisos de la sesión abren
 *     (`weeklySourcesFor`, ACC-5) Y cuyo módulo está encendido. Una fila
 *     que lleva a un 404 —sin permiso o con la bandera apagada— no se
 *     enseña;
 *   - a dónde lleva cada fila: siempre a su módulo.
 */

/** El módulo de cada fuente, por su slug de content/modules.ts. */
export const MODULO_DE_FUENTE: Readonly<Record<WeeklySource, string>> = {
  connection: "conexiones",
  invoice: "finanzas",
  deal: "ventas",
  outlier: "resumen",
};

/** Las fuentes que esta sesión puede ver, en el orden de urgencia de @mc/db. */
export function fuentesVisibles(permisos: ReadonlySet<Permiso>, flags: Flags = defaultFlags): WeeklySource[] {
  return weeklySourcesFor(permisos).filter((s) => {
    const m = moduleBySlug(MODULO_DE_FUENTE[s]);
    return m !== undefined && isEnabled(m, flags);
  });
}

/**
 * El enlace de la fila, siempre dentro de su módulo:
 *
 *   - la cuenta → /conexiones, donde se reconecta;
 *   - la factura → su detalle. El recordatorio de FIN-4 lleva el paso en
 *     el action_url (`…?recordatorio=21`) y el detalle lo resalta: se usa
 *     tal cual si es el de ESA factura, y si no, el detalle a secas. Un
 *     action_url es un dato de la base: no se sigue a ciegas;
 *   - el seguimiento → la ficha de la empresa, donde está el negocio;
 *   - el video → Resumen filtrado por su red, el mismo enlace que el
 *     filtro de arriba (hrefDe).
 */
export function hrefDeFila(f: WeeklyHighlight): string {
  switch (f.source) {
    case "connection":
      return "/conexiones";
    case "invoice": {
      const detalle = `/finanzas/facturas/${f.invoiceId}`;
      return f.actionUrl !== null && /^\?recordatorio=\d+$/.test(f.actionUrl.slice(detalle.length)) && f.actionUrl.startsWith(detalle)
        ? f.actionUrl
        : detalle;
    }
    case "deal":
      return `/ventas/empresas/${f.companyId}`;
    case "outlier":
      return hrefDe({ days: PERIODO_POR_DEFECTO, platform: f.platformId });
  }
}
