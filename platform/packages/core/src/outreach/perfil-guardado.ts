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
  AUDIENCE_DIMENSIONS, CLAIM_ID_RE, CLAIM_KEYS, CLAIM_KINDS, CLAIM_TABLES, CONTENT_KINDS, DURATION_BUCKETS, DURATION_VS_TYPICAL,
  HOOK_KINDS, OUTLIER_TIERS, PERFIL_VERSION, PIECE_KINDS, TONE_TRAITS, WHY_AXES, type Claim, type PerfilComercial,
} from './perfil.ts';
import { PLATFORM_LABELS } from '../plataformas.ts';
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
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isStrOrNull = (v: unknown) => v === null || isStr(v);
const isIdOrNull = (v: unknown) => v === null || (isStr(v) && CLAIM_ID_RE.test(v));
const isId = (v: unknown): v is string => isStr(v) && CLAIM_ID_RE.test(v);
const isPlatform = (v: unknown) => isStr(v) && Object.hasOwn(PLATFORM_LABELS, v);
const isOneOf = (list: readonly string[]) => (v: unknown) => isStr(v) && list.includes(v);
/** Un arreglo cuyos elementos cumplen `each`: lo que la pantalla recorre con map y filter. */
const arrayOf = (v: unknown, each: (x: unknown) => boolean) => Array.isArray(v) && v.every(each);

function isClaim(v: unknown): v is Claim {
  if (!isObj(v) || !isObj(v.source) || !isObj(v.params)) return false;
  const s = v.source;
  return (
    isId(v.id) &&
    (CLAIM_KINDS as readonly unknown[]).includes(v.kind) &&
    (CLAIM_KEYS as readonly unknown[]).includes(v.key) &&
    isStr(v.unit) &&
    (isNum(v.value) || (isStr(v.value) && /^-?\d+(\.\d+)?$/.test(v.value))) &&
    (CLAIM_TABLES as readonly unknown[]).includes(s.table) && isStr(s.id) && isStr(s.field) &&
    (s.rows === undefined || arrayOf(s.rows, isStr)) &&
    (s.url === undefined || isStrOrNull(s.url)) &&
    (s.asOf === undefined || s.asOf === null || isIso(s.asOf))
  );
}

const isKeyed = (keys: readonly string[]) => (x: unknown) => isObj(x) && isOneOf(keys)(x.key) && isId(x.claimId);

function isWhy(v: unknown): boolean {
  return (
    isObj(v) && isOneOf(HOOK_KINDS)(v.hook) && isOneOf(PIECE_KINDS)(v.piece) && isOneOf(CONTENT_KINDS)(v.content) &&
    (v.duration === null || isOneOf(DURATION_BUCKETS)(v.duration)) &&
    (v.durationVsTypical === null || isOneOf(DURATION_VS_TYPICAL)(v.durationVsTypical)) &&
    arrayOf(v.reasons, (r) => isObj(r) && isOneOf(WHY_AXES)(r.axis) && isStr(r.group) && isId(r.groupClaimId) && isId(r.restClaimId))
  );
}

/**
 * Las secciones con la forma que la pantalla recorre: cada arreglo es un
 * arreglo y cada id de claim tiene forma de id. Un jsonb a medio escribir
 * o editado a mano en media_kit no llega a la pantalla: es «sin calcular».
 */
function isPerfil(p: Obj): boolean {
  const { identity: id, audience: a, performance: perf, formats: f, rates: r } = p;
  if (!isObj(id) || !isObj(a) || !isObj(perf) || !isObj(f)) return false;
  return (
    isStr(id.displayName) && isStrOrNull(id.handle) && isStrOrNull(id.bio) && isStrOrNull(id.country) &&
    arrayOf(id.languages, isStr) && arrayOf(id.niches, isStr) &&
    arrayOf(id.networks, (n) => isObj(n) && isPlatform(n.platformId) && isStrOrNull(n.handle) && isIdOrNull(n.followersClaimId)) &&
    (a.platformId === null || isPlatform(a.platformId)) && isStrOrNull(a.day) &&
    arrayOf(a.lines, (l) => isObj(l) && isOneOf(AUDIENCE_DIMENSIONS)(l.dimension) && isStr(l.bucket) && isId(l.claimId)) &&
    arrayOf(a.nonFollowers, (n) => isObj(n) && isPlatform(n.platformId) && isId(n.claimId)) &&
    arrayOf(perf.medians, (m) => isObj(m) && isPlatform(m.platformId) && isId(m.claimId) && isNum(m.cutHours) && isNum(m.sampleSize)) &&
    isIdOrNull(perf.scoredClaimId) &&
    arrayOf(perf.top, (v) =>
      isObj(v) && isStr(v.postId) && isPlatform(v.platformId) && isStr(v.title) && isStrOrNull(v.url) && isNum(v.cutHours) &&
      (v.outlierTier === null || isOneOf(OUTLIER_TIERS)(v.outlierTier)) &&
      isId(v.multipleClaimId) && isIdOrNull(v.viewsClaimId) && isIdOrNull(v.baselineClaimId) && isIdOrNull(v.durationClaimId) &&
      isWhy(v.why)) &&
    arrayOf(f.pieces, isKeyed(PIECE_KINDS)) && arrayOf(f.contents, isKeyed(CONTENT_KINDS)) && arrayOf(f.tone, isKeyed(TONE_TRAITS)) &&
    isIdOrNull(f.captionsClaimId) &&
    arrayOf(p.socialProof, (c) => isObj(c) && isStr(c.campaignId) && isStr(c.name) && isStr(c.companyName) && arrayOf(c.claimIds, isId)) &&
    (r === null || (isObj(r) && isStr(r.currency) && arrayOf(r.lines, (l) =>
      isObj(l) && isStr(l.itemId) && isStr(l.label) && (l.platformId === null || isPlatform(l.platformId)) &&
      isIdOrNull(l.lowClaimId) && isIdOrNull(l.highClaimId))))
  );
}

/** Un perfil guardado con la forma que esta versión sabe pintar, o null. */
export function parseStoredPerfil(value: unknown): StoredPerfil | null {
  if (!isObj(value) || value.version !== PERFIL_VERSION || !isIso(value.computedAt)) return null;
  const p = value.perfil;
  const n = value.narrative;
  if (!isObj(p) || !isObj(n)) return null;
  if (p.version !== PERFIL_VERSION || !isStr(p.creatorId) || !isIso(p.computedAt) || !isNum(p.cutHours)) return null;
  if (!arrayOf(p.claims, isClaim) || !isPerfil(p)) return null;
  if (!isStr(n.text) || !(NARRATIVE_SOURCES as readonly unknown[]).includes(n.source) || !isIso(n.writtenAt)) return null;
  if (!(n.model === null || isStr(n.model))) return null;
  if (!(n.fallback === null || (NARRATIVE_FALLBACKS as readonly unknown[]).includes(n.fallback))) return null;
  return value as unknown as StoredPerfil;
}
