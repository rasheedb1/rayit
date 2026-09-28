/**
 * collect.account_metrics · snapshot diario de las cuentas agregadas por @
 * (access_mode 'public_profile', CON-10). Cada día a las 05:10 UTC
 * (job_definition) lee la fuente pública oficial de cada cuenta y deja
 * una fila en account_metric_snapshot con source 'public_profile'.
 *
 *   instagram  business_discovery con INSTAGRAM_HOUSE_TOKEN
 *   youtube    Data API con GOOGLE_API_KEY
 *   tiktok     con ENSEMBLEDATA_TOKEN, el proveedor de datos (CON-12):
 *              seguidores y número de videos, source 'aggregator'. Sin
 *              esa variable, oEmbed: sin métricas; la cuenta queda
 *              anotada, no falla.
 *
 * `views` es la columna de las vistas DEL DÍA (Resumen la suma por día):
 * ninguna fuente de cuenta las da, así que YouTube (acumulado del canal) y
 * TikTok la dejan en null y las vistas llegan por video (CON-5).
 *
 * Errores: fuente sin configurar → la plataforma se salta y se avisa una
 * vez; not_found / not_discoverable → status 'error' con el detalle en
 * español; transitorio → cuenta como failed y pg-boss reintenta.
 * ctx.db corre como mc_worker: cada escritura filtra por workspace_id.
 * Las cuentas autorizadas (direct_oauth, CON-3 y CON-8) se leen con su
 * token: userInfo / me / channels.list?mine=true, source 'api'. Los
 * videos y sus métricas son de CON-5.
 */
import { createPublicProfileSources, isPlatformApiError, isPlatformId, PublicLookupError, type PublicProfileSources } from '@mc/connectors';
import { auditAsJob } from '@mc/db';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';
import { mapLimit } from './oauth-refresh.ts';

export interface CollectAccountMetricsPayload extends JobPayload {
  /** Solo esta cuenta (desde la pantalla). */
  connectionId?: string;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  platform_id: string;
  handle: string | null;
  external_account_id: string;
  access_mode: string;
  secret_ref: string;
}

interface Metrics {
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  views: number | null;
}

/**
 * Una cuenta autorizada (CON-3, CON-8) se lee con su propio token:
 * userInfo de TikTok, me de Instagram, channels.list?mine=true de YouTube.
 * YouTube da el acumulado de vistas del canal, no las del día, así que sus
 * vistas van en null (ver PublicAccountMetrics.views en @mc/connectors).
 * null = red sin lectura de cuenta con token.
 */
async function readAuthorized(ctx: JobContext, acc: AccountRow): Promise<{ metrics: Metrics; raw: unknown } | null> {
  const tokens = await ctx.secrets.get(acc.secret_ref);
  if (!tokens) throw new PublicLookupError('not_configured', 'El almacén no tiene el permiso de esta cuenta; hay que volver a autorizarla.');
  const auth = { connectionId: acc.id, tokens };
  if (acc.platform_id === 'tiktok') {
    const { data, raw } = await ctx.connectors.tiktokDisplay(auth).userInfo({ signal: ctx.signal });
    return { metrics: { followers: data.metrics.followers, following: data.metrics.following, mediaCount: data.metrics.media_count, views: data.metrics.views }, raw };
  }
  if (acc.platform_id === 'instagram') {
    const { data, raw } = await ctx.connectors.instagram(auth).me({ signal: ctx.signal });
    return { metrics: { followers: data.metrics.followers, following: data.metrics.following, mediaCount: data.metrics.media_count, views: data.metrics.views }, raw };
  }
  if (acc.platform_id === 'youtube') {
    const { data, raw } = await ctx.connectors.youtube(auth).channelMine({ signal: ctx.signal });
    if (!data) throw new PublicLookupError('not_found', 'La cuenta de Google autorizada ya no tiene canal de YouTube; hay que volver a autorizarla.');
    return { metrics: { followers: data.metrics.followers, following: null, mediaCount: data.metrics.media_count, views: null }, raw };
  }
  return null;
}

export const collectAccountMetricsJob = defineJob<CollectAccountMetricsPayload>('collect.account_metrics', async (payload, ctx) => {
  const { rows } = await ctx.db.query<AccountRow>(
    `SELECT id, workspace_id, platform_id, handle, external_account_id, access_mode, secret_ref
       FROM social_connection
      WHERE access_mode IN ('public_profile', 'aggregator', 'direct_oauth') AND deleted_at IS NULL AND status IN ('active', 'error')
        AND ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY platform_id, connected_at`,
    [payload.connectionId ?? null, payload.workspaceId ?? null],
  );
  const sources: PublicProfileSources = createPublicProfileSources(ctx.connectors.core, ctx.env);
  const snapshots: string[] = [];
  const noMetrics: string[] = [];
  const errored: string[] = [];
  const transient: string[] = [];
  /** Filas que cambiaron de fuente (autorizadas o quitadas) mientras esta corrida las leía por @: no se tocan. */
  const superseded: string[] = [];
  const skipped: Record<string, string> = {};
  const day = ctx.now().toISOString().slice(0, 10);

  const byPlatform = new Map<string, AccountRow[]>();
  for (const r of rows) byPlatform.set(r.platform_id, [...(byPlatform.get(r.platform_id) ?? []), r]);

  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, accounts]) => {
      const source = isPlatformId(platform) ? sources[platform] : undefined;
      const publicOnes = accounts.filter((a) => a.access_mode !== 'direct_oauth');
      if (publicOnes.length > 0 && (!source || source.missing.length > 0)) {
        skipped[platform] = source ? `faltan ${source.missing.join(', ')}` : 'sin fuente pública';
        ctx.logger.warn('fuente pública sin configurar; se saltan las cuentas por @ de la plataforma', { platform, missing: source?.missing ?? [], accounts: publicOnes.length });
      }
      const readable = accounts.filter((a) => a.access_mode === 'direct_oauth' || (source && source.missing.length === 0));
      await mapLimit(readable, ctx.definition.maxConcurrency, async (acc) => {
        if (ctx.signal.aborted) { transient.push(acc.id); return; }
        const log = ctx.logger.child({ connectionId: acc.id, workspaceId: acc.workspace_id, platform, accessMode: acc.access_mode });
        try {
          let m: Metrics | null;
          let raw: unknown;
          let note: string | null;
          let sourceName: string;
          if (acc.access_mode === 'direct_oauth') {
            const read = await readAuthorized(ctx, acc);
            if (!read) { noMetrics.push(acc.id); log.info('red autorizada sin lectura de cuenta todavía'); return; }
            m = read.metrics; raw = read.raw; note = null; sourceName = 'api';
          } else {
            const profile = await source!.lookup(acc.handle ?? acc.external_account_id, { signal: ctx.signal });
            m = profile.metrics; raw = profile.raw; note = profile.metricsNote;
            // El source del snapshot es el access_mode de la fuente que lo leyó
            // ('public_profile' o 'aggregator'): la columna dice de dónde salió la cifra.
            sourceName = source!.accessMode;
            // Contratar o dar de baja el proveedor mueve la cuenta de fuente
            // sin perder su id ni su historia (CON-12 §0.4).
            if (acc.access_mode !== source!.accessMode) {
              const changed = await ctx.db.transaction(async (tx) => {
                // Con la misma guarda que setAccountAccessMode (@mc/db): solo
                // entre las dos fuentes por @ y sobre una fila viva. Si el
                // dueño autorizó la cuenta mientras esta corrida leía, la fila
                // ya es direct_oauth y NO se degrada; el «antes» de la
                // bitácora es el de la base, no el que se leyó al empezar.
                const { rows: prev } = await tx.query<{ access_mode: string }>(
                  `UPDATE social_connection SET access_mode = $3
                    WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL AND access_mode <> $3
                      AND access_mode IN ('public_profile', 'aggregator')
                    RETURNING (SELECT c.access_mode FROM social_connection c WHERE c.id = $1) AS access_mode`,
                  [acc.id, acc.workspace_id, source!.accessMode],
                );
                if (!prev[0]) return false;
                // La misma fila de bitácora que deja la pantalla (ACC-2), pero como job.
                await auditAsJob(tx, {
                  workspaceId: acc.workspace_id, job: { id: ctx.jobId, runId: ctx.runId },
                  action: 'connection.source_changed', entityType: 'social_connection', entityId: acc.id,
                  before: { accessMode: prev[0].access_mode }, after: { accessMode: source!.accessMode },
                });
                return true;
              });
              if (!changed) {
                // La fila cambió bajo nuestros pies (autorizada o quitada): esta lectura por @ ya no le toca.
                superseded.push(acc.id);
                log.info('la cuenta ya no es de una fuente por @; no se guarda esta lectura', { leida: acc.access_mode });
                return;
              }
              log.info('la cuenta cambió de fuente pública', { de: acc.access_mode, a: source!.accessMode });
            }
          }
          if (m) {
            await ctx.db.transaction(async (tx) => {
              await tx.query(
                `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, following, media_count, views, raw, source)
                 VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb, $9)
                 ON CONFLICT (connection_id, day, source) DO UPDATE
                   SET followers = EXCLUDED.followers, following = EXCLUDED.following, media_count = EXCLUDED.media_count,
                       views = EXCLUDED.views, raw = EXCLUDED.raw, captured_at = now()`,
                [acc.id, acc.workspace_id, day, m.followers, m.following, m.mediaCount, m.views, JSON.stringify(raw ?? {}), sourceName],
              );
              await tx.query(
                `UPDATE social_connection SET last_synced_at = now(), last_error_at = NULL, consecutive_failures = 0, status = 'active', status_detail = NULL
                  WHERE id = $1 AND workspace_id = $2`,
                [acc.id, acc.workspace_id],
              );
            });
            snapshots.push(acc.id);
            log.info('snapshot público guardado', { day, followers: m.followers });
          } else {
            await ctx.db.query(`UPDATE social_connection SET status_detail = $3 WHERE id = $1 AND workspace_id = $2`, [acc.id, acc.workspace_id, note]);
            noMetrics.push(acc.id);
            log.info('la fuente no publica métricas; solo identidad');
          }
        } catch (err) {
          if (isPlatformApiError(err) && err.kind === 'auth') {
            // El token de una cuenta autorizada ya no sirve: needs_reauth, como hace oauth.refresh.
            await ctx.db.query(
              `UPDATE social_connection SET status = 'needs_reauth', status_detail = $3, last_error_at = now(), consecutive_failures = consecutive_failures + 1
                WHERE id = $1 AND workspace_id = $2`,
              [acc.id, acc.workspace_id, err.messageEs],
            );
            errored.push(acc.id);
            log.warn('la plataforma rechazó el token de la cuenta autorizada', { code: err.code });
            return;
          }
          if (err instanceof PublicLookupError && (err.code === 'not_found' || err.code === 'not_discoverable' || err.code === 'invalid_handle')) {
            await ctx.db.query(
              `UPDATE social_connection SET status = 'error', status_detail = $3, last_error_at = now(), consecutive_failures = consecutive_failures + 1
                WHERE id = $1 AND workspace_id = $2`,
              [acc.id, acc.workspace_id, err.messageEs],
            );
            errored.push(acc.id);
            log.warn('la cuenta ya no se puede leer', { code: err.code });
          } else {
            await ctx.db.query(`UPDATE social_connection SET last_error_at = now(), consecutive_failures = consecutive_failures + 1 WHERE id = $1 AND workspace_id = $2`, [acc.id, acc.workspace_id]);
            transient.push(acc.id);
            log.warn('lectura pública con fallo transitorio', { code: err instanceof PublicLookupError ? err.code : 'unexpected', err: err instanceof PublicLookupError ? undefined : err });
          }
        }
      });
    }),
  );

  return {
    processed: snapshots.length + noMetrics.length + errored.length + superseded.length,
    failed: transient.length,
    metadata: { day, accounts: rows.length, snapshots, noMetrics, errored, transient, superseded, skipped },
  };
});

export type { JobContext };
