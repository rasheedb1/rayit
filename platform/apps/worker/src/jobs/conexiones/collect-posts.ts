/**
 * collect.posts · descubre las publicaciones nuevas de cada cuenta.
 *
 * Cada seis horas (el cron de su fila en job_definition) pregunta a la fuente
 * de cada cuenta qué publicó desde el último post que ya conocíamos, y
 * deja una fila en `post` por publicación. NO mide: las cifras las
 * toma collect.post_metrics, que es quien escribe snapshots.
 *
 * La identidad de un post es el UNIQUE natural de 0003
 * (platform_id, external_post_id, connection_id). De ahí sale la regla
 * de fusión con el archivo de TikTok Studio (RES-2): un video importado
 * por CSV y luego visto por la API en la MISMA conexión es el mismo
 * post; la API manda en identidad y metadatos, y los snapshots del CSV
 * siguen ahí porque post_metric_snapshot es append-only. Donde la API
 * no trae dato, se conserva lo que ya había (COALESCE): un null de la
 * API no borra un título que puso el archivo.
 *
 * `first_seen_at` no se toca nunca: es la primera vez que NOSOTROS
 * vimos el post, no la última.
 *
 * `last_synced_at` tampoco: esa columna anuncia la frescura de la serie
 * de cuenta (CON-10) y moverla aquí taparía una sincronización rota en
 * connection_health y en Resumen. La frescura del contenido sale de
 * post_metric_snapshot, que es lo que Resumen ya lee.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada consulta lleva
 * workspace_id explícito.
 */
import type { NormalizedVideo } from '@mc/connectors';
import { envInt } from '../../runner/config.ts';
import { defineJob, type JobContext } from '../../runner/registry.ts';
import { mapLimit } from './oauth-refresh.ts';
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

export interface CollectPostsPayload extends CollectPayload {
  /** Posts nuevos por cuenta en esta corrida; por defecto COLLECT_POSTS_MAX. */
  max?: number;
  /** Ignora lo ya conocido y vuelve a listar la ventana entera (para rellenar tras un fallo). */
  full?: boolean;
}

/**
 * Posts nuevos por cuenta y corrida. 25 es el `limit` por defecto de
 * /me/media en CON-1 y cabe en una sola llamada de las dos fuentes;
 * con el cron de seis horas habría que publicar 26 videos en seis
 * horas para que uno se quedara fuera, y la corrida siguiente lo
 * recoge igual porque la ventana no avanza más allá de lo guardado.
 */
export const DEFAULT_POSTS_MAX = 25;

interface PostRow {
  external_post_id: string;
  url: string | null;
  permalink: string | null;
  cover_url: string | null;
  media_type: string;
  surface: string | null;
  caption: string | null;
  title: string | null;
  hashtags: string[];
  mentions: string[];
  duration_s: number | null;
  width: number | null;
  height: number | null;
  audio_type: string | null;
  audio_external_id: string | null;
  is_ai_generated: boolean | null;
  is_branded_content: boolean | null;
  published_at: string | null;
}

function toRow(video: NormalizedVideo): PostRow {
  const p = video.post;
  return {
    external_post_id: p.external_post_id,
    url: p.url,
    permalink: p.permalink,
    cover_url: p.cover_url,
    media_type: p.media_type,
    surface: p.surface,
    caption: p.caption,
    title: p.title,
    hashtags: p.hashtags,
    mentions: p.mentions,
    duration_s: p.duration_s,
    width: p.width,
    height: p.height,
    audio_type: p.audio_type,
    audio_external_id: p.audio_external_id,
    is_ai_generated: p.is_ai_generated,
    is_branded_content: p.is_branded_content,
    published_at: p.published_at === null ? null : p.published_at.toISOString(),
  };
}

/** El post más reciente que ya conocemos de esa cuenta: la ventana empieza justo después. */
export async function lastKnownPublishedAt(ctx: JobContext, acc: CollectableAccount): Promise<Date | null> {
  const { rows } = await ctx.db.query<{ ultimo: Date | string | null }>(
    `SELECT max(published_at) AS ultimo FROM post WHERE connection_id = $1 AND workspace_id = $2`,
    [acc.id, acc.workspace_id],
  );
  const v = rows[0]?.ultimo ?? null;
  return v === null ? null : v instanceof Date ? v : new Date(v);
}

export interface UpsertResult {
  nuevos: number;
  conocidos: number;
}

/**
 * Un solo INSERT por cuenta con jsonb_to_recordset, igual que la
 * importación por CSV de RES-2. `xmax = 0` distingue la fila nueva de
 * la actualizada sin restar conjuntos.
 */
export async function upsertPosts(ctx: JobContext, acc: CollectableAccount, videos: readonly NormalizedVideo[]): Promise<UpsertResult> {
  if (videos.length === 0) return { nuevos: 0, conocidos: 0 };
  // Un mismo external_post_id dos veces en el lote rompería el ON
  // CONFLICT ("cannot affect row a second time"): la fuente pagina, y
  // un cursor repetido puede devolver el mismo medio dos veces.
  const unicos = new Map<string, PostRow>();
  for (const v of videos) {
    const row = toRow(v);
    if (row.external_post_id !== '') unicos.set(row.external_post_id, row);
  }
  if (unicos.size === 0) return { nuevos: 0, conocidos: 0 };
  const { rows } = await ctx.db.query<{ created: boolean }>(
    `INSERT INTO post (workspace_id, creator_id, connection_id, platform_id, external_post_id,
                       url, permalink, cover_url, media_type, surface, caption, title, hashtags, mentions,
                       duration_s, width, height, audio_type, audio_external_id, is_ai_generated, is_branded_content, published_at)
     SELECT $1, $2, $3, $4, f.external_post_id, f.url, f.permalink, f.cover_url, f.media_type, f.surface,
            f.caption, f.title, COALESCE(f.hashtags, '{}'), COALESCE(f.mentions, '{}'), f.duration_s, f.width, f.height,
            f.audio_type, f.audio_external_id, f.is_ai_generated, f.is_branded_content, f.published_at
       FROM jsonb_to_recordset($5::jsonb) AS f(
         external_post_id text, url text, permalink text, cover_url text, media_type text, surface text,
         caption text, title text, hashtags text[], mentions text[], duration_s numeric, width int, height int,
         audio_type text, audio_external_id text, is_ai_generated boolean, is_branded_content boolean, published_at timestamptz)
     ON CONFLICT (platform_id, external_post_id, connection_id) DO UPDATE
       SET url = COALESCE(EXCLUDED.url, post.url),
           permalink = COALESCE(EXCLUDED.permalink, post.permalink),
           cover_url = COALESCE(EXCLUDED.cover_url, post.cover_url),
           media_type = EXCLUDED.media_type,
           surface = COALESCE(EXCLUDED.surface, post.surface),
           caption = COALESCE(EXCLUDED.caption, post.caption),
           title = COALESCE(EXCLUDED.title, post.title),
           hashtags = CASE WHEN cardinality(EXCLUDED.hashtags) > 0 THEN EXCLUDED.hashtags ELSE post.hashtags END,
           mentions = CASE WHEN cardinality(EXCLUDED.mentions) > 0 THEN EXCLUDED.mentions ELSE post.mentions END,
           duration_s = COALESCE(EXCLUDED.duration_s, post.duration_s),
           width = COALESCE(EXCLUDED.width, post.width),
           height = COALESCE(EXCLUDED.height, post.height),
           audio_type = COALESCE(EXCLUDED.audio_type, post.audio_type),
           audio_external_id = COALESCE(EXCLUDED.audio_external_id, post.audio_external_id),
           is_ai_generated = COALESCE(EXCLUDED.is_ai_generated, post.is_ai_generated),
           is_branded_content = COALESCE(EXCLUDED.is_branded_content, post.is_branded_content),
           published_at = COALESCE(EXCLUDED.published_at, post.published_at),
           -- Volver a verlo lo devuelve a la vida: un borrado que
           -- reaparece deja de estar marcado.
           deleted_on_platform = false
       WHERE post.workspace_id = $1
     RETURNING (xmax = 0) AS created`,
    [acc.workspace_id, acc.creator_id, acc.id, acc.platform_id, JSON.stringify([...unicos.values()])],
  );
  const nuevos = rows.filter((r) => r.created === true).length;
  return { nuevos, conocidos: rows.length - nuevos };
}

export const collectPostsJob = defineJob<CollectPostsPayload>('collect.posts', async (payload, ctx) => {
  const accounts = await selectCollectableAccounts(ctx, payload);
  const publicas = sourcesFor(ctx);
  const max = payload.max ?? envInt(ctx.env, 'COLLECT_POSTS_MAX', DEFAULT_POSTS_MAX);

  const descubiertos: Record<string, number> = {};
  const revisadas: string[] = [];
  const sinFuenteDePosts: string[] = [];
  const errores: string[] = [];
  const transitorios: string[] = [];
  /** Cuentas que quedan para la próxima corrida porque se acabó la cuota. */
  const diferidas: string[] = [];
  /** Cuentas que no se alcanzaron porque la corrida se abortó. */
  const abortadas: string[] = [];
  const sinConfigurar: Record<string, string> = {};
  let nuevos = 0;

  ctx.logger.info('cuentas por revisar', { total: accounts.length, max });

  await Promise.all(
    [...groupByPlatform(accounts).entries()].map(async ([platform, cuentas]) => {
      // Cuando una plataforma dice «no hay más cuota», el resto de sus
      // cuentas queda para la próxima corrida: seguir pidiendo solo
      // gasta reintentos.
      let sinCuota = false;
      await mapLimit(cuentas, ctx.definition.maxConcurrency, async (acc) => {
        if (ctx.signal.aborted) {
          abortadas.push(acc.id);
          return;
        }
        if (sinCuota) {
          diferidas.push(acc.id);
          return;
        }
        const log = ctx.logger.child({ connectionId: acc.id, workspaceId: acc.workspace_id, platform, accessMode: acc.access_mode });
        const elegida = await chooseSource(ctx, acc, publicas);
        if (elegida.kind === 'sin_fuente') {
          await markRead(ctx, acc, elegida.noteEs);
          sinFuenteDePosts.push(acc.id);
          log.info('la cuenta no tiene fuente de publicaciones; queda anotada');
          return;
        }
        if (elegida.kind === 'sin_configurar') {
          sinConfigurar[platform] = `faltan ${elegida.missing.join(', ')}`;
          log.warn('fuente de publicaciones sin configurar; se salta la cuenta', { missing: elegida.missing });
          return;
        }
        try {
          const since = payload.full === true ? null : await lastKnownPublishedAt(ctx, acc);
          const videos: NormalizedVideo[] = [];
          for await (const video of elegida.source.listRecentPosts(elegida.target, { since, max, signal: ctx.signal })) {
            videos.push(video);
          }
          const res = await upsertPosts(ctx, acc, videos);
          await markRead(ctx, acc);
          nuevos += res.nuevos;
          descubiertos[acc.id] = res.nuevos;
          revisadas.push(acc.id);
          log.info('cuenta revisada', { vistos: videos.length, nuevos: res.nuevos, conocidos: res.conocidos, since: since?.toISOString() ?? null });
        } catch (err) {
          const fallo = await recordFailure(ctx, acc, err, log);
          if (fallo.kind === 'cuota') {
            sinCuota = true;
            diferidas.push(acc.id);
          } else if (fallo.kind === 'transitorio') {
            transitorios.push(acc.id);
          } else {
            errores.push(acc.id);
          }
        }
      });
    }),
  );

  const pendientes = transitorios.length + abortadas.length;
  return {
    processed: revisadas.length + sinFuenteDePosts.length + errores.length,
    failed: pendientes + diferidas.length,
    // Con la cuota agotada, el reintento inmediato no ayuda: el
    // siguiente tick del cron es el reintento. Un apagado o un fallo
    // pasajero sí mejoran con un reintento.
    retry: pendientes > 0 && diferidas.length === 0,
    metadata: { cuentas: accounts.length, max, nuevos, descubiertos, revisadas, sinFuenteDePosts, errores, transitorios, abortadas, diferidas, sinConfigurar },
  };
});
