/**
 * TikTok por @ con un proveedor de datos de pago: EnsembleData (CON-12).
 *
 * Es el único camino que deja seguidores y videos de un @ de TikTok sin
 * que el dueño autorice nada: la plataforma no publica nada de eso por
 * un endpoint oficial (CON-10 §0.1), y raspar el HTML falla desde
 * servidor y va contra sus términos.
 *
 * Endpoints (documentación leída el 23-sep-2026, ensembledata.com/apis/docs
 * y ensembledata.com/guide):
 *   GET {base}/tt/user/info?username=&token=              1 unidad
 *       → { data: { user: { uniqueId, secUid, nickname, avatarLarger,
 *                           signature, verified, … },
 *                   stats: { followerCount, followingCount,
 *                            heartCount, videoCount, diggCount } } }
 *   GET {base}/tt/user/posts?username=&depth=&cursor=&token=   1 unidad por
 *       cada 10 publicaciones (`depth` = número de bloques de 10)
 *       → { data: [ { aweme_id, desc, create_time,
 *                     statistics: { play_count, digg_count,
 *                                   comment_count, share_count } } ],
 *           nextCursor }
 *
 * El proveedor autentica por query (`token`). El núcleo nunca guarda la
 * URL en `api_call_log`, el token entra en `secrets` para que
 * `safeErrorMessage` lo borre de cualquier mensaje, y `FixtureFetch` lo
 * tapa al grabar.
 *
 * La lectura de la cuenta es UNA llamada (`tt/user/info`, 1 unidad):
 * seguidores, seguidos y número de videos. TikTok no publica vistas de
 * una cuenta, y `account_metric_snapshot.views` son las vistas DEL DÍA
 * (Resumen las suma por día), así que van en null: las vistas llegan
 * video por video por `createTikTokAggregatorPostSource` (CON-5). Hasta
 * el cierre CON-C esta lectura sumaba el `play_count` de todo el
 * catálogo —hasta 21 unidades por cuenta y día— para guardar un
 * acumulado que Resumen habría contado una vez por día.
 *
 * Costo y planes: docs/propuestas/CON-12.md §0.2.
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import { isPlatformApiError } from '../http/errors.ts';
import { emptyPostMetrics, type ConnectorResult, type NormalizedVideo, type Page } from '../normalize/types.ts';
import { asArray, asRecord, boolOrNull, dateFromUnixS, extractHashtags, extractMentions, intOrNull, strOrNull } from '../normalize/values.ts';
import { assertHandle, PublicLookupError, type PublicProfile, type PublicProfileSource } from './types.ts';

export const ENSEMBLEDATA_TOKEN_ENV = 'ENSEMBLEDATA_TOKEN';
export const ENSEMBLEDATA_MAX_POSTS_ENV = 'ENSEMBLEDATA_MAX_POSTS';
export const ENSEMBLEDATA_BASE_URL = 'https://ensembledata.com/apis';

/** El proveedor entrega la lista de publicaciones en bloques de diez, y cobra una unidad por bloque. */
export const ENSEMBLEDATA_POSTS_PER_CHUNK = 10;
/**
 * Cuántas publicaciones se recorren como mucho al MEDIR (collect.post_
 * metrics vuelve a listar para emparejar, porque el proveedor no deja
 * preguntar por un video suelto). 200 son hasta 20 unidades por cuenta y
 * corrida. DECISIÓN PENDIENTE DE NICOLÁS (CON-12 §0.4, cierre CON-C D13):
 * se cambia con ENSEMBLEDATA_MAX_POSTS.
 */
export const ENSEMBLEDATA_DEFAULT_MAX_POSTS = 200;
/** Bloques por llamada: 5 = 50 publicaciones. Paginar de verdad deja respetar la señal entre llamadas. */
export const ENSEMBLEDATA_MAX_DEPTH_PER_CALL = 5;

/**
 * Códigos propios del proveedor, que viajan como estado HTTP (su SDK los
 * declara así: github.com/ensembledata/ensembledata-python errors.py).
 * Se traducen a un código con prefijo `ed_` para que el clasificador de
 * http/errors.ts no los confunda con los códigos de la API de TikTok.
 */
export const ENSEMBLEDATA_STATUS_CODES: Readonly<Record<number, string>> = {
  404: 'ed_not_found',
  422: 'ed_validation_error',
  429: 'ed_rate_limit',
  462: 'ed_invalid_tiktok_url',
  463: 'ed_invalid_user',
  464: 'ed_max_post_ids',
  469: 'ed_topic_restricted',
  471: 'ed_user_restricted',
  472: 'ed_private_user',
  473: 'ed_user_not_found',
  474: 'ed_profile_unavailable',
  491: 'ed_invalid_token',
  492: 'ed_unverified_email',
  493: 'ed_subscription_expired',
  495: 'ed_units_depleted',
  500: 'ed_internal_error',
  520: 'ed_post_restricted',
};

export function parseEnsembleDataError(status: number, body: unknown): ParsedApiError | null {
  if (status < 400) return null;
  const b = asRecord(body);
  return { code: ENSEMBLEDATA_STATUS_CODES[status] ?? `http_${status}`, message: strOrNull(b['detail']) ?? undefined };
}

export interface EnsembleDataOptions {
  baseUrl?: string;
}

/** Lo que el proveedor dice del perfil. `followers` null significa que cambió de forma, no que sean cero. */
export interface EnsembleDataProfile {
  uniqueId: string;
  secUid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  verified: boolean | null;
  followers: number | null;
  following: number | null;
  videoCount: number | null;
}

export class EnsembleDataClient {
  readonly platformId = 'tiktok' as const;
  readonly #core: HttpCore;
  readonly #token: string;
  readonly #base: string;

  constructor(core: HttpCore, token: string, opts: EnsembleDataOptions = {}) {
    this.#core = core;
    this.#token = token;
    this.#base = opts.baseUrl ?? ENSEMBLEDATA_BASE_URL;
  }

  async userInfo(username: string, opts: { signal?: AbortSignal } = {}): Promise<ConnectorResult<EnsembleDataProfile>> {
    const res = await this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'ensembledata', endpoint: 'ensembledata.tt.user.info', method: 'GET',
      url: `${this.#base}/tt/user/info`, query: { username, token: this.#token },
      connectionId: null, tokens: null, authStyle: 'none', secrets: [this.#token],
      signal: opts.signal, parseError: parseEnsembleDataError,
    });
    return { data: normalizeEnsembleDataProfile(res.body, username), raw: res.body };
  }

  /** Un tramo del catálogo, del más reciente al más antiguo. `depth` son bloques de diez, y cuesta una unidad cada uno. */
  async userPosts(username: string, opts: { cursor?: string | null; depth?: number; signal?: AbortSignal } = {}): Promise<ConnectorResult<Page<NormalizedVideo>>> {
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), ENSEMBLEDATA_MAX_DEPTH_PER_CALL);
    const res = await this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'ensembledata', endpoint: 'ensembledata.tt.user.posts', method: 'GET',
      url: `${this.#base}/tt/user/posts`,
      query: { username, depth, token: this.#token, cursor: opts.cursor ?? undefined },
      connectionId: null, tokens: null, authStyle: 'none', secrets: [this.#token],
      // Una unidad por bloque de diez: se declara para que el presupuesto diario cuente lo que de verdad se gasta.
      units: depth,
      signal: opts.signal, parseError: parseEnsembleDataError,
    });
    return { data: normalizeEnsembleDataPosts(res.body), raw: res.body };
  }
}

/**
 * Parseo tolerante en lo accesorio, estricto en lo que sostiene una
 * cifra: si no hay `uniqueId`, la respuesta no identifica a nadie y no
 * se puede dar de alta una cuenta con ella. Los campos extra que el
 * proveedor agregue se ignoran solos.
 */
export function normalizeEnsembleDataProfile(body: unknown, username: string): EnsembleDataProfile {
  const data = asRecord(asRecord(body)['data']);
  // Algunas respuestas anidan en data.user; otras dejan el perfil plano.
  const user = Object.keys(asRecord(data['user'])).length > 0 ? asRecord(data['user']) : data;
  const stats = Object.keys(asRecord(data['stats'])).length > 0 ? asRecord(data['stats']) : asRecord(user['stats']);
  const uniqueId = strOrNull(user['uniqueId']) ?? strOrNull(user['unique_id']);
  if (uniqueId === null) throw shapeChanged(username, 'el perfil no trae uniqueId');
  return {
    uniqueId,
    secUid: strOrNull(user['secUid']) ?? strOrNull(user['sec_uid']),
    nickname: strOrNull(user['nickname']),
    avatarUrl: strOrNull(user['avatarLarger']) ?? strOrNull(user['avatarMedium']) ?? strOrNull(user['avatarThumb']),
    verified: boolOrNull(user['verified']),
    followers: intOrNull(stats['followerCount']) ?? intOrNull(stats['follower_count']),
    following: intOrNull(stats['followingCount']) ?? intOrNull(stats['following_count']),
    videoCount: intOrNull(stats['videoCount']) ?? intOrNull(stats['video_count']),
  };
}

/** La lista llega como `data` (arreglo) o anidada en `data.posts` / `data.data`, con el cursor arriba o dentro. */
export function normalizeEnsembleDataPosts(body: unknown): Page<NormalizedVideo> {
  const root = asRecord(body);
  const data = root['data'];
  const holder = asRecord(data);
  const items = Array.isArray(data) ? data : asArray(holder['posts']).length > 0 ? asArray(holder['posts']) : asArray(holder['data']);
  const cursor = strOrNull(root['nextCursor']) ?? strOrNull(holder['nextCursor']) ?? numericCursor(root['nextCursor']) ?? numericCursor(holder['nextCursor']);
  return { items: items.map((v) => normalizeEnsembleDataVideo(asRecord(v))), cursor, hasMore: cursor !== null };
}

function numericCursor(v: unknown): string | null {
  const n = intOrNull(v);
  return n === null || n === 0 ? null : String(n);
}

export function normalizeEnsembleDataVideo(v: Record<string, unknown>): NormalizedVideo {
  const caption = strOrNull(v['desc']);
  const stats = asRecord(v['statistics']);
  const video = asRecord(v['video']);
  const author = asRecord(v['author']);
  const metrics = emptyPostMetrics();
  metrics.views = intOrNull(stats['play_count']);
  metrics.likes = intOrNull(stats['digg_count']);
  metrics.comments = intOrNull(stats['comment_count']);
  metrics.shares = intOrNull(stats['share_count']);
  const id = strOrNull(v['aweme_id']) ?? strOrNull(v['id']) ?? '';
  const handle = strOrNull(author['unique_id']) ?? strOrNull(author['uniqueId']);
  return {
    post: {
      external_post_id: id,
      url: handle && id ? `https://www.tiktok.com/@${handle}/video/${id}` : null,
      permalink: id ? `https://www.tiktok.com/embed/v2/${id}` : null,
      cover_url: strOrNull(asArray(asRecord(video['cover'])['url_list'])[0]) ?? strOrNull(video['cover']),
      media_type: 'video',
      surface: 'feed',
      caption,
      title: null,
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      duration_s: durationSeconds(video),
      width: intOrNull(video['width']),
      height: intOrNull(video['height']),
      audio_type: null,
      audio_external_id: strOrNull(asRecord(v['music'])['id']),
      is_ai_generated: null,
      is_branded_content: null,
      published_at: dateFromUnixS(v['create_time']),
    },
    metrics,
    raw: v,
  };
}

/**
 * `video.duration` del objeto aweme de TikTok viene en MILISEGUNDOS. No
 * se adivina por el tamaño del número: un umbral convertiría un video de
 * media hora en dos segundos. Si el proveedor cambiara la unidad, se ve
 * al regrabar el fixture (CON-12 §3).
 */
function durationSeconds(video: Record<string, unknown>): number | null {
  const ms = intOrNull(video['duration']);
  return ms === null ? null : Math.round(ms / 1000);
}

function shapeChanged(handle: string, detalle: string): PublicLookupError {
  return new PublicLookupError(
    'not_discoverable',
    `El proveedor de datos de TikTok respondió en un formato que no reconocemos (${detalle}) al leer @${handle}. No guardamos cifras a medias: hay que revisar el conector.`,
  );
}

// ---------------------------------------------------------------------
// La fuente
// ---------------------------------------------------------------------

export const TIKTOK_AGGREGATOR_LABEL = 'EnsembleData (proveedor de TikTok)';

export function readMaxPosts(env: Readonly<Record<string, string | undefined>>): number {
  const raw = intOrNull(env[ENSEMBLEDATA_MAX_POSTS_ENV]?.trim());
  return raw !== null && raw > 0 ? raw : ENSEMBLEDATA_DEFAULT_MAX_POSTS;
}

/** null cuando falta el token: sin proveedor contratado, TikTok se queda con el oEmbed de CON-10. */
export function createTikTokAggregatorSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>, opts: EnsembleDataOptions = {}): PublicProfileSource | null {
  const token = env[ENSEMBLEDATA_TOKEN_ENV]?.trim();
  if (!token) return null;
  const client = new EnsembleDataClient(core, token, opts);

  return {
    platformId: 'tiktok',
    label: TIKTOK_AGGREGATOR_LABEL,
    missing: [],
    accessMode: 'aggregator',

    async lookup(handle, o = {}) {
      const clean = assertHandle('tiktok', handle);
      let profile: ConnectorResult<EnsembleDataProfile>;
      try {
        profile = await client.userInfo(clean, { signal: o.signal });
      } catch (err) {
        throw toAggregatorLookupError(err, clean);
      }
      const p = profile.data;
      if (p.followers === null) throw shapeChanged(clean, 'el perfil no trae followerCount');

      return {
        platformId: 'tiktok',
        profile: {
          // El @ y no el secUid, a propósito: es el mismo id externo que usa
          // el oEmbed de CON-10, así contratar el proveedor convierte la
          // fila que ya existe en vez de crear una cuenta duplicada. El
          // secUid queda en `raw`.
          external_account_id: p.uniqueId,
          handle: p.uniqueId,
          display_name: p.nickname,
          avatar_url: p.avatarUrl,
          profile_url: `https://www.tiktok.com/@${p.uniqueId}`,
          account_type: p.verified === true ? 'creator' : 'unknown',
        },
        metrics: { followers: p.followers, following: p.following, mediaCount: p.videoCount, views: null },
        metricsNote: AGGREGATOR_METRICS_NOTE_ES,
        source: 'ensembledata.tt.user.info',
        raw: profile.raw,
      } satisfies PublicProfile;
    },
  };
}

export const AGGREGATOR_METRICS_NOTE_ES =
  'Seguidores, seguidos y número de videos por el proveedor de datos. TikTok no publica vistas de una cuenta: llegan video por video.';

/**
 * Cada código del proveedor tiene su frase: quien lee la pantalla
 * necesita distinguir «esta cuenta no existe» de «se acabó el plan».
 */
export function toAggregatorLookupError(err: unknown, handle: string): PublicLookupError {
  if (err instanceof PublicLookupError) return err;
  if (!isPlatformApiError(err)) {
    return new PublicLookupError('transient', 'El proveedor de datos de TikTok no respondió; inténtalo de nuevo en unos minutos.', { cause: err });
  }
  switch (err.code) {
    case 'ed_invalid_token':
    case 'ed_unverified_email':
      return new PublicLookupError('not_configured', `El proveedor de datos de TikTok rechazó la credencial de On Cue; hay que revisar ${ENSEMBLEDATA_TOKEN_ENV}.`, { cause: err });
    case 'ed_validation_error':
      // Comprobado en vivo el 23-sep: un token que no mide 16 caracteres sale
      // por aquí, no por 491. Nuestras llamadas solo mandan username (ya
      // validado por assertHandle), depth, cursor y token, así que un 422
      // señala la credencial casi siempre.
      return new PublicLookupError('not_configured', `El proveedor de datos de TikTok rechazó la petición por un parámetro inválido; lo más probable es que ${ENSEMBLEDATA_TOKEN_ENV} esté mal copiado (su token tiene 16 caracteres).`, { cause: err });
    case 'ed_subscription_expired':
      return new PublicLookupError('not_configured', 'La suscripción con el proveedor de datos de TikTok está vencida; hay que renovarla para volver a leer cifras.', { cause: err });
    case 'ed_units_depleted':
      return new PublicLookupError('not_configured', 'Se agotaron las unidades del día del proveedor de datos de TikTok. Mañana se vuelve a leer, o se sube el plan.', { cause: err });
    case 'ed_not_found':
    case 'ed_user_not_found':
    case 'ed_invalid_user':
    case 'ed_invalid_tiktok_url':
      return new PublicLookupError('not_found', `No encontramos @${handle} en TikTok. Revisa que esté bien escrito y que la cuenta siga existiendo.`, { cause: err });
    case 'ed_private_user':
    case 'ed_user_restricted':
    case 'ed_profile_unavailable':
      return new PublicLookupError('not_discoverable', `TikTok no deja leer @${handle}: la cuenta es privada o está restringida.`, { cause: err });
    default:
      break;
  }
  // Un 401/403 del proveedor que no es uno de sus códigos es NUESTRA
  // credencial, nunca la del creador: nadie autorizó nada en una cuenta por
  // @, así que no puede acabar en needs_reauth (revisión del cierre CON-C).
  if (err.kind === 'auth') {
    return new PublicLookupError('not_configured', `El proveedor de datos de TikTok rechazó la credencial de On Cue (${err.code}); hay que revisar ${ENSEMBLEDATA_TOKEN_ENV}.`, { cause: err });
  }
  if (err.kind === 'permanent') {
    return new PublicLookupError('not_discoverable', `El proveedor de datos de TikTok rechazó la consulta de @${handle} (${err.code}).`, { cause: err });
  }
  return new PublicLookupError('transient', 'El proveedor de datos de TikTok no respondió; inténtalo de nuevo en unos minutos.', { cause: err });
}
