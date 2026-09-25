import type { Claim } from "@mc/core/outreach/perfil";
import type { Formatter } from "@/lib/format";
import { MESSAGES } from "./messages";

/**
 * Cómo se escribe y adónde lleva cada cifra del perfil. Se resuelve en
 * el servidor, con el formateador del workspace, y viaja al cliente como
 * datos planos (CifraVista): un componente de cliente no recibe funciones.
 */
export interface CifraVista {
  id: string;
  /** La cifra escrita con Intl y el locale, la moneda y la zona del workspace. */
  valor: string;
  /** Qué es («Views medianas por video en TikTok a los 7 días»). */
  etiqueta: string;
  /** De dónde sale («Puntaje del video frente a tu mediana»). */
  origen: string;
  href: string | null;
  /** true si el enlace sale de On Cue (el post en su red). */
  externo: boolean;
}

/** Desde aquí un conteo se abrevia («412 mil»): por debajo se lee entero. */
const COMPACTO_DESDE = 10_000;

/** La cifra escrita. Nunca a mano: todo pasa por lib/format.ts. */
export function formatClaim(c: Claim, f: Formatter): string {
  const n = typeof c.value === "number" ? c.value : Number(c.value);
  switch (c.kind) {
    case "count":
      return n >= COMPACTO_DESDE ? f.compact(n) : f.int(n);
    case "share":
      return f.pct(n, 0);
    case "multiple":
      return f.multiple(n, 1);
    case "money":
      return f.money(String(c.value), c.unit, { mode: "short" });
    case "duration":
      return MESSAGES.unidades.segundos(f.int(Math.round(n)));
  }
}

/**
 * Adónde lleva una cifra: al post en su red, a la campaña, al tarifario
 * o a Resumen (donde viven la línea base, los seguidores y la
 * demografía). Un agregado de captions no tiene una sola fila a la que
 * ir: su tooltip dice cuántas publicaciones lo sostienen.
 */
export function claimHref(c: Claim): { href: string; externo: boolean } | null {
  const s = c.source;
  switch (s.table) {
    case "post":
    case "post_score":
      return s.url ? { href: s.url, externo: true } : null;
    case "campaign_result":
      return { href: `/campanas/${s.id}`, externo: false };
    case "rate_card_item":
      return { href: "/cotizar", externo: false };
    case "creator_baseline":
    case "post_metrics_latest":
    case "audience_breakdown":
    case "account_metric_snapshot":
      return { href: "/resumen", externo: false };
  }
}

export function claimOrigin(c: Claim, f: Formatter): string {
  const tabla = MESSAGES.cifra.tablas[c.source.table];
  const filas = c.source.rows?.length;
  return filas ? `${tabla} · ${MESSAGES.cifra.filas(filas, f.int(filas))}` : tabla;
}

export function cifraVista(c: Claim, f: Formatter): CifraVista {
  const destino = claimHref(c);
  return {
    id: c.id,
    valor: formatClaim(c, f),
    etiqueta: c.label,
    origen: claimOrigin(c, f),
    href: destino?.href ?? null,
    externo: destino?.externo ?? false,
  };
}

/** Todas las cifras del perfil, por id: lo que la pantalla y la narrativa necesitan. */
export function cifrasVista(claims: readonly Claim[], f: Formatter): Record<string, CifraVista> {
  return Object.fromEntries(claims.map((c) => [c.id, cifraVista(c, f)]));
}
