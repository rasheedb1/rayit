/**
 * El perfil comercial del creador (VEN-11, docs/ventas-outreach.md §5.4).
 *
 * Es la «persona remitente» de Chief, pero derivada de datos: identidad,
 * audiencia, desempeño (mediana por red y los cinco mejores videos con
 * su porqué), formatos y tono, prueba social y tarifas. Lo lee el
 * generador de mensajes (VEN-12) y el recomendador (VEN-13), y lo ve el
 * creador en /ventas/perfil.
 *
 * La regla que lo organiza: **cada cifra es un Claim** con su origen
 * (tabla, fila y columna). Las secciones no llevan números: llevan ids
 * de claims. Así hay una sola lista de cifras que la narrativa puede
 * citar ([claim:id]), que el verificador puede comprobar y que la
 * pantalla puede enlazar a su post o a su campaña.
 *
 * Funciones puras: la base entrega las filas ya leídas (PerfilInputs,
 * queries/perfil-comercial.ts de @mc/db) y aquí solo se eligen, se
 * ordenan y se nombran. Las medianas, los puntajes y las demografías ya
 * vienen calculados de sus tablas; lo único que se cuenta aquí es lo que
 * sale de leer los captions (formatos y tono), que en el MVP no tiene
 * tabla (en la fase 2 lo dará el laboratorio de video).
 */
import type { Decimal } from '../facturacion.ts';
import type { PlatformId } from '../campanas.ts';
import {
  contentOf, durationBucketOf, durationVsTypical, firstLine, hookFromAnalysis, hookOf, median, pieceOf,
  TONE_MIN_SHARE, toneTraitsOf,
} from './perfil-captions.ts';

// ---------------------------------------------------------------------
// 1 · El Claim: una cifra con su origen
// ---------------------------------------------------------------------

/**
 * Qué clase de cifra es. Decide cómo se escribe (la pantalla con Intl,
 * el prompt con el formateador que le pase quien llama):
 *   count     un entero: views, seguidores, videos, canjes
 *   share     una proporción de 0 a 1: 64 % mujeres, 45 % no seguidores
 *   multiple  veces la mediana propia: 5,97×
 *   money     un decimal en texto con la moneda en `unit`
 *   duration  segundos
 */
export const CLAIM_KINDS = ['count', 'share', 'multiple', 'money', 'duration'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Las tablas y vistas de las que puede salir una cifra del perfil. */
export const CLAIM_TABLES = [
  'creator_baseline',
  'post',
  'post_score',
  'post_metrics_latest',
  'audience_breakdown',
  'account_metric_snapshot',
  'campaign_result',
  'rate_card_item',
] as const;
export type ClaimTable = (typeof CLAIM_TABLES)[number];

export interface ClaimSource {
  table: ClaimTable;
  /**
   * La fila. Para una cifra de una sola fila, su llave (post_score y
   * campaign_result tienen por llave post_id y campaign_id). Para un
   * agregado (la mediana de no seguidores de una red, cuántos captions
   * usan emojis), el creador, y las filas que entraron van en `rows`.
   */
  id: string;
  field: string;
  /** Las filas que forman un agregado, para poder enseñarlas. */
  rows?: string[];
  /** El enlace público del post, cuando el origen es un post. */
  url?: string | null;
}

export interface Claim {
  /** [a-z0-9-], estable entre cálculos si el origen no cambia: lo cita la narrativa como [claim:id]. */
  id: string;
  kind: ClaimKind;
  /** Qué es, en una línea, en el idioma del perfil: lo lee el modelo y lo enseña el tooltip. */
  label: string;
  /** Un número; el dinero, como decimal en texto (nunca float). */
  value: number | Decimal;
  /** 'views', 'seguidores', 'videos', 'pct', 'x', 's' o la moneda ISO-4217. */
  unit: string;
  source: ClaimSource;
}

export const CLAIM_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

// ---------------------------------------------------------------------
// 2 · Lo que entra: las filas, ya leídas dentro de withWorkspace
// ---------------------------------------------------------------------

export interface PerfilCreatorInput {
  id: string;
  displayName: string;
  handle: string | null;
  bio: string | null;
  country: string | null;
  languages: string[];
  nicheSlugs: string[];
  /** El nombre de cada nicho en el catálogo, en el mismo orden (o el slug si no está). */
  nicheNames: string[];
}

export interface PerfilConnectionInput {
  id: string;
  platformId: PlatformId;
  handle: string | null;
  status: string;
  /** La última lectura de seguidores de la cuenta (account_metric_snapshot). */
  followers: number | null;
  followersSnapshotId: string | null;
  followersDay: string | null;
}

/** Una fila de audience_breakdown: la del último día de la cuenta, población 'followers'. */
export interface PerfilAudienceInput {
  id: string;
  platformId: PlatformId;
  connectionId: string;
  dimension: string;
  bucket: string;
  share: number | null;
  day: string;
}

/** La mediana de alcance en no seguidores de una red, calculada en SQL sobre post_metrics_latest. */
export interface PerfilNonFollowerInput {
  platformId: PlatformId;
  medianShare: number | null;
  postIds: string[];
}

/** La línea base vigente de una red al corte del perfil. */
export interface PerfilBaselineInput {
  id: string;
  platformId: PlatformId;
  ageHoursCut: number;
  medianViews: number | null;
  sampleSize: number;
  isReliable: boolean;
  computedAt: string;
}

export const OUTLIER_TIERS = ['under', 'normal', 'good', 'outlier', 'breakout'] as const;
export type OutlierTier = (typeof OUTLIER_TIERS)[number];

export interface PerfilPostInput {
  id: string;
  platformId: PlatformId;
  url: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string[];
  surface: string | null;
  mediaType: string;
  durationS: number | null;
  isBrandedContent: boolean | null;
  publishedAt: string | null;
  /** hook.type del laboratorio de video, si el post pasó por él (creator_post_board). */
  hookType: string | null;
  /** post_score, si el post ya tiene puntaje. */
  score: {
    viewsAtCut: number | null;
    viewsVsMedian: number | null;
    outlierTier: OutlierTier | null;
    ageHoursCut: number;
  } | null;
}

export interface PerfilCampaignInput {
  id: string;
  name: string;
  companyName: string;
  status: string;
  result: {
    views: number | null;
    brandFollowersGained: number | null;
    codeRedemptions: number | null;
    attributedRevenue: Decimal | null;
    currency: string | null;
    viewsVsMedian: number | null;
  };
}

export interface PerfilRateItemInput {
  id: string;
  labelEs: string;
  platformId: PlatformId | null;
  priceLow: Decimal | null;
  priceHigh: Decimal | null;
}

export interface PerfilInputs {
  creator: PerfilCreatorInput;
  connections: PerfilConnectionInput[];
  audience: PerfilAudienceInput[];
  nonFollowers: PerfilNonFollowerInput[];
  baselines: PerfilBaselineInput[];
  /** Los posts del creador (no borrados en la plataforma), con su puntaje si lo tienen. */
  posts: PerfilPostInput[];
  /** Las campañas con resultado medido, reportadas o cerradas. */
  campaigns: PerfilCampaignInput[];
  rateCard: { id: string; currency: string; computedAt: string; items: PerfilRateItemInput[] } | null;
  /** El corte de edad de las medianas (168 h, el del tarifario y el media kit). */
  cutHours: number;
  /** El instante del cálculo, ISO. Entra como dato para que el resultado sea determinista. */
  computedAt: string;
}

// ---------------------------------------------------------------------
// 3 · Lo que sale: secciones con ids de claims
// ---------------------------------------------------------------------

/** El gancho de la primera línea (ver perfil-captions.ts). */
export const HOOK_KINDS = ['reto', 'pregunta', 'error', 'lista', 'promesa', 'historia', 'directo'] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/** La pieza: qué formato de la red es. */
export const PIECE_KINDS = ['reel', 'tiktok', 'short', 'historia', 'video'] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

/** El tipo de contenido que se lee en el caption. */
export const CONTENT_KINDS = ['tutorial', 'reto', 'lista', 'colaboracion', 'otro'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const DURATION_BUCKETS = ['muy_corto', 'corto', 'medio', 'largo'] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

/** El video frente a los demás del creador en la misma red. */
export const DURATION_VS_TYPICAL = ['mas_corto', 'similar', 'mas_largo'] as const;
export type DurationVsTypical = (typeof DURATION_VS_TYPICAL)[number];

/** Rasgos de tono que se leen en los captions. */
export const TONE_TRAITS = ['emojis', 'tutea', 'primera_persona', 'preguntas', 'breve', 'hashtags'] as const;
export type ToneTrait = (typeof TONE_TRAITS)[number];

/** Por qué funcionó un video, en tres ejes. Códigos: el texto lo pone quien lo enseña. */
export interface WhyItWorked {
  hook: HookKind;
  /** 'caption' si se leyó del texto; 'video_analysis' si lo dijo el laboratorio de video. */
  hookSource: 'caption' | 'video_analysis';
  piece: PieceKind;
  content: ContentKind;
  duration: DurationBucket | null;
  durationVsTypical: DurationVsTypical | null;
}

export interface TopVideo {
  postId: string;
  platformId: PlatformId;
  url: string | null;
  /** El título, o la primera línea del caption. */
  title: string;
  publishedAt: string | null;
  outlierTier: OutlierTier | null;
  viewsClaimId: string | null;
  multipleClaimId: string;
  durationClaimId: string | null;
  why: WhyItWorked;
}

export interface NetworkLine {
  platformId: PlatformId;
  handle: string | null;
  followersClaimId: string | null;
  /** Día de la lectura de seguidores (YYYY-MM-DD). */
  followersDay: string | null;
}

export interface MedianLine {
  platformId: PlatformId;
  claimId: string;
  sampleSize: number;
  isReliable: boolean;
}

export const AUDIENCE_DIMENSIONS = ['age', 'gender', 'country'] as const;
export type AudienceDimension = (typeof AUDIENCE_DIMENSIONS)[number];

export interface AudienceLine {
  dimension: AudienceDimension;
  bucket: string;
  claimId: string;
}

export interface FormatLine<K extends string> {
  key: K;
  claimId: string;
}

export interface SocialProofLine {
  campaignId: string;
  name: string;
  companyName: string;
  claimIds: string[];
}

export interface RateLine {
  itemId: string;
  label: string;
  platformId: PlatformId | null;
  lowClaimId: string | null;
  highClaimId: string | null;
}

export const PERFIL_VERSION = 1;

export interface PerfilComercial {
  version: typeof PERFIL_VERSION;
  creatorId: string;
  computedAt: string;
  cutHours: number;
  identity: {
    displayName: string;
    handle: string | null;
    bio: string | null;
    country: string | null;
    languages: string[];
    niches: string[];
    networks: NetworkLine[];
  };
  audience: {
    /** La red principal: la de más seguidores que tenga demografía. */
    platformId: PlatformId | null;
    day: string | null;
    lines: AudienceLine[];
    nonFollowers: { platformId: PlatformId; claimId: string }[];
  };
  performance: {
    medians: MedianLine[];
    /** Cuántos videos con puntaje se miraron para elegir los mejores. */
    scoredClaimId: string | null;
    top: TopVideo[];
  };
  formats: {
    pieces: FormatLine<PieceKind>[];
    contents: FormatLine<ContentKind>[];
    tone: FormatLine<ToneTrait>[];
    /** Cuántos captions se leyeron. */
    captionsClaimId: string | null;
  };
  socialProof: SocialProofLine[];
  rates: { rateCardId: string; currency: string; lines: RateLine[] } | null;
  claims: Claim[];
}

// ---------------------------------------------------------------------
// 4 · El cálculo
// ---------------------------------------------------------------------

/** Cuántos videos entran en «los mejores». */
export const TOP_VIDEOS = 5;
/** Cuántos segmentos de edad y de país se dicen: los tres primeros bastan para una marca. */
export const AUDIENCE_TOP = 3;

export class PerfilError extends Error {
  readonly code: 'duplicate_claim' | 'invalid_claim_id';
  constructor(code: 'duplicate_claim' | 'invalid_claim_id', message: string) {
    super(message);
    this.name = 'PerfilError';
    this.code = code;
  }
}

/** Los nombres de marca de las redes: no se traducen. */
export const PLATFORM_LABELS: Record<PlatformId, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  youtube: 'YouTube',
};
const PLATFORM_ORDER: readonly PlatformId[] = ['tiktok', 'instagram', 'facebook', 'youtube'];

/** Los últimos doce dígitos hexadecimales de un uuid: bastan para distinguir y el modelo los copia sin error. */
export function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase().slice(-12);
}

/** Un segmento legible en un id de claim: «25-34» → «25-34», «55+» → «55-mas», «F» → «f». */
export function claimSlug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\+/g, '-mas')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
}

/** El corte de edad en palabras, para las etiquetas: 168 → «a los 7 días». */
export function cutLabel(hours: number): string {
  if (hours < 48) return `a las ${hours} horas`;
  return `a los ${Math.round(hours / 24)} días`;
}

const GENEROS: Record<string, string> = { f: 'mujeres', m: 'hombres', u: 'de género sin especificar' };

/** El nombre del país en español, o el código si Intl no lo conoce. */
export function regionName(code: string): string {
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** La lista de claims del perfil, sin ids repetidos. */
class ClaimSet {
  readonly list: Claim[] = [];
  private readonly byId = new Map<string, Claim>();

  add(claim: Claim): string {
    if (!CLAIM_ID_RE.test(claim.id)) throw new PerfilError('invalid_claim_id', `Id de claim inválido: «${claim.id}».`);
    const previo = this.byId.get(claim.id);
    if (previo) {
      if (previo.source.table === claim.source.table && previo.source.id === claim.source.id && previo.source.field === claim.source.field) {
        return previo.id;
      }
      throw new PerfilError('duplicate_claim', `Dos cifras distintas con el id «${claim.id}».`);
    }
    this.byId.set(claim.id, claim);
    this.list.push(claim);
    return claim.id;
  }
}

function tituloDe(post: PerfilPostInput): string {
  const t = (post.title && post.title.trim()) || firstLine(post.caption);
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

/**
 * Arma el perfil comercial a partir de las filas. Determinista: las
 * mismas entradas dan el mismo perfil, con los mismos ids de claim.
 */
export function buildPerfil(input: PerfilInputs): PerfilComercial {
  const claims = new ClaimSet();
  const creatorId = input.creator.id;
  const red = (p: PlatformId) => PLATFORM_LABELS[p];
  const porRed = <T extends { platformId: PlatformId }>(a: T, b: T) =>
    PLATFORM_ORDER.indexOf(a.platformId) - PLATFORM_ORDER.indexOf(b.platformId);

  // Identidad: una línea por cuenta conectada, con sus seguidores.
  const networks: NetworkLine[] = [...input.connections].sort(porRed).map((c) => ({
    platformId: c.platformId,
    handle: c.handle,
    followersDay: c.followersDay,
    followersClaimId:
      c.followers !== null && c.followersSnapshotId
        ? claims.add({
            id: `seguidores-${c.platformId}`,
            kind: 'count',
            label: `Seguidores en ${red(c.platformId)}`,
            value: c.followers,
            unit: 'seguidores',
            source: { table: 'account_metric_snapshot', id: c.followersSnapshotId, field: 'followers' },
          })
        : null,
  }));

  // Audiencia de la red principal: la de más seguidores con demografía.
  const conDemografia = new Set(input.audience.map((a) => a.connectionId));
  const principal = [...input.connections]
    .filter((c) => conDemografia.has(c.id))
    .sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1) || porRed(a, b))[0];
  const audienceLines: AudienceLine[] = [];
  let audienceDay: string | null = null;
  if (principal) {
    const filas = input.audience.filter((a) => a.connectionId === principal.id && a.share !== null);
    audienceDay = filas[0]?.day ?? null;
    const top = (dim: AudienceDimension, n: number, fuera: (b: string) => boolean = () => false) =>
      filas
        .filter((a) => a.dimension === dim && !fuera(a.bucket))
        .sort((a, b) => (b.share ?? 0) - (a.share ?? 0) || a.bucket.localeCompare(b.bucket))
        .slice(0, n);
    const etiqueta = (dim: AudienceDimension, bucket: string) => {
      const donde = red(principal.platformId);
      if (dim === 'age') return `Parte de sus seguidores de ${donde} con ${bucket} años`;
      if (dim === 'gender') return `Parte de sus seguidores de ${donde} que son ${GENEROS[bucket.toLowerCase()] ?? bucket}`;
      return `Parte de sus seguidores de ${donde} que vive en ${regionName(bucket)}`;
    };
    const otros = (b: string) => ['other', 'others', 'otros'].includes(b.toLowerCase());
    for (const [dim, filasDim] of [
      ['age', top('age', AUDIENCE_TOP)],
      ['gender', top('gender', Number.POSITIVE_INFINITY)],
      ['country', top('country', AUDIENCE_TOP, otros)],
    ] as const) {
      for (const a of filasDim) {
        audienceLines.push({
          dimension: dim,
          bucket: a.bucket,
          claimId: claims.add({
            id: `audiencia-${principal.platformId}-${dim === 'age' ? 'edad' : dim === 'gender' ? 'genero' : 'pais'}-${claimSlug(a.bucket)}`,
            kind: 'share',
            label: etiqueta(dim, a.bucket),
            value: a.share!,
            unit: 'pct',
            source: { table: 'audience_breakdown', id: a.id, field: 'share' },
          }),
        });
      }
    }
  }
  const nonFollowers = input.nonFollowers
    .filter((n) => n.medianShare !== null)
    .sort(porRed)
    .map((n) => ({
      platformId: n.platformId,
      claimId: claims.add({
        id: `no-seguidores-${n.platformId}`,
        kind: 'share',
        label: `Alcance en personas que no la siguen, mediana por video en ${red(n.platformId)}`,
        value: n.medianShare!,
        unit: 'pct',
        source: { table: 'post_metrics_latest', id: creatorId, field: 'non_follower_share', rows: n.postIds },
      }),
    }));

  // Desempeño: la mediana por red y los cinco mejores videos.
  const medians: MedianLine[] = input.baselines
    .filter((b) => b.medianViews !== null)
    .sort(porRed)
    .map((b) => ({
      platformId: b.platformId,
      sampleSize: b.sampleSize,
      isReliable: b.isReliable,
      claimId: claims.add({
        id: `mediana-${b.platformId}`,
        kind: 'count',
        label: `Views medianas por video en ${red(b.platformId)} ${cutLabel(b.ageHoursCut)}`,
        value: Math.round(b.medianViews!),
        unit: 'views',
        source: { table: 'creator_baseline', id: b.id, field: 'median_views' },
      }),
    }));

  const puntuados = input.posts.filter((p) => p.score && p.score.viewsVsMedian !== null);
  const scoredClaimId = puntuados.length
    ? claims.add({
        id: 'videos-con-puntaje',
        kind: 'count',
        label: 'Videos con puntaje frente a su mediana',
        value: puntuados.length,
        unit: 'videos',
        source: { table: 'post_score', id: creatorId, field: 'views_vs_median', rows: puntuados.map((p) => p.id) },
      })
    : null;
  const duracionTipica = new Map<PlatformId, number | null>();
  for (const p of PLATFORM_ORDER) {
    duracionTipica.set(p, median(input.posts.filter((x) => x.platformId === p && x.durationS !== null).map((x) => x.durationS!)));
  }
  const top: TopVideo[] = [...puntuados]
    .sort(
      (a, b) =>
        b.score!.viewsVsMedian! - a.score!.viewsVsMedian! ||
        (b.score!.viewsAtCut ?? 0) - (a.score!.viewsAtCut ?? 0) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, TOP_VIDEOS)
    .map((p) => {
      const s = shortId(p.id);
      const score = p.score!;
      const titulo = tituloDe(p);
      const enRed = red(p.platformId);
      const hookAnalisis = hookFromAnalysis(p.hookType);
      return {
        postId: p.id,
        platformId: p.platformId,
        url: p.url,
        title: titulo,
        publishedAt: p.publishedAt,
        outlierTier: score.outlierTier,
        multipleClaimId: claims.add({
          id: `video-${s}-x`,
          kind: 'multiple',
          label: `Veces su mediana de ${enRed} que hizo «${titulo}»`,
          value: score.viewsVsMedian!,
          unit: 'x',
          source: { table: 'post_score', id: p.id, field: 'views_vs_median', url: p.url },
        }),
        viewsClaimId:
          score.viewsAtCut !== null
            ? claims.add({
                id: `video-${s}-views`,
                kind: 'count',
                label: `Views de «${titulo}» en ${enRed} ${cutLabel(score.ageHoursCut)}`,
                value: score.viewsAtCut,
                unit: 'views',
                source: { table: 'post_score', id: p.id, field: 'views_at_cut', url: p.url },
              })
            : null,
        durationClaimId:
          p.durationS !== null
            ? claims.add({
                id: `video-${s}-duracion`,
                kind: 'duration',
                label: `Duración de «${titulo}»`,
                value: p.durationS,
                unit: 's',
                source: { table: 'post', id: p.id, field: 'duration_s', url: p.url },
              })
            : null,
        why: {
          hook: hookAnalisis ?? hookOf(p.title, p.caption),
          hookSource: hookAnalisis ? 'video_analysis' : 'caption',
          piece: pieceOf(p.platformId, p.surface, p.mediaType),
          content: contentOf(p.title, p.caption, p.isBrandedContent),
          duration: durationBucketOf(p.durationS),
          durationVsTypical: durationVsTypical(p.durationS, duracionTipica.get(p.platformId) ?? null),
        },
      };
    });

  return {
    version: PERFIL_VERSION,
    creatorId,
    computedAt: input.computedAt,
    cutHours: input.cutHours,
    identity: {
      displayName: input.creator.displayName,
      handle: input.creator.handle,
      bio: input.creator.bio,
      country: input.creator.country,
      languages: input.creator.languages,
      niches: input.creator.nicheNames,
      networks,
    },
    audience: { platformId: principal?.platformId ?? null, day: audienceDay, lines: audienceLines, nonFollowers },
    performance: { medians, scoredClaimId, top },
    formats: formatosDe(input, claims),
    socialProof: pruebaSocialDe(input, claims),
    rates: tarifasDe(input, claims),
    claims: claims.list,
  };
}

const PIEZAS_ES: Record<PieceKind, string> = {
  reel: 'reels', tiktok: 'videos de TikTok', short: 'shorts', historia: 'historias', video: 'videos largos o de feed',
};
const CONTENIDOS_ES: Record<ContentKind, string> = {
  tutorial: 'tutoriales o recetas', reto: 'retos', lista: 'listas', colaboracion: 'colaboraciones con marcas', otro: 'otros',
};
const TONOS_ES: Record<ToneTrait, string> = {
  emojis: 'Captions con emojis',
  tutea: 'Captions que le hablan de tú a quien mira',
  primera_persona: 'Captions en primera persona',
  preguntas: 'Captions con una pregunta',
  breve: 'Captions breves',
  hashtags: 'Captions con hashtags',
};

/** Qué hace (piezas y tipos de contenido) y cómo habla (tono), leído de los captions. */
function formatosDe(input: PerfilInputs, claims: ClaimSet): PerfilComercial['formats'] {
  const creatorId = input.creator.id;
  const cuenta = <K extends string>(clave: (p: PerfilPostInput) => K) => {
    const grupos = new Map<K, string[]>();
    for (const p of input.posts) {
      const k = clave(p);
      grupos.set(k, [...(grupos.get(k) ?? []), p.id]);
    }
    return [...grupos.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const pieces = cuenta((p) => pieceOf(p.platformId, p.surface, p.mediaType)).map(([key, ids]) => ({
    key,
    claimId: claims.add({
      id: `formato-${key}`,
      kind: 'count',
      label: `Publicaciones que son ${PIEZAS_ES[key]}`,
      value: ids.length,
      unit: 'videos',
      source: { table: 'post', id: creatorId, field: 'surface', rows: ids },
    }),
  }));
  const contents = cuenta((p) => contentOf(p.title, p.caption, p.isBrandedContent))
    .filter(([key]) => key !== 'otro')
    .map(([key, ids]) => ({
      key,
      claimId: claims.add({
        id: `contenido-${key}`,
        kind: 'count',
        label: `Publicaciones que son ${CONTENIDOS_ES[key]}`,
        value: ids.length,
        unit: 'videos',
        source: { table: 'post', id: creatorId, field: 'caption', rows: ids },
      }),
    }));

  const conCaption = input.posts.filter((p) => p.caption && p.caption.trim());
  const porRasgo = new Map<ToneTrait, string[]>();
  for (const p of conCaption) {
    for (const r of toneTraitsOf(p.caption, p.hashtags)) porRasgo.set(r, [...(porRasgo.get(r) ?? []), p.id]);
  }
  const tone = TONE_TRAITS.map((key) => ({ key, ids: porRasgo.get(key) ?? [] }))
    .filter((t) => conCaption.length > 0 && t.ids.length / conCaption.length >= TONE_MIN_SHARE)
    .sort((a, b) => b.ids.length - a.ids.length || TONE_TRAITS.indexOf(a.key) - TONE_TRAITS.indexOf(b.key))
    .map(({ key, ids }) => ({
      key,
      claimId: claims.add({
        id: `tono-${key.replace(/_/g, '-')}`,
        kind: 'share',
        label: TONOS_ES[key],
        value: ids.length / conCaption.length,
        unit: 'pct',
        source: { table: 'post', id: creatorId, field: 'caption', rows: ids },
      }),
    }));
  const captionsClaimId = conCaption.length
    ? claims.add({
        id: 'captions-leidos',
        kind: 'count',
        label: 'Captions leídos para inferir formatos y tono',
        value: conCaption.length,
        unit: 'videos',
        source: { table: 'post', id: creatorId, field: 'caption', rows: conCaption.map((p) => p.id) },
      })
    : null;
  return { pieces, contents, tone, captionsClaimId };
}

/** Las campañas con resultado medido: marca, nombre y lo que se puede citar. */
function pruebaSocialDe(input: PerfilInputs, claims: ClaimSet): SocialProofLine[] {
  const out: SocialProofLine[] = [];
  for (const c of input.campaigns) {
    const s = shortId(c.id);
    const r = c.result;
    const src = (field: string): ClaimSource => ({ table: 'campaign_result', id: c.id, field });
    const ids: string[] = [];
    if (r.views !== null) {
      ids.push(claims.add({ id: `campana-${s}-views`, kind: 'count', label: `Views de la campaña con ${c.companyName}`, value: r.views, unit: 'views', source: src('views') }));
    }
    if (r.viewsVsMedian !== null) {
      ids.push(claims.add({ id: `campana-${s}-x`, kind: 'multiple', label: `Veces su mediana que hizo la campaña con ${c.companyName}`, value: r.viewsVsMedian, unit: 'x', source: src('views_vs_median') }));
    }
    if (r.brandFollowersGained !== null) {
      ids.push(claims.add({ id: `campana-${s}-seguidores-marca`, kind: 'count', label: `Seguidores que ganó ${c.companyName} con la campaña`, value: r.brandFollowersGained, unit: 'seguidores', source: src('brand_followers_gained') }));
    }
    if (r.codeRedemptions !== null) {
      ids.push(claims.add({ id: `campana-${s}-canjes`, kind: 'count', label: `Canjes del código de ${c.companyName}`, value: r.codeRedemptions, unit: 'canjes', source: src('code_redemptions') }));
    }
    if (r.attributedRevenue !== null && r.currency) {
      ids.push(claims.add({ id: `campana-${s}-ingresos`, kind: 'money', label: `Ventas atribuidas a la campaña con ${c.companyName}`, value: r.attributedRevenue, unit: r.currency, source: src('attributed_revenue') }));
    }
    if (ids.length) out.push({ campaignId: c.id, name: c.name, companyName: c.companyName, claimIds: ids });
  }
  return out;
}

/** El tarifario vigente: el rango de cada entregable. */
function tarifasDe(input: PerfilInputs, claims: ClaimSet): PerfilComercial['rates'] {
  const card = input.rateCard;
  if (!card) return null;
  const lines: RateLine[] = card.items.map((i) => {
    const s = shortId(i.id);
    const src = (field: string): ClaimSource => ({ table: 'rate_card_item', id: i.id, field });
    return {
      itemId: i.id,
      label: i.labelEs,
      platformId: i.platformId,
      lowClaimId:
        i.priceLow !== null
          ? claims.add({ id: `tarifa-${s}-desde`, kind: 'money', label: `Tarifa de «${i.labelEs}», desde`, value: i.priceLow, unit: card.currency, source: src('price_low') })
          : null,
      highClaimId:
        i.priceHigh !== null
          ? claims.add({ id: `tarifa-${s}-hasta`, kind: 'money', label: `Tarifa de «${i.labelEs}», hasta`, value: i.priceHigh, unit: card.currency, source: src('price_high') })
          : null,
    };
  });
  return { rateCardId: card.id, currency: card.currency, lines };
}

/** Un claim por su id, o undefined. */
export function claimById(perfil: Pick<PerfilComercial, 'claims'>, id: string | null | undefined): Claim | undefined {
  if (!id) return undefined;
  return perfil.claims.find((c) => c.id === id);
}
