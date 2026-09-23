/**
 * Cotizar · COT-2, el media kit congelado y su enlace.
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import type { Decimal, PlatformId } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { WORKSPACE_DEFAULTS } from '../cimientos.ts';
import { hashSharePassword, nuevoSlug } from './enlace.ts';
import { CotizarError, MediaKitNotFound } from './errores.ts';
import { CORTE_TARIFARIO_HORAS, getCurrentRateCard } from './tarifario.ts';

// ---------------------------------------------------------------------
// COT-2 · Media kit
// ---------------------------------------------------------------------

export interface MediaKitSnapshotRed {
  platformId: PlatformId;
  handle: string | null;
  followers: number | null;
  /** Día de la última lectura de seguidores. */
  followersAsOf: string | null;
  medianViews: number | null;
  engagement: string | null;
  sampleSize: number | null;
  isReliable: boolean;
}

export interface MediaKitSnapshotPost {
  platformId: PlatformId;
  url: string | null;
  caption: string | null;
  publishedAt: string;
  views: number | null;
  viewsVsMedian: string | null;
}

export interface MediaKitSnapshotTarifa {
  labelEs: string;
  platformId: PlatformId | null;
  priceLow: Decimal | null;
  priceHigh: Decimal | null;
}

/**
 * La audiencia de UNA red y UNA dimensión («Edad · Instagram»). Mezclar
 * cuentas y dimensiones en una sola lista dejaba pastillas repetidas y
 * sin contexto («25-34 · 40 %» tres veces).
 */
export interface MediaKitSnapshotAudiencia {
  platformId: PlatformId;
  /** 'age' | 'gender' | 'country' | … Tal cual la guarda audience_breakdown. */
  dimension: string;
  buckets: { bucket: string; share: string | null }[];
}

export interface MediaKitSnapshot {
  /** 2 desde que la audiencia va agrupada por red y dimensión. */
  version: 2;
  /** Cuándo se congeló. Lo que se enseña como «datos hasta…». */
  capturedAt: string;
  creator: { displayName: string; handle: string | null; bio: string | null; country: string | null; nicheSlugs: string[] };
  /** Moneda, locale y zona del workspace, congelados: la página pública no tiene workspace que consultar. */
  currency: string;
  locale: string;
  timezone: string;
  redes: MediaKitSnapshotRed[];
  /**
   * Las cifras grandes de la cabecera, calculadas en SQL. `medianViewsMax`
   * es la mediana de la MEJOR red, no una mediana del creador: por eso
   * viaja con `medianViewsMaxPlatform`, y la página la rotula con esa red
   * («Views medianas · mejor red» + TikTok). Los media kits generados
   * antes no traen la red y no enseñan esa cifra en la cabecera (sí en
   * la lista por red).
   */
  totales: { followers: number | null; medianViewsMax: number | null; medianViewsMaxPlatform?: PlatformId | null };
  topPosts: MediaKitSnapshotPost[];
  /** De la red con más seguidores que tenga demografía; una entrada por dimensión. */
  audiencia: MediaKitSnapshotAudiencia[];
  tarifas: MediaKitSnapshotTarifa[];
  /**
   * Los modificadores que los rangos de `tarifas` ya llevan dentro
   * (derechos de uso, exclusividad…), en el orden del tarifario. La
   * página los dice debajo de las tarifas: un rango que incluye
   * exclusividad sin decirlo se lee como el precio de una pieza suelta.
   * Opcional: los media kits generados antes no lo traen.
   */
  tarifasIncluyen?: string[];
}

/**
 * Congela los números del creador AHORA. Lo que se guarda es lo que la
 * marca verá dentro de tres meses: un media kit que cambia solo no se
 * puede citar en una negociación.
 */
export async function buildMediaKitSnapshot(tx: WorkspaceTx, creatorId: string): Promise<MediaKitSnapshot> {
  if (!isUuid(creatorId)) throw new CotizarError('CreatorNotFound', 'Ese creador no existe en este espacio de trabajo.');
  const { rows: creadores } = await tx.query<{
    display_name: string; handle: string | null; bio: string | null; country: string | null; niche_slugs: string[];
  }>('SELECT display_name, handle, bio, country, niche_slugs FROM creator_profile WHERE id = $1', [creatorId]);
  const creador = creadores[0];
  if (!creador) throw new CotizarError('CreatorNotFound', 'Ese creador no existe en este espacio de trabajo.');

  const { rows: ws } = await tx.query<{ currency: string; locale: string; timezone: string }>(
    'SELECT currency, locale, timezone FROM workspace WHERE id = $1',
    [tx.workspaceId],
  );

  // Seguidores: la última lectura de cada cuenta conectada.
  const { rows: redes } = await tx.query<{
    platform_id: PlatformId; handle: string | null; followers: string | null; day: string | null;
  }>(
    `SELECT DISTINCT ON (c.platform_id)
            c.platform_id, c.handle, s.followers, to_char(s.day, 'YYYY-MM-DD') AS day
       FROM social_connection c
       LEFT JOIN account_metric_snapshot s ON s.connection_id = c.id
      WHERE c.creator_id = $1
      ORDER BY c.platform_id, s.day DESC NULLS LAST`,
    [creatorId],
  );

  const { rows: baselines } = await tx.query<{
    platform_id: PlatformId; median_views: string | null; median_engagement: string | null;
    sample_size: number; is_reliable: boolean;
  }>(
    `SELECT DISTINCT ON (platform_id) platform_id, median_views, median_engagement, sample_size, is_reliable
       FROM creator_baseline
      WHERE creator_id = $1
      ORDER BY platform_id, (age_hours_cut = $2) DESC, age_hours_cut DESC, computed_at DESC`,
    [creatorId, CORTE_TARIFARIO_HORAS],
  );
  const porRed = new Map(baselines.map((b) => [b.platform_id, b]));

  // El «N× su mediana» de cada post se calcula AQUÍ, contra la misma
  // línea base que el media kit publica en la lista por red (el corte
  // del tarifario, la mediana redondeada que se enseña). No sale de
  // post_score.views_vs_median: esa se calculó contra la base vigente
  // cuando se puntuó el post, y una marca que dividiera las dos cifras
  // de la página encontraría otro número.
  const { rows: posts } = await tx.query<{
    platform_id: PlatformId; url: string | null; caption: string | null;
    published_at: string; views: string | null; views_vs_median: string | null;
  }>(
    `WITH base AS (
       SELECT DISTINCT ON (platform_id) platform_id, round(median_views) AS median_views
         FROM creator_baseline
        WHERE creator_id = $1
        ORDER BY platform_id, (age_hours_cut = $2) DESC, age_hours_cut DESC, computed_at DESC
     )
     SELECT p.platform_id, p.url, p.caption, p.published_at, p.views,
            round(p.views / NULLIF(b.median_views, 0), 1)::text AS views_vs_median
       FROM creator_post_board p
       LEFT JOIN base b USING (platform_id)
      WHERE p.creator_id = $1 AND p.views IS NOT NULL
      ORDER BY p.views DESC
      LIMIT 6`,
    [creatorId, CORTE_TARIFARIO_HORAS],
  );

  // La audiencia de la red principal (la de más seguidores que tenga
  // demografía), su último día, una fila por dimensión y segmento. La
  // edad va en orden de edad; el resto, de mayor a menor.
  const { rows: audiencia } = await tx.query<{
    platform_id: PlatformId; dimension: string; bucket: string; share: string | null;
  }>(
    `WITH principal AS (
       SELECT c.id, c.platform_id
         FROM social_connection c
         LEFT JOIN LATERAL (
           SELECT s.followers FROM account_metric_snapshot s
            WHERE s.connection_id = c.id ORDER BY s.day DESC LIMIT 1
         ) f ON true
        WHERE c.creator_id = $1
          AND EXISTS (SELECT 1 FROM audience_breakdown a
                       WHERE a.connection_id = c.id AND a.scope = 'account' AND a.population = 'followers')
        ORDER BY f.followers DESC NULLS LAST, c.platform_id
        LIMIT 1
     ), ultimo AS (
       SELECT DISTINCT ON (a.dimension, a.bucket) p.platform_id, a.dimension, a.bucket, a.share
         FROM principal p
         JOIN audience_breakdown a
           ON a.connection_id = p.id AND a.scope = 'account' AND a.population = 'followers'
        WHERE a.day = (SELECT max(b.day) FROM audience_breakdown b
                        WHERE b.connection_id = p.id AND b.scope = 'account' AND b.population = 'followers')
        ORDER BY a.dimension, a.bucket, a.captured_at DESC
     )
     SELECT platform_id, dimension, bucket, share
       FROM ultimo
      ORDER BY CASE dimension WHEN 'age' THEN 1 WHEN 'gender' THEN 2 WHEN 'country' THEN 3 ELSE 4 END,
               dimension,
               CASE WHEN dimension = 'age' THEN bucket END,
               -- «Otros» va siempre al final, como en Beacons y
               -- Passionfroot: antes de un país con menos participación
               -- parecía un error de datos.
               CASE WHEN upper(bucket) IN ('OTHER', 'OTHERS', 'OTROS') THEN 1 ELSE 0 END,
               share DESC NULLS LAST,
               bucket`,
    [creatorId],
  );
  const audienciaAgrupada: MediaKitSnapshotAudiencia[] = [];
  for (const a of audiencia) {
    let grupo = audienciaAgrupada.at(-1);
    if (!grupo || grupo.dimension !== a.dimension) {
      grupo = { platformId: a.platform_id, dimension: a.dimension, buckets: [] };
      audienciaAgrupada.push(grupo);
    }
    // Ocho segmentos por dimensión bastan para una página que se lee de pie.
    if (grupo.buckets.length < 8) grupo.buckets.push({ bucket: a.bucket, share: a.share });
  }

  const tarifario = await getCurrentRateCard(tx, creatorId);
  const tarifasDelKit = (tarifario?.items ?? []).filter((i) => !i.isModifier);

  const redesSnapshot: MediaKitSnapshotRed[] = redes.map((r) => {
    const b = porRed.get(r.platform_id);
    return {
      platformId: r.platform_id,
      handle: r.handle,
      followers: r.followers === null ? null : Number(r.followers),
      followersAsOf: r.day,
      medianViews: b?.median_views ? Math.round(Number(b.median_views)) : null,
      engagement: b?.median_engagement ?? null,
      sampleSize: b?.sample_size ?? null,
      isReliable: b?.is_reliable ?? false,
    };
  });

  // Las cifras de la cabecera las suma la base, con las mismas reglas
  // que las filas de arriba: la última lectura de seguidores de cada red
  // conectada, y la línea base al corte del tarifario. La mediana más
  // alta sale con su red, que es lo que la página enseña al lado.
  const { rows: totales } = await tx.query<{
    followers: string | null; median_views_max: string | null; median_views_max_platform: PlatformId | null;
  }>(
    `WITH redes AS (
       SELECT DISTINCT ON (c.platform_id) c.platform_id, s.followers
         FROM social_connection c
         LEFT JOIN account_metric_snapshot s ON s.connection_id = c.id
        WHERE c.creator_id = $1
        ORDER BY c.platform_id, s.day DESC NULLS LAST
     ), base AS (
       SELECT DISTINCT ON (platform_id) platform_id, median_views
         FROM creator_baseline
        WHERE creator_id = $1
        ORDER BY platform_id, (age_hours_cut = $2) DESC, age_hours_cut DESC, computed_at DESC
     ), mejor AS (
       SELECT b.platform_id, round(b.median_views) AS median_views
         FROM base b JOIN redes r USING (platform_id)
        WHERE b.median_views IS NOT NULL
        ORDER BY b.median_views DESC, b.platform_id
        LIMIT 1
     )
     SELECT (SELECT sum(followers) FROM redes) AS followers,
            (SELECT median_views FROM mejor)   AS median_views_max,
            (SELECT platform_id FROM mejor)    AS median_views_max_platform`,
    [creatorId, CORTE_TARIFARIO_HORAS],
  );
  const total = totales[0];
  const followers = total && total.followers !== null ? Number(total.followers) : null;
  const medianViewsMax = total && total.median_views_max !== null ? Number(total.median_views_max) : null;
  const medianViewsMaxPlatform = total?.median_views_max_platform ?? null;

  return {
    version: 2,
    capturedAt: new Date().toISOString(),
    creator: {
      displayName: creador.display_name,
      handle: creador.handle,
      bio: creador.bio,
      country: creador.country,
      nicheSlugs: creador.niche_slugs,
    },
    currency: (ws[0]?.currency ?? WORKSPACE_DEFAULTS.currency).toUpperCase(),
    locale: ws[0]?.locale ?? WORKSPACE_DEFAULTS.locale,
    timezone: ws[0]?.timezone ?? WORKSPACE_DEFAULTS.timeZone,
    redes: redesSnapshot,
    totales: { followers, medianViewsMax, medianViewsMaxPlatform },
    topPosts: posts.map((p) => ({
      platformId: p.platform_id,
      url: p.url,
      caption: p.caption,
      publishedAt: p.published_at,
      views: p.views === null ? null : Number(p.views),
      viewsVsMedian: p.views_vs_median,
    })),
    audiencia: audienciaAgrupada,
    tarifas: tarifasDelKit.map((i) => ({
      labelEs: i.labelEs, platformId: i.platformId, priceLow: i.priceLow, priceHigh: i.priceHigh,
    })),
    tarifasIncluyen: [...new Set(tarifasDelKit.flatMap((i) => i.modifierIds))],
  };
}

export interface MediaKitRow {
  id: string;
  slug: string;
  creatorId: string;
  rateCardId: string | null;
  isPublic: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  viewCount: number;
  createdAt: string;
  snapshot: MediaKitSnapshot;
  /**
   * Hasta cuándo está bloqueado el enlace ENTERO por contraseñas
   * fallidas (el techo por enlace de 0030), solo si sigue vigente.
   */
  lockedUntil: string | null;
  /** Cuántos orígenes (visitas desde una IP) tienen hoy el bloqueo propio de 0030 vigente. */
  lockedOrigins: number;
}

interface RawMediaKit {
  id: string; slug: string; creator_id: string; rate_card_id: string | null;
  is_public: boolean; password_hash: string | null; expires_at: string | null;
  view_count: number; created_at: string; snapshot: MediaKitSnapshot;
  locked_until: string | null; locked_origins: number;
}

// El bloqueo solo se enseña mientras dura: uno vencido no dice nada.
// Las columnas van con el nombre de la tabla porque la subconsulta
// también tiene un locked_until.
const COLUMNAS_KIT = `media_kit.id, media_kit.slug, media_kit.creator_id, media_kit.rate_card_id,
  media_kit.is_public, media_kit.password_hash, media_kit.expires_at, media_kit.view_count,
  media_kit.created_at, media_kit.snapshot,
  CASE WHEN media_kit.locked_until > now() THEN media_kit.locked_until END AS locked_until,
  (SELECT count(*) FROM media_kit_lockout l
    WHERE l.media_kit_id = media_kit.id AND l.locked_until > now())::int AS locked_origins`;

const SELECT_KIT = `SELECT ${COLUMNAS_KIT} FROM media_kit`;

function mapKit(r: RawMediaKit): MediaKitRow {
  return {
    id: r.id,
    slug: r.slug,
    creatorId: r.creator_id,
    rateCardId: r.rate_card_id,
    isPublic: r.is_public,
    hasPassword: r.password_hash !== null,
    expiresAt: r.expires_at,
    viewCount: r.view_count,
    createdAt: r.created_at,
    snapshot: r.snapshot,
    lockedUntil: r.locked_until,
    lockedOrigins: r.locked_origins,
  };
}

export interface CreateMediaKitInput {
  creatorId: string;
  /** Contraseña en claro; se deriva aquí y nunca se guarda tal cual. */
  password?: string | null;
  /** ISO. Sin fecha, el enlace no vence. */
  expiresAt?: string | null;
  isPublic?: boolean;
}

/** Genera el media kit con las cifras de hoy congeladas y su enlace. */
export async function createMediaKit(tx: WorkspaceTx, input: CreateMediaKitInput): Promise<MediaKitRow> {
  const snapshot = await buildMediaKitSnapshot(tx, input.creatorId);
  const tarifario = await getCurrentRateCard(tx, input.creatorId);
  const passwordHash = input.password ? await hashSharePassword(input.password) : null;

  const { rows } = await tx.query<RawMediaKit>(
    `INSERT INTO media_kit (workspace_id, creator_id, rate_card_id, slug, snapshot, is_public, password_hash, expires_at)
     VALUES (current_workspace_id(), $1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING ${COLUMNAS_KIT}`,
    [
      input.creatorId, tarifario?.card.id ?? null, nuevoSlug(), JSON.stringify(snapshot),
      input.isPublic ?? true, passwordHash, input.expiresAt ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new CotizarError('MediaKitInsertError', 'No se pudo generar el media kit.');
  return mapKit(row);
}

export async function listMediaKits(tx: WorkspaceTx): Promise<MediaKitRow[]> {
  const { rows } = await tx.query<RawMediaKit>(`${SELECT_KIT} ORDER BY created_at DESC LIMIT 50`);
  return rows.map(mapKit);
}

/** Un media kit que se puede adjuntar a una cotización. */
export interface MediaKitAdjuntable {
  id: string;
  slug: string;
  createdAt: string;
  hasPassword: boolean;
  expiresAt: string | null;
}

/**
 * Los media kits de un creador que la marca puede abrir HOY: públicos y
 * sin vencer, el más reciente primero. Son los que el formulario de la
 * cotización ofrece para acompañarla (la página pública los enlaza al
 * pie, como las propuestas de Passionfroot y HoneyBook).
 */
export async function listShareableMediaKits(tx: WorkspaceTx, creatorId: string): Promise<MediaKitAdjuntable[]> {
  if (!isUuid(creatorId)) return [];
  const { rows } = await tx.query<{
    id: string; slug: string; created_at: string; has_password: boolean; expires_at: string | null;
  }>(
    `SELECT id, slug, created_at, password_hash IS NOT NULL AS has_password, expires_at
       FROM media_kit
      WHERE creator_id = $1 AND is_public AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC
      LIMIT 20`,
    [creatorId],
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    createdAt: r.created_at,
    hasPassword: r.has_password,
    expiresAt: r.expires_at,
  }));
}

export async function getMediaKitById(tx: WorkspaceTx, id: string): Promise<MediaKitRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<RawMediaKit>(`${SELECT_KIT} WHERE id = $1`, [id]);
  return rows[0] ? mapKit(rows[0]) : null;
}

export interface UpdateMediaKitShareInput {
  isPublic?: boolean;
  /** null quita la contraseña; undefined la deja como está. */
  password?: string | null;
  /** null quita el vencimiento; undefined lo deja como está. */
  expiresAt?: string | null;
}

/** Cambia cómo se comparte, nunca las cifras: el snapshot es inmutable. */
export async function updateMediaKitShare(tx: WorkspaceTx, id: string, input: UpdateMediaKitShareInput): Promise<MediaKitRow> {
  if (!isUuid(id)) throw new MediaKitNotFound();
  const sets: string[] = [];
  const values: unknown[] = [id];
  if (input.isPublic !== undefined) {
    values.push(input.isPublic);
    sets.push(`is_public = $${values.length}`);
  }
  if (input.password !== undefined) {
    values.push(input.password === null ? null : await hashSharePassword(input.password));
    sets.push(`password_hash = $${values.length}`);
    // Contraseña nueva, cuenta nueva: los fallos contra la anterior no
    // dicen nada de la nueva.
    sets.push('failed_attempts = 0', 'failed_since = NULL', 'locked_until = NULL');
  }
  if (input.expiresAt !== undefined) {
    values.push(input.expiresAt);
    sets.push(`expires_at = $${values.length}`);
  }
  if (sets.length === 0) {
    const actual = await getMediaKitById(tx, id);
    if (!actual) throw new MediaKitNotFound();
    return actual;
  }
  const { rows } = await tx.query<RawMediaKit>(
    `UPDATE media_kit SET ${sets.join(', ')} WHERE id = $1
     RETURNING ${COLUMNAS_KIT}`,
    values,
  );
  const row = rows[0];
  if (!row) throw new MediaKitNotFound();
  if (input.password !== undefined) {
    await tx.query('DELETE FROM media_kit_lockout WHERE media_kit_id = $1', [id]);
    row.locked_origins = 0;
  }
  return mapKit(row);
}

/**
 * «Desbloquear»: pone a cero los dos niveles del bloqueo por
 * contraseñas fallidas de 0030 —el techo del enlace y el de cada
 * origen—. Es la salida del creador cuando alguien con el enlace lo
 * mantiene bloqueado para la marca; si el abuso sigue, lo que lo corta
 * es generar otro media kit (el enlace nuevo no lo tiene quien ataca).
 */
export async function unlockMediaKit(tx: WorkspaceTx, id: string): Promise<MediaKitRow> {
  if (!isUuid(id)) throw new MediaKitNotFound();
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE media_kit SET failed_attempts = 0, failed_since = NULL, locked_until = NULL
      WHERE id = $1 RETURNING id`,
    [id],
  );
  if (!rows[0]) throw new MediaKitNotFound();
  await tx.query('DELETE FROM media_kit_lockout WHERE media_kit_id = $1', [id]);
  const kit = await getMediaKitById(tx, id);
  if (!kit) throw new MediaKitNotFound();
  return kit;
}
