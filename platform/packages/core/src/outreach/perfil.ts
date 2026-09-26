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
 * (tabla, fila, columna y fecha de la lectura). Las secciones no llevan
 * números: llevan ids de claims. Así hay una sola lista de cifras que la
 * narrativa puede citar ([claim:id]), que el verificador puede comprobar
 * y que la pantalla puede enlazar a su post o a su campaña.
 *
 * Aquí no hay texto para personas: un claim dice QUÉ es con una clave
 * (`key`) y sus parámetros (red, segmento, corte, título…). La pantalla
 * lo escribe con su messages.ts y el locale del workspace; el prompt, con
 * claimLabelEs de narrativa.ts.
 *
 * Funciones puras: la base entrega las filas ya leídas (PerfilInputs,
 * queries/perfil-comercial.ts de @mc/db) y aquí solo se eligen, se
 * ordenan y se nombran. Las medianas de la línea base, los puntajes y
 * las demografías ya vienen calculados de sus tablas; lo que se deriva
 * aquí es lo que sale de leer los captions (formatos y tono) y el
 * contraste que explica por qué funcionó un video (la mediana de los
 * OTROS videos con su mismo rasgo frente a la de los que no lo tienen),
 * que en el MVP no tienen tabla.
 */
import type { Decimal } from '../facturacion.ts';
import type { PlatformId } from '../campanas.ts';
import { PLATFORM_ORDER } from '../plataformas.ts';
import { medianOrNull } from '../scoring.ts';
import {
  contentOf, durationBucketOf, durationVsTypical, firstLine, hookFromAnalysis, hookOf, pieceOf,
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

/**
 * Qué es la cifra, como clave. El texto lo pone quien la enseña:
 * /ventas/perfil/messages.ts para la pantalla, claimLabelEs para el prompt.
 */
export const CLAIM_KEYS = [
  'followers',
  'audience.age',
  'audience.gender',
  'audience.country',
  'non_followers',
  'median',
  'scored_videos',
  'video.multiple',
  'video.views',
  'video.duration',
  'why.group',
  'why.rest',
  'format.piece',
  'format.content',
  'tone',
  'captions_read',
  'campaign.views',
  'campaign.multiple',
  'campaign.brand_followers',
  'campaign.redemptions',
  'campaign.revenue',
  'rate.low',
  'rate.high',
] as const;
export type ClaimKey = (typeof CLAIM_KEYS)[number];

/** Los datos que completan la clave: de qué red, qué segmento, qué video… */
export interface ClaimParams {
  platform?: PlatformId;
  /** El segmento de audience_breakdown tal cual: '25-34', 'F', 'CO'. */
  bucket?: string;
  /** El corte de edad de la cifra, en horas desde la publicación. */
  cutHours?: number;
  /** El título del video (o la primera línea del caption). */
  title?: string;
  piece?: PieceKind;
  content?: ContentKind;
  trait?: ToneTrait;
  /** La marca de la campaña. */
  company?: string;
  /** El nombre del entregable del tarifario. */
  item?: string;
  /** Para why.group y why.rest: el eje y el grupo que se contrastan. */
  axis?: WhyAxis;
  group?: string;
}

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
  /**
   * Cuándo se leyó o se calculó la fila (ISO: un día o un instante). null
   * cuando la cifra sale de este mismo cálculo (los captions leídos).
   */
  asOf?: string | null;
}

export interface Claim {
  /** [a-z0-9-], estable entre cálculos si el origen no cambia: lo cita la narrativa como [claim:id]. */
  id: string;
  kind: ClaimKind;
  key: ClaimKey;
  params: ClaimParams;
  /** Un número; el dinero, como decimal en texto (nunca float). */
  value: number | Decimal;
  /** 'views', 'seguidores', 'videos', 'canjes', 'pct', 'x', 's' o la moneda ISO-4217. */
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

/**
 * Los estados de social_connection que cuentan como red conectada: la
 * cuenta sigue autenticada. 'expired', 'needs_reauth', 'error', 'revoked'
 * y 'disabled' no entran en el perfil hasta que se reconecten.
 */
export const CONNECTED_STATUSES: readonly string[] = ['active'];

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
  /** La lectura más reciente de esos videos (ISO). */
  asOf: string | null;
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
  /** La portada del post (post.cover_url), si la plataforma la dio. */
  coverUrl?: string | null;
  /** post_score, si el post ya tiene puntaje. */
  score: {
    viewsAtCut: number | null;
    viewsVsMedian: number | null;
    outlierTier: OutlierTier | null;
    ageHoursCut: number;
    computedAt?: string | null;
    /**
     * La línea base contra la que se puntuó (post_score.baseline_id): la
     * de su red en SU corte. Es la mediana que hace verdad el «× tu
     * mediana» de ese video, que puede no ser la del corte del perfil.
     */
    baseline?: { id: string; medianViews: number | null; ageHoursCut: number; computedAt: string } | null;
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
    computedAt?: string | null;
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
  /**
   * Los posts recientes del creador (no borrados en la plataforma), con
   * su puntaje si lo tienen: de ellos salen formatos, tono y la duración
   * típica, que hablan de lo que hace hoy.
   */
  posts: PerfilPostInput[];
  /**
   * Los posts con puntaje de TODO su historial (no solo los recientes):
   * de ellos salen los cinco mejores, su porqué y cuántos videos tienen
   * puntaje. Así un breakout antiguo entra aunque ya no esté entre los
   * recientes. Si falta, se usan los puntuados de `posts`.
   */
  scoredPosts?: PerfilPostInput[];
  /** Las campañas con resultado medido, reportadas o cerradas. */
  campaigns: PerfilCampaignInput[];
  rateCard: { id: string; currency: string; computedAt: string; items: PerfilRateItemInput[] } | null;
  /**
   * Los videos que forman cada línea base, por su id: los últimos
   * `window_posts` de la red con lectura a su corte, publicados antes del
   * cálculo menos el corte (la regla de creator_baseline). Solo trae las
   * que cuadran con su sample_size: si se importaron videos después, mejor
   * ninguno que otros. La mediana de la red y la de cada uno de los
   * mejores videos los llevan en source.rows.
   */
  baselinePosts?: Readonly<Record<string, readonly string[]>>;
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

/** Los ejes en los que un video puede distinguirse de los demás del creador. */
export const WHY_AXES = ['hook', 'piece', 'content', 'duration'] as const;
export type WhyAxis = (typeof WHY_AXES)[number];

/**
 * Una razón de por qué funcionó: los OTROS videos del creador que
 * comparten el rasgo del video en un eje (abren con una promesa, son
 * reels…) rinden claramente más que los que no lo tienen. El video que
 * se explica no entra en ninguna de las dos medianas: si entrara, su
 * propio resultado inflaría la de su grupo y la razón sería circular.
 * Las dos medianas son claims: la narrativa las cita.
 */
export interface WhyReason {
  axis: WhyAxis;
  /** El código del grupo en ese eje: un HookKind, PieceKind, ContentKind o DurationBucket. */
  group: string;
  /** La mediana de «veces su mediana» de los otros videos con el rasgo. */
  groupClaimId: string;
  /** La de los videos sin el rasgo. */
  restClaimId: string;
}

/**
 * Por qué funcionó un video. Los códigos describen el video (gancho,
 * pieza, tipo y duración frente a la típica): esa descripción es la
 * explicación principal. `reasons` añade, cuando los datos alcanzan, el
 * rasgo que más lo distingue (whyContrast): a lo sumo WHY_MAX_REASONS,
 * el de mayor contraste primero. Un rasgo que tienen todos los videos no
 * explica nada, así que nunca entra. El texto lo pone quien lo enseña.
 */
export interface WhyItWorked {
  hook: HookKind;
  /** 'caption' si se leyó del texto; 'video_analysis' si lo dijo el laboratorio de video. */
  hookSource: 'caption' | 'video_analysis';
  piece: PieceKind;
  content: ContentKind;
  duration: DurationBucket | null;
  /** Frente a la duración típica de la red; null si no se puede decir. 'similar' no es una razón. */
  durationVsTypical: DurationVsTypical | null;
  reasons: WhyReason[];
}

export interface TopVideo {
  postId: string;
  platformId: PlatformId;
  url: string | null;
  /** La portada del video (post.cover_url), si la hay: lo primero que ve una marca en un media kit. */
  coverUrl: string | null;
  /** El título, o la primera línea del caption. */
  title: string;
  publishedAt: string | null;
  outlierTier: OutlierTier | null;
  /** El corte al que se midió el puntaje (post_score.age_hours_cut). */
  cutHours: number;
  viewsClaimId: string | null;
  multipleClaimId: string;
  /** La mediana contra la que se puntuó (su red, su corte). Puede ser la misma de performance.medians. */
  baselineClaimId: string | null;
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
  /** El corte de ESTA mediana: si la red no tiene línea base al corte del perfil, es otro. */
  cutHours: number;
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

/**
 * Un post que forma alguna cifra agregada del perfil (la mediana de un
 * grupo del porqué, cuántos captions usan emojis…): lo que la pantalla
 * necesita para enlazarlo en «De dónde sale cada cifra» sin volver a la
 * base.
 */
export interface PostRef {
  postId: string;
  platformId: PlatformId;
  title: string;
  url: string | null;
}

/**
 * 3: el porqué deja fuera al video que explica (claims por video), los
 * mejores traen portada y el perfil trae el índice de posts (r3 de
 * VEN-11). Un perfil guardado de otra versión se lee como «sin calcular»
 * y se recalcula.
 */
export const PERFIL_VERSION = 3;

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
  /** Los posts que aparecen en `source.rows` de algún claim, con su título y su enlace. */
  posts: PostRef[];
}

// ---------------------------------------------------------------------
// 4 · Piezas del cálculo
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

/** Los últimos doce dígitos hexadecimales de un uuid: bastan para distinguir y el modelo los copia sin error. */
export function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase().slice(-12);
}

/**
 * Un enlace o una portada que la pantalla pone en href o en src: solo
 * http(s), y si no, null. post.url y post.cover_url no tienen CHECK y la
 * importación CSV guarda lo que venga («www.tiktok.com/@x/video/1», sin
 * esquema): se sanea aquí, al armar el perfil, para que el documento
 * guardado siempre pase parseStoredPerfil en vez de quedarse «sin
 * calcular» por un enlace mal escrito.
 */
export function webUrlOrNull(u: string | null | undefined): string | null {
  return typeof u === 'string' && /^https?:\/\/\S/i.test(u.trim()) ? u.trim() : null;
}

/**
 * Las portadas de la demostración que sirve apps/web/public (seed 0007):
 * la única ruta de la propia aplicación que puede ser una portada. Un
 * nombre de archivo plano, sin «..» ni subcarpetas.
 */
const DEMO_COVER_RE = /^\/demo\/portadas\/[A-Za-z0-9_-]+\.(?:svg|png|jpe?g|webp)$/;

/**
 * Una portada que la pantalla pone en src: solo https (una http sería
 * contenido mixto) o una portada de la demostración
 * («/demo/portadas/1.svg»). Cualquier otra ruta de la aplicación queda
 * fuera: post.cover_url no tiene CHECK y viene de la importación CSV, y
 * un <img src="/auth/salir"> haría que el navegador de otro miembro
 * pidiera esa ruta con sus cookies. Nunca «//otro.host».
 */
export function coverSrcOrNull(u: string | null | undefined): string | null {
  const v = typeof u === 'string' ? u.trim() : '';
  if (DEMO_COVER_RE.test(v)) return v;
  return /^https:\/\/\S/i.test(v) ? v : null;
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

/**
 * Un corte de edad en la unidad en que se dice: por debajo de dos días,
 * en horas; desde ahí, en días. Lo resuelve core para que ninguna
 * pantalla convierta horas a mano.
 */
export interface CutSpan {
  unit: 'hours' | 'days';
  amount: number;
}
export function cutOf(hours: number): CutSpan {
  return hours < 48 ? { unit: 'hours', amount: hours } : { unit: 'days', amount: Math.round(hours / 24) };
}

/**
 * Un género de audience_breakdown en código. Los conectores guardan 'F',
 * 'M' y 'U' (other, unknown o user_specified): 'u' nunca se dice como
 * «mujeres» ni «hombres».
 */
export function genderCode(bucket: string): 'f' | 'm' | 'u' {
  const b = bucket.trim().toLowerCase();
  return b === 'f' || b === 'female' ? 'f' : b === 'm' || b === 'male' ? 'm' : 'u';
}

/**
 * El contraste que hace de un rasgo una razón (whyContrast): la mediana
 * de los OTROS videos con el rasgo frente a la de los videos sin él.
 */
export interface GroupContrast {
  key: string;
  /** Los otros videos con el rasgo: nunca incluye al que se explica. */
  ids: string[];
  /** La mediana de «veces su mediana» de esos videos. */
  median: number;
  /** Los videos sin el rasgo. */
  restIds: string[];
  restMedian: number;
  /** median / restMedian: cuánto más rinde el rasgo. Ordena las razones. */
  lift: number;
}

/**
 * Cuántos videos como mínimo a cada lado, SIN contar el que se explica:
 * con dos, uno solo de ellos mueve la mediana, y eso no es un patrón.
 */
export const WHY_MIN_GROUP = 3;
/** Cuánto tiene que superar el grupo al resto (su mediana, en veces) para contar como razón: la mitad más. */
export const WHY_MIN_LIFT = 1.5;
/** Cuántas razones se dicen por video: la más fuerte. Dos contrastes flojos no suman uno bueno. */
export const WHY_MAX_REASONS = 1;

/**
 * Si el rasgo `key` del video `targetId` explica su resultado.
 *
 * Deja fuera al video (leave-one-out): el grupo son los OTROS videos con
 * el mismo rasgo y el resto, los videos sin él. Sin eso, un video de 6×
 * en un grupo de dos pone él solo la mediana del grupo y el «porqué» se
 * demuestra con su propio resultado. Es razón solo si hay al menos
 * WHY_MIN_GROUP videos a cada lado y la mediana del grupo supera la del
 * resto en WHY_MIN_LIFT veces. Los ítems con `key` null (sin duración,
 * por ejemplo) no entran en ningún lado; los de `exclude` no pueden ser
 * razón ('otro' no dice nada) pero sí cuentan en el resto.
 */
export function whyContrast(
  items: readonly { id: string; key: string | null; x: number }[],
  targetId: string,
  key: string | null,
  opts: { exclude?: readonly string[]; minGroup?: number; minLift?: number } = {},
): GroupContrast | null {
  if (key === null || opts.exclude?.includes(key)) return null;
  const minGroup = opts.minGroup ?? WHY_MIN_GROUP;
  const minLift = opts.minLift ?? WHY_MIN_LIFT;
  const otros = items.filter((i) => i.id !== targetId && i.key !== null && Number.isFinite(i.x));
  const grupo = otros.filter((i) => i.key === key);
  const resto = otros.filter((i) => i.key !== key);
  if (grupo.length < minGroup || resto.length < minGroup) return null;
  const mg = medianOrNull(grupo.map((i) => i.x));
  const mr = medianOrNull(resto.map((i) => i.x));
  if (mg === null || mr === null || mr <= 0 || mg < mr * minLift) return null;
  return {
    key,
    ids: grupo.map((i) => i.id).sort(),
    median: mg,
    restIds: resto.map((i) => i.id).sort(),
    restMedian: mr,
    lift: mg / mr,
  };
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
    // El enlace del origen es un href externo: solo http(s) (webUrlOrNull).
    if (claim.source.url !== undefined) claim = { ...claim, source: { ...claim.source, url: webUrlOrNull(claim.source.url) } };
    this.byId.set(claim.id, claim);
    this.list.push(claim);
    return claim.id;
  }
}

function tituloDe(post: PerfilPostInput): string {
  const t = (post.title && post.title.trim()) || firstLine(post.caption);
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

const EJE_SLUG: Record<WhyAxis, string> = { hook: 'gancho', piece: 'pieza', content: 'contenido', duration: 'duracion' };

// ---------------------------------------------------------------------
// 5 · El cálculo
// ---------------------------------------------------------------------

/** El código de un post en cada eje del porqué; null si no se puede decir (sin duración). */
const EJES: Record<WhyAxis, (p: PerfilPostInput) => string | null> = {
  hook: (p) => hookFromAnalysis(p.hookType) ?? hookOf(p.title, p.caption),
  piece: (p) => pieceOf(p.platformId, p.surface, p.mediaType),
  content: (p) => contentOf(p.title, p.caption, p.isBrandedContent),
  duration: (p) => durationBucketOf(p.durationS),
};

/**
 * Arma el perfil comercial a partir de las filas. Determinista: las
 * mismas entradas dan el mismo perfil, con los mismos ids de claim.
 */
export function buildPerfil(input: PerfilInputs): PerfilComercial {
  const claims = new ClaimSet();
  const creatorId = input.creator.id;
  const porRed = <T extends { platformId: PlatformId }>(a: T, b: T) =>
    PLATFORM_ORDER.indexOf(a.platformId) - PLATFORM_ORDER.indexOf(b.platformId);

  // Identidad: una línea por cuenta conectada, con sus seguidores. Solo
  // cuentan las que siguen autenticadas (CONNECTED_STATUSES): una revocada
  // o caducada no es una red «conectada», y sus seguidores son de otro día.
  // Un creador puede tener dos cuentas en la misma red (social_connection
  // solo es única por red y cuenta externa): la de más seguidores lleva el
  // id corto `seguidores-<red>` y las demás el de su cuenta, igual que las
  // medianas de otra línea base.
  const conectadas = input.connections.filter((c) => CONNECTED_STATUSES.includes(c.status));
  const ordenadas = [...conectadas].sort((a, b) => porRed(a, b) || (b.followers ?? -1) - (a.followers ?? -1) || a.id.localeCompare(b.id));
  const conId = new Set<PlatformId>();
  const idSeguidores = (c: PerfilConnectionInput): string => {
    if (conId.has(c.platformId)) return `seguidores-${c.platformId}-${shortId(c.id)}`;
    conId.add(c.platformId);
    return `seguidores-${c.platformId}`;
  };
  const networks: NetworkLine[] = ordenadas.map((c) => ({
    platformId: c.platformId,
    handle: c.handle,
    followersDay: c.followersDay,
    followersClaimId:
      c.followers !== null && c.followersSnapshotId
        ? claims.add({
            id: idSeguidores(c),
            kind: 'count',
            key: 'followers',
            params: { platform: c.platformId },
            value: c.followers,
            unit: 'seguidores',
            source: { table: 'account_metric_snapshot', id: c.followersSnapshotId, field: 'followers', asOf: c.followersDay },
          })
        : null,
  }));

  // Audiencia de la red principal: la de más seguidores con demografía.
  const conDemografia = new Set(input.audience.map((a) => a.connectionId));
  const principal = conectadas
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
            key: dim === 'age' ? 'audience.age' : dim === 'gender' ? 'audience.gender' : 'audience.country',
            params: { platform: principal.platformId, bucket: a.bucket },
            value: a.share!,
            unit: 'pct',
            source: { table: 'audience_breakdown', id: a.id, field: 'share', asOf: a.day },
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
        key: 'non_followers',
        params: { platform: n.platformId },
        value: n.medianShare!,
        unit: 'pct',
        source: { table: 'post_metrics_latest', id: creatorId, field: 'non_follower_share', rows: n.postIds, asOf: n.asOf },
      }),
    }));

  // Desempeño: la mediana por red, cada una con su corte.
  const filasDeBase = (id: string): { rows?: string[] } => {
    const rows = input.baselinePosts?.[id];
    return rows && rows.length > 0 ? { rows: [...rows] } : {};
  };
  const conMediana = input.baselines.filter((b) => b.medianViews !== null).sort(porRed);
  const medianaDeRed = new Map(conMediana.map((b) => [b.platformId, b.id]));
  const medians: MedianLine[] = conMediana.map((b) => ({
    platformId: b.platformId,
    cutHours: b.ageHoursCut,
    sampleSize: b.sampleSize,
    isReliable: b.isReliable,
    claimId: claims.add({
      id: `mediana-${b.platformId}`,
      kind: 'count',
      key: 'median',
      params: { platform: b.platformId, cutHours: b.ageHoursCut },
      value: Math.round(b.medianViews!),
      unit: 'views',
      source: {
        table: 'creator_baseline', id: b.id, field: 'median_views', asOf: b.computedAt,
        ...filasDeBase(b.id),
      },
    }),
  }));

  const puntuados = (input.scoredPosts ?? input.posts).filter((p) => p.score && p.score.viewsVsMedian !== null);
  const scoredClaimId = puntuados.length
    ? claims.add({
        id: 'videos-con-puntaje',
        kind: 'count',
        key: 'scored_videos',
        params: {},
        value: puntuados.length,
        unit: 'videos',
        source: { table: 'post_score', id: creatorId, field: 'views_vs_median', rows: puntuados.map((p) => p.id) },
      })
    : null;

  // El porqué: en cada eje, el rasgo del video contra los OTROS videos
  // (whyContrast deja fuera al que se explica). Cada razón tiene sus
  // propias medianas, así que sus claims llevan el id corto del video.
  const itemsDe = new Map(
    WHY_AXES.map((eje) => [eje, puntuados.map((p) => ({ id: p.id, key: EJES[eje](p), x: p.score!.viewsVsMedian! }))] as const),
  );
  const razonesDe = (p: PerfilPostInput): WhyReason[] => {
    const s = shortId(p.id);
    const src = (rows: string[]): ClaimSource => ({ table: 'post_score', id: creatorId, field: 'views_vs_median', rows });
    return WHY_AXES.flatMap((eje) => {
      const g = whyContrast(itemsDe.get(eje)!, p.id, EJES[eje](p), { exclude: eje === 'content' ? ['otro'] : [] });
      return g ? [{ eje, g }] : [];
    })
      // La más fuerte primero; a igual contraste, el orden de los ejes.
      .sort((a, b) => b.g.lift - a.g.lift || WHY_AXES.indexOf(a.eje) - WHY_AXES.indexOf(b.eje))
      .slice(0, WHY_MAX_REASONS)
      .map(({ eje, g }) => {
        const base = `porque-${s}-${EJE_SLUG[eje]}-${claimSlug(g.key)}`;
        const params: ClaimParams = { axis: eje, group: g.key, title: tituloDe(p) };
        return {
          axis: eje,
          group: g.key,
          groupClaimId: claims.add({ id: base, kind: 'multiple', key: 'why.group', params, value: g.median, unit: 'x', source: src(g.ids) }),
          restClaimId: claims.add({ id: `${base}-resto`, kind: 'multiple', key: 'why.rest', params, value: g.restMedian, unit: 'x', source: src(g.restIds) }),
        };
      });
  };

  const duracionTipica = new Map<PlatformId, number | null>();
  for (const p of PLATFORM_ORDER) {
    duracionTipica.set(p, medianOrNull(input.posts.filter((x) => x.platformId === p && x.durationS !== null).map((x) => x.durationS!)));
  }
  // Se ordena por «veces su mediana»: cada puntaje está medido contra la
  // línea base de su red en SU corte, así que es una razón comparable
  // entre cortes; las views crudas no lo son, y por eso cada video dice
  // su corte y la mediana contra la que se midió (baselineClaimId).
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
      const hookAnalisis = hookFromAnalysis(p.hookType);
      const asOf = score.computedAt ?? null;
      const bl = score.baseline ?? null;
      return {
        postId: p.id,
        platformId: p.platformId,
        url: webUrlOrNull(p.url),
        coverUrl: coverSrcOrNull(p.coverUrl),
        title: titulo,
        publishedAt: p.publishedAt,
        outlierTier: score.outlierTier,
        cutHours: score.ageHoursCut,
        multipleClaimId: claims.add({
          id: `video-${s}-x`,
          kind: 'multiple',
          key: 'video.multiple',
          params: { platform: p.platformId, title: titulo, cutHours: score.ageHoursCut },
          value: score.viewsVsMedian!,
          unit: 'x',
          source: { table: 'post_score', id: p.id, field: 'views_vs_median', url: p.url, asOf },
        }),
        viewsClaimId:
          score.viewsAtCut !== null
            ? claims.add({
                id: `video-${s}-views`,
                kind: 'count',
                key: 'video.views',
                params: { platform: p.platformId, title: titulo, cutHours: score.ageHoursCut },
                value: score.viewsAtCut,
                unit: 'views',
                source: { table: 'post_score', id: p.id, field: 'views_at_cut', url: p.url, asOf },
              })
            : null,
        baselineClaimId:
          bl && bl.medianViews !== null
            ? claims.add({
                // La misma fila que la mediana de la red: el mismo claim.
                id: medianaDeRed.get(p.platformId) === bl.id ? `mediana-${p.platformId}` : `mediana-${p.platformId}-${shortId(bl.id)}`,
                kind: 'count',
                key: 'median',
                params: { platform: p.platformId, cutHours: bl.ageHoursCut },
                value: Math.round(bl.medianViews),
                unit: 'views',
                source: { table: 'creator_baseline', id: bl.id, field: 'median_views', asOf: bl.computedAt, ...filasDeBase(bl.id) },
              })
            : null,
        durationClaimId:
          p.durationS !== null
            ? claims.add({
                id: `video-${s}-duracion`,
                kind: 'duration',
                key: 'video.duration',
                params: { platform: p.platformId, title: titulo },
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
          reasons: razonesDe(p),
        },
      } satisfies TopVideo;
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
    posts: postsCitados(input, claims.list),
  };
}

/**
 * El índice de los posts que forman algún agregado (source.rows), en el
 * orden de las entradas (los más recientes primero). Los que no están
 * entre los posts leídos (una mediana de no seguidores que abarca uno
 * más viejo) no se inventan: la pantalla los cuenta sin enlazarlos.
 */
function postsCitados(input: PerfilInputs, claims: readonly Claim[]): PostRef[] {
  const citados = new Set(claims.flatMap((c) => c.source.rows ?? []));
  // Los recientes y, después, los puntuados más viejos: cada post una vez.
  const todos = new Map<string, PerfilPostInput>();
  for (const p of [...input.posts, ...(input.scoredPosts ?? [])]) if (!todos.has(p.id)) todos.set(p.id, p);
  return [...todos.values()]
    .filter((p) => citados.has(p.id))
    .map((p) => ({ postId: p.id, platformId: p.platformId, title: tituloDe(p), url: webUrlOrNull(p.url) }));
}

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
      key: 'format.piece',
      params: { piece: key },
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
        key: 'format.content',
        params: { content: key },
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
        key: 'tone',
        params: { trait: key },
        value: ids.length / conCaption.length,
        unit: 'pct',
        source: { table: 'post', id: creatorId, field: 'caption', rows: ids },
      }),
    }));
  const captionsClaimId = conCaption.length
    ? claims.add({
        id: 'captions-leidos',
        kind: 'count',
        key: 'captions_read',
        params: {},
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
    const params: ClaimParams = { company: c.companyName };
    const src = (field: string): ClaimSource => ({ table: 'campaign_result', id: c.id, field, asOf: r.computedAt ?? null });
    const ids: string[] = [];
    if (r.views !== null) {
      ids.push(claims.add({ id: `campana-${s}-views`, kind: 'count', key: 'campaign.views', params, value: r.views, unit: 'views', source: src('views') }));
    }
    if (r.viewsVsMedian !== null) {
      ids.push(claims.add({ id: `campana-${s}-x`, kind: 'multiple', key: 'campaign.multiple', params, value: r.viewsVsMedian, unit: 'x', source: src('views_vs_median') }));
    }
    if (r.brandFollowersGained !== null) {
      ids.push(claims.add({ id: `campana-${s}-seguidores-marca`, kind: 'count', key: 'campaign.brand_followers', params, value: r.brandFollowersGained, unit: 'seguidores', source: src('brand_followers_gained') }));
    }
    if (r.codeRedemptions !== null) {
      ids.push(claims.add({ id: `campana-${s}-canjes`, kind: 'count', key: 'campaign.redemptions', params, value: r.codeRedemptions, unit: 'canjes', source: src('code_redemptions') }));
    }
    if (r.attributedRevenue !== null && r.currency) {
      ids.push(claims.add({ id: `campana-${s}-ingresos`, kind: 'money', key: 'campaign.revenue', params, value: r.attributedRevenue, unit: r.currency, source: src('attributed_revenue') }));
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
    const params: ClaimParams = { item: i.labelEs, ...(i.platformId ? { platform: i.platformId } : {}) };
    const src = (field: string): ClaimSource => ({ table: 'rate_card_item', id: i.id, field, asOf: card.computedAt });
    return {
      itemId: i.id,
      label: i.labelEs,
      platformId: i.platformId,
      lowClaimId:
        i.priceLow !== null
          ? claims.add({ id: `tarifa-${s}-desde`, kind: 'money', key: 'rate.low', params, value: i.priceLow, unit: card.currency, source: src('price_low') })
          : null,
      highClaimId:
        i.priceHigh !== null
          ? claims.add({ id: `tarifa-${s}-hasta`, kind: 'money', key: 'rate.high', params, value: i.priceHigh, unit: card.currency, source: src('price_high') })
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
