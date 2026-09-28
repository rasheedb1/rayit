/**
 * Las afirmaciones trazables del outreach (VEN-12, absorbe VEN-6).
 *
 * Una «afirmación» (claim) es una cifra o un hecho del perfil comercial
 * del creador con su origen en la base: la mediana de views de una red
 * (creator_baseline), un video con sus views frente a la mediana
 * (post_score), una campaña con su resultado (campaign_result), el media
 * kit congelado… El generador marca cada cifra que escribe con
 * [claim:<id>] justo detrás; el pre-vuelo exige que cada cifra del
 * mensaje tenga su marca y que la cifra coincida con la del claim; al
 * guardar, las marcas salen del texto y los claims citados van a
 * outbound_touch.claims. Así un mensaje no sale con una cifra inventada
 * (docs/ventas-outreach.md §5.3 y §5.6).
 *
 * Puro: sin base ni red.
 */

/** De dónde puede salir una cifra: el vocabulario de outbound_angle.proof_sources (0046). */
export const CLAIM_SOURCES = [
  'creator_profile', 'creator_baseline', 'post_score', 'media_kit', 'campaign_result', 'signal', 'quote',
] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/** Cómo se lee el valor: un conteo, una proporción (0–1), un múltiplo (× mediana) o dinero. */
export type ClaimUnit = 'count' | 'share' | 'multiple' | 'money';

export interface SalesClaim {
  /** Estable y legible: 'baseline:tiktok:median_views', 'campaign:<uuid>:views'… Solo [a-z0-9:_-]. */
  id: string;
  source: ClaimSource;
  /** Qué es, en el idioma del workspace («Mediana de visualizaciones en TikTok a 7 días»). */
  label: string;
  /** El número tal cual está en la base (una proporción va de 0 a 1). null = un hecho sin cifra (una marca cliente). */
  value: number | null;
  unit: ClaimUnit | null;
  currency?: string | null;
  /** Cómo se escribe en un mensaje, ya formateado con el locale del workspace («115.446», «37 %», «6,7×»). */
  display: string;
  /** La fila de origen, para llevar a ella desde la pantalla. */
  ref: { table: string; id: string };
  /** Nombres propios que la afirmación respalda (la marca de una campaña): el juez no los toma por inventados. */
  entities?: string[];
}

const CLAIM_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,119}$/;

export function isClaimId(id: string): boolean {
  return CLAIM_ID_RE.test(id);
}

/** Una marca [claim:id] en el texto. */
export interface ClaimMarker {
  id: string;
  /** Dónde empieza y dónde acaba la marca, con el espacio que la precede. */
  start: number;
  end: number;
}

const MARKER_RE = /\s?\[claim:([a-z0-9][a-z0-9:_-]{0,119})\]/g;

/** Las marcas de un texto, en orden. */
export function findClaimMarkers(text: string | null | undefined): ClaimMarker[] {
  if (!text) return [];
  return [...text.matchAll(MARKER_RE)].map((m) => ({ id: m[1]!, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** El texto sin marcas: lo que sale de verdad. */
export function stripClaimMarkers(text: string): string {
  return text.replace(MARKER_RE, '');
}

/** Los ids citados, sin repetir, en orden de aparición. */
export function citedClaimIds(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of findClaimMarkers(t)) seen.add(m.id);
  return [...seen];
}

/** Los claims citados que existen, en el orden en que se citan: lo que va a outbound_touch.claims. */
export function claimsCitedIn(available: readonly SalesClaim[], ...texts: Array<string | null | undefined>): SalesClaim[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  return citedClaimIds(...texts).flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
}

// ---------------------------------------------------------------------
// Las cifras de un texto: los detectores viven en figures/ (contexto,
// múltiplos, puestos, números en palabras, la búsqueda y la comparación
// con el claim). Se re-exportan aquí para que nadie cambie sus imports.
// ---------------------------------------------------------------------

export type { FigureHit } from './figures/hit.ts';
export { DELIVERABLE_NOUNS, PERFORMANCE_NOUNS, SMALL_COUNT_MAX, withoutDates } from './figures/context.ts';
export { findFigures } from './figures/find.ts';
export { FIGURE_TOLERANCE, figureMatchesClaim } from './figures/match.ts';
