/**
 * collect.post_metrics · una lectura diaria por publicación activa.
 *
 * Cada día a las 05:00 UTC (job_definition, cron `0 5`) pregunta a la
 * fuente de cada cuenta cómo van sus publicaciones y deja una fila en
 * post_metric_snapshot por cada una. La tabla es APPEND-ONLY a
 * propósito: dos lecturas del mismo día son dos filas, y eso es lo que
 * dibuja post_metrics_daily_delta. Nada se actualiza.
 *
 * `age_hours` se calcula EN SQL, con la misma expresión que usa la
 * importación por CSV de RES-2
 * (round(EXTRACT(EPOCH FROM (captured_at - published_at)) / 3600, 2)),
 * para que dos lecturas del mismo video por caminos distintos se
 * puedan comparar al decimal. Sin age_hours, comparar videos de edades
 * distintas es mentir.
 *
 * `captured_at` es ctx.now(), uno solo para toda la corrida: las
 * lecturas de una misma corrida son la misma foto. Y nunca hacia
 * atrás: si el post ya tiene una lectura de este instante o posterior,
 * esta no entra (la misma guardia de RES-2).
 *
 * Qué se mide y hasta cuándo lo decide `shouldKeepMeasuring` de
 * @mc/core: 888 h (720 del último corte de scoring.ts + 7 días de
 * gracia), salvo que el post esté en una campaña abierta, que se mide
 * hasta ends_on + 30 días para CAM-5.
 *
 * Los borrados: solo las fuentes con consulta por id (YouTube, y las
 * autorizadas de TikTok) pueden decir «este post ya no existe». Ahí, y
 * solo ahí, se marca deleted_on_platform. business_discovery de
 * Instagram no deja preguntar por un medio concreto, así que un post
 * borrado de una cuenta por @ deja de recibir lecturas pero no se
 * marca: no saber no es saber que no está.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada consulta lleva
 * workspace_id explícito.
 */
import type { NormalizedPostMetrics, PostMetricsReading, PostRef } from '@mc/connectors';
import { redactSecrets } from '@mc/connectors';
import { DEFAULT_MAX_AGE_HOURS, shouldKeepMeasuring } from '@mc/core';
import { envInt } from '../../runner/config.ts';
import { defineJob, type JobContext } from '../../runner/registry.ts';
import { mapLimit } from '../../runner/concurrency.ts';
import {
  chooseSource,
  groupByPlatform,
  markRead,
  recordFailure,
  selectCollectableAccounts,
  sourcesFor,
  type CollectableAccount,
  type CollectPayload,
} from './_posts.ts';

export interface CollectPostMetricsPayload extends CollectPayload {
  /** Tope de edad en horas; por defecto COLLECT_MAX_AGE_HOURS. */
  maxAgeHours?: number;
}

/** La lectura se escribe con este `source`: es lo que Resumen cuenta como «lectura de la API». */
export const API_SNAPSHOT_SOURCE = 'api';

/**
 * Unidades de la cuota diaria de YouTube (10 000 por proyecto) que el
 * recolector NO gasta, para que queden para la pantalla, CON-7 y un
 * reintento. Se ajusta con COLLECT_YOUTUBE_UNITS_RESERVE.
 */
export const DEFAULT_YOUTUBE_UNITS_RESERVE = 500;

/**
 * Al REINTENTAR (attempt > 1), un post medido hace menos de esto no se
 * vuelve a medir: una corrida abortada a mitad deja lo hecho y el
 * reintento sigue por donde iba, post a post. En el primer intento no
 * se salta nada, porque dos corridas seguidas SÍ deben dejar dos filas.
 */
export const RETRY_SKIP_MINUTES = 60;

interface MedibleRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connection_id: string;
  platform_id: string;
  external_post_id: string;
  surface: string | null;
  media_type: string;
  age_hours: string | number;
  campaign_status: string | null;
  campaign_ends_on: string | null;
  last_api_at: Date | string | null;
}

/**
 * Los posts candidatos: vivos, con fecha de publicación (age_hours es
 * NOT NULL en 0003) y de una cuenta de la que se puede leer. El corte
 * de edad grueso lo hace SQL con un margen generoso —los de campaña
 * abierta entran siempre— y la regla exacta la aplica @mc/core.
 */
export async function selectMeasurablePosts(
  ctx: JobContext,
  payload: CollectPostMetricsPayload,
  maxAgeHours: number,
  now: Date,
): Promise<MedibleRow[]> {
  const { rows } = await ctx.db.query<MedibleRow>(
    `SELECT p.id, p.workspace_id, p.connection_id, p.platform_id, p.external_post_id, p.surface, p.media_type,
            round(EXTRACT(EPOCH FROM ($3::timestamptz - p.published_at)) / 3600.0, 2)::text AS age_hours,
            camp.status AS campaign_status, to_char(camp.ends_on, 'YYYY-MM-DD') AS campaign_ends_on,
            ultima.captured_at AS last_api_at
       FROM post p
       JOIN social_connection c ON c.id = p.connection_id AND c.workspace_id = p.workspace_id
            AND c.deleted_at IS NULL AND c.access_mode IN ('public_profile', 'direct_oauth') AND c.status IN ('active', 'error')
       LEFT JOIN LATERAL (
         SELECT cm.status, cm.ends_on
           FROM campaign_post cp JOIN campaign cm ON cm.id = cp.campaign_id AND cm.workspace_id = p.workspace_id
          WHERE cp.post_id = p.id AND cm.status IN ('planned', 'live', 'measuring')
          ORDER BY cm.ends_on DESC NULLS FIRST
          LIMIT 1
       ) camp ON true
       LEFT JOIN LATERAL (
         SELECT max(s.captured_at) AS captured_at
           FROM post_metric_snapshot s
          WHERE s.post_id = p.id AND s.workspace_id = p.workspace_id AND s.source = $4
       ) ultima ON true
      WHERE p.deleted_on_platform = false AND p.published_at IS NOT NULL
        AND ($1::uuid IS NULL OR p.workspace_id = $1)
        AND ($2::uuid IS NULL OR p.connection_id = $2)
        AND (p.published_at >= $3::timestamptz - make_interval(hours => $5) OR camp.status IS NOT NULL)
      ORDER BY p.connection_id, p.published_at DESC`,
    [payload.workspaceId ?? null, payload.connectionId ?? null, now, API_SNAPSHOT_SOURCE, maxAgeHours],
  );
  return rows;
}

/** Los campos de post_metric_snapshot que escribe una lectura, con el id por el que se empareja. */
function toSnapshotRow(reading: PostMetricsReading): Record<string, unknown> {
  const m: NormalizedPostMetrics = reading.metrics;
  return {
    external_post_id: reading.externalPostId,
    views: m.views, reach: m.reach, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
    reposts: m.reposts, total_interactions: m.total_interactions,
    avg_watch_time_s: m.avg_watch_time_s, total_watch_time_s: m.total_watch_time_s,
    completion_rate: m.completion_rate, skip_rate_3s: m.skip_rate_3s,
    views_p25: m.views_p25, views_p50: m.views_p50, views_p75: m.views_p75, views_p100: m.views_p100,
    profile_visits: m.profile_visits, follows_from_post: m.follows_from_post, link_clicks: m.link_clicks,
    reach_followers: m.reach_followers, reach_non_followers: m.reach_non_followers,
    // La respuesta cruda pasa por el redactor: en `raw` no puede quedar
    // ni un token ni una llave de API.
    raw: redactSecrets(reading.raw),
  };
}

export async function writeSnapshots(
  ctx: JobContext,
  acc: CollectableAccount,
  capturedAt: Date,
  readings: readonly PostMetricsReading[],
): Promise<string[]> {
  if (readings.length === 0) return [];
  const datos = JSON.stringify(readings.map(toSnapshotRow));
  const { rows } = await ctx.db.query<{ post_id: string }>(
    `INSERT INTO post_metric_snapshot
       (post_id, workspace_id, captured_at, age_hours, views, reach, likes, comments, shares, saves, reposts,
        total_interactions, avg_watch_time_s, total_watch_time_s, completion_rate, skip_rate_3s,
        views_p25, views_p50, views_p75, views_p100, profile_visits, follows_from_post, link_clicks,
        reach_followers, reach_non_followers, raw, source)
     SELECT p.id, p.workspace_id, $3::timestamptz,
            round(EXTRACT(EPOCH FROM ($3::timestamptz - p.published_at)) / 3600.0, 2),
            e.views, e.reach, e.likes, e.comments, e.shares, e.saves, e.reposts,
            -- «No lo sabemos» no es «fue cero»: sin ningún término de
            -- interacción el total queda NULL, como en la importación
            -- por CSV (RES-2), y no en un cero que nadie midió.
            CASE WHEN e.total_interactions IS NOT NULL THEN e.total_interactions
                 WHEN num_nonnulls(e.likes, e.comments, e.shares, e.saves) = 0 THEN NULL
                 ELSE COALESCE(e.likes, 0) + COALESCE(e.comments, 0) + COALESCE(e.shares, 0) + COALESCE(e.saves, 0)
            END,
            e.avg_watch_time_s, e.total_watch_time_s, e.completion_rate, e.skip_rate_3s,
            e.views_p25, e.views_p50, e.views_p75, e.views_p100,
            e.profile_visits, e.follows_from_post, e.link_clicks, e.reach_followers, e.reach_non_followers,
            COALESCE(e.raw, '{}'::jsonb), $4
       FROM jsonb_to_recordset($5::jsonb) AS e(
         external_post_id text, views bigint, reach bigint, likes bigint, comments bigint, shares bigint,
         saves bigint, reposts bigint, total_interactions bigint, avg_watch_time_s numeric,
         total_watch_time_s bigint, completion_rate numeric, skip_rate_3s numeric, views_p25 bigint,
         views_p50 bigint, views_p75 bigint, views_p100 bigint, profile_visits bigint,
         follows_from_post bigint, link_clicks bigint, reach_followers bigint, reach_non_followers bigint, raw jsonb)
       JOIN post p ON p.connection_id = $1 AND p.workspace_id = $2 AND p.external_post_id = e.external_post_id
                  AND p.published_at IS NOT NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM post_metric_snapshot s
         WHERE s.post_id = p.id AND s.workspace_id = p.workspace_id AND s.captured_at >= $3::timestamptz
      )
     RETURNING post_id`,
    [acc.id, acc.workspace_id, capturedAt, API_SNAPSHOT_SOURCE, datos],
  );
  return rows.map((r) => r.post_id);
}

/** Lo que la plataforma ya no devuelve por su id es un post borrado. */
export async function markDeleted(ctx: JobContext, acc: CollectableAccount, externalIds: readonly string[]): Promise<number> {
  if (externalIds.length === 0) return 0;
  const res = await ctx.db.query(
    `UPDATE post SET deleted_on_platform = true
      WHERE connection_id = $1 AND workspace_id = $2 AND external_post_id = ANY($3::text[]) AND deleted_on_platform = false`,
    [acc.id, acc.workspace_id, [...externalIds]],
  );
  return res.rowCount ?? 0;
}

/** Unidades que le quedan hoy a la Data API de YouTube, según la memoria del proceso y api_quota_usage. */
export function youtubeUnitsLeft(ctx: JobContext): number | null {
  const quota = ctx.connectors.core.quota;
  const budget = quota.limits.youtube.daily?.units ?? null;
  if (budget === null) return null;
  return budget - quota.usedToday({ family: 'youtube', platformId: 'youtube', connectionId: null }).unitsUsed;
}

export const collectPostMetricsJob = defineJob<CollectPostMetricsPayload>('collect.post_metrics', async (payload, ctx) => {
  const now = ctx.now();
  const hoy = now.toISOString().slice(0, 10);
  const maxAgeHours = payload.maxAgeHours ?? envInt(ctx.env, 'COLLECT_MAX_AGE_HOURS', DEFAULT_MAX_AGE_HOURS);
  const reservaYouTube = envInt(ctx.env, 'COLLECT_YOUTUBE_UNITS_RESERVE', DEFAULT_YOUTUBE_UNITS_RESERVE);

  const accounts = await selectCollectableAccounts(ctx, payload);
  const porId = new Map(accounts.map((a) => [a.id, a]));
  const candidatos = await selectMeasurablePosts(ctx, payload, maxAgeHours, now);
  const publicas = sourcesFor(ctx);

  // La regla exacta (tope de edad y cola de campaña) vive en @mc/core.
  // El reintento, además, se salta lo que esta misma corrida ya midió.
  const reintento = ctx.attempt > 1;
  const desde = now.getTime() - RETRY_SKIP_MINUTES * 60_000;
  const porConexion = new Map<string, MedibleRow[]>();
  let viejos = 0;
  let yaMedidos = 0;
  for (const row of candidatos) {
    if (!porId.has(row.connection_id)) continue;
    const vigente = shouldKeepMeasuring({
      ageHours: Number(row.age_hours),
      maxAgeHours,
      today: hoy,
      campaign: row.campaign_status === null ? null : { status: row.campaign_status, endsOn: row.campaign_ends_on },
    });
    if (!vigente) {
      viejos += 1;
      continue;
    }
    if (reintento && row.last_api_at !== null) {
      const ultima = row.last_api_at instanceof Date ? row.last_api_at : new Date(row.last_api_at);
      if (ultima.getTime() >= desde) {
        yaMedidos += 1;
        continue;
      }
    }
    porConexion.set(row.connection_id, [...(porConexion.get(row.connection_id) ?? []), row]);
  }

  const snapshots: string[] = [];
  const borrados: string[] = [];
  const medidas: string[] = [];
  const sinFuenteDePosts: string[] = [];
  const errores: string[] = [];
  const transitorios: string[] = [];
  /** Publicaciones que quedan para mañana porque se acabó la cuota. */
  const diferidos: string[] = [];
  /** Publicaciones que no se alcanzaron porque la corrida se abortó. */
  const abortados: string[] = [];
  const sinConfigurar: Record<string, string> = {};

  const conCandidatos = accounts.filter((a) => (porConexion.get(a.id)?.length ?? 0) > 0);
  ctx.logger.info('publicaciones por medir', {
    candidatos: candidatos.length, aMedir: [...porConexion.values()].reduce((n, v) => n + v.length, 0),
    cuentas: conCandidatos.length, viejos, yaMedidos, maxAgeHours, attempt: ctx.attempt,
  });

  await Promise.all(
    [...groupByPlatform(conCandidatos).entries()].map(async ([platform, cuentas]) => {
      let sinCuota = false;
      await mapLimit(cuentas, ctx.definition.maxConcurrency, async (acc) => {
        const posts = porConexion.get(acc.id) ?? [];
        if (ctx.signal.aborted) {
          abortados.push(...posts.map((p) => p.id));
          return;
        }
        if (sinCuota) {
          diferidos.push(...posts.map((p) => p.id));
          return;
        }
        const log = ctx.logger.child({ connectionId: acc.id, workspaceId: acc.workspace_id, platform, accessMode: acc.access_mode });
        const elegida = await chooseSource(ctx, acc, publicas);
        if (elegida.kind === 'sin_fuente') {
          sinFuenteDePosts.push(acc.id);
          log.info('la cuenta no tiene fuente de publicaciones; sus lecturas llegan por otro camino');
          return;
        }
        if (elegida.kind === 'sin_configurar') {
          sinConfigurar[platform] = `faltan ${elegida.missing.join(', ')}`;
          log.warn('fuente de publicaciones sin configurar; se salta la cuenta', { missing: elegida.missing });
          return;
        }
        // YouTube cobra por unidades y el presupuesto es del día entero,
        // compartido con las demás lecturas: se para antes de agotarlo.
        if (platform === 'youtube') {
          const quedan = youtubeUnitsLeft(ctx);
          if (quedan !== null && quedan - Math.ceil(posts.length / 50) < reservaYouTube) {
            sinCuota = true;
            diferidos.push(...posts.map((p) => p.id));
            log.warn('la cuota diaria de YouTube se acerca a la reserva; el resto queda para mañana', { quedan, reservaYouTube });
            return;
          }
        }
        const refs: PostRef[] = posts.map((p) => ({
          externalPostId: p.external_post_id,
          surface: (p.surface ?? null) as PostRef['surface'],
          mediaType: p.media_type as PostRef['mediaType'],
        }));
        try {
          const res = await elegida.source.postMetrics(elegida.target, refs, { signal: ctx.signal });
          const escritos = await writeSnapshots(ctx, acc, now, res.readings);
          snapshots.push(...escritos);
          if (elegida.source.supportsLookupById && res.missingIds.length > 0) {
            const n = await markDeleted(ctx, acc, res.missingIds);
            if (n > 0) borrados.push(...res.missingIds);
          }
          await markRead(ctx, acc);
          medidas.push(acc.id);
          log.info('cuenta medida', { pedidos: refs.length, lecturas: res.readings.length, escritos: escritos.length, borrados: res.missingIds.length });
        } catch (err) {
          const fallo = await recordFailure(ctx, acc, err, log);
          if (fallo.kind === 'cuota') {
            sinCuota = true;
            diferidos.push(...posts.map((p) => p.id));
          } else if (fallo.kind === 'transitorio') {
            transitorios.push(acc.id);
          } else {
            errores.push(acc.id);
          }
        }
      });
    }),
  );

  const pendientes = transitorios.length + abortados.length;
  return {
    processed: snapshots.length,
    failed: pendientes + diferidos.length,
    // Igual que en collect.posts: con la cuota agotada el reintento
    // inmediato no ayuda; con un apagado o un fallo pasajero, sí.
    retry: pendientes > 0 && diferidos.length === 0,
    metadata: {
      capturedAt: now.toISOString(), maxAgeHours, candidatos: candidatos.length, viejos, yaMedidos,
      snapshots: snapshots.length, medidas, borrados, sinFuenteDePosts, errores, transitorios,
      abortados: abortados.length, diferidos: diferidos.length, sinConfigurar,
    },
  };
});
