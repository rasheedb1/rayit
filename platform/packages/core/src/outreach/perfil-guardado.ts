/**
 * El perfil comercial guardado (VEN-11): lo que vive en
 * creator_profile.media_kit bajo la clave perfil_comercial.
 *
 * No tiene tabla propia a propósito: es una foto del creador que se
 * recalcula entera (botón «Recalcular»), y quien la lee —la pantalla, el
 * generador de VEN-12, el recomendador de VEN-13— la quiere entera. El
 * jsonb se comprueba al leer (parseStoredPerfil): un documento de otra
 * versión o roto se trata como «sin calcular» y la pantalla ofrece
 * recalcular, en vez de pintar cifras de un formato que ya no conoce.
 */
import {
  CLAIM_ID_RE, CLAIM_KINDS, CLAIM_TABLES, PERFIL_VERSION, type Claim, type PerfilComercial,
} from './perfil.ts';
import { NARRATIVE_FALLBACKS, type NarrativeFallback } from './narrativa.ts';

/** La clave dentro de creator_profile.media_kit. */
export const PERFIL_MEDIA_KIT_KEY = 'perfil_comercial';

/**
 * Quién escribió la narrativa que se ve:
 *   llm       claude-sonnet-5, verificada
 *   template  la plantilla determinista (fallback dice por qué)
 *   edited    el creador la corrigió a mano (y pasó el mismo verificador)
 */
export const NARRATIVE_SOURCES = ['llm', 'template', 'edited'] as const;
export type NarrativeSource = (typeof NARRATIVE_SOURCES)[number];

export interface StoredNarrative {
  text: string;
  source: NarrativeSource;
  model: string | null;
  writtenAt: string;
  fallback: NarrativeFallback | null;
}

export interface StoredPerfil {
  version: typeof PERFIL_VERSION;
  /** Cuándo se calculó el perfil (las cifras). La narrativa lleva su propia fecha. */
  computedAt: string;
  perfil: PerfilComercial;
  narrative: StoredNarrative;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

function isClaim(v: unknown): v is Claim {
  if (!isObj(v) || !isObj(v.source)) return false;
  const s = v.source;
  return (
    isStr(v.id) && CLAIM_ID_RE.test(v.id) &&
    (CLAIM_KINDS as readonly unknown[]).includes(v.kind) &&
    isStr(v.label) && isStr(v.unit) &&
    ((typeof v.value === 'number' && Number.isFinite(v.value)) || (isStr(v.value) && /^-?\d+(\.\d+)?$/.test(v.value))) &&
    (CLAIM_TABLES as readonly unknown[]).includes(s.table) && isStr(s.id) && isStr(s.field)
  );
}

/** Un perfil guardado con la forma que esta versión sabe pintar, o null. */
export function parseStoredPerfil(value: unknown): StoredPerfil | null {
  if (!isObj(value) || value.version !== PERFIL_VERSION || !isIso(value.computedAt)) return null;
  const p = value.perfil;
  const n = value.narrative;
  if (!isObj(p) || !isObj(n)) return null;
  if (p.version !== PERFIL_VERSION || !isStr(p.creatorId) || !Array.isArray(p.claims) || !p.claims.every(isClaim)) return null;
  for (const k of ['identity', 'audience', 'performance', 'formats'] as const) if (!isObj(p[k])) return null;
  if (!Array.isArray(p.socialProof)) return null;
  const perf = p.performance as Obj;
  if (!Array.isArray(perf.top) || !Array.isArray(perf.medians)) return null;
  if (!isStr(n.text) || !(NARRATIVE_SOURCES as readonly unknown[]).includes(n.source) || !isIso(n.writtenAt)) return null;
  if (!(n.model === null || isStr(n.model))) return null;
  if (!(n.fallback === null || (NARRATIVE_FALLBACKS as readonly unknown[]).includes(n.fallback))) return null;
  return value as unknown as StoredPerfil;
}
