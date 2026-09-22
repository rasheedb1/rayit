/**
 * collect.account_metrics · snapshot diario de las cuentas agregadas por @
 * (access_mode 'public_profile', CON-10). Cada día a las 05:10 UTC
 * (job_definition) lee la fuente pública oficial de cada cuenta y deja
 * una fila en account_metric_snapshot con source 'public_profile'.
 *
 *   instagram  business_discovery con INSTAGRAM_HOUSE_TOKEN
 *   youtube    Data API con GOOGLE_API_KEY
 *   tiktok     oEmbed: sin métricas; la cuenta queda anotada, no falla
 *
 * Errores: fuente sin configurar → la plataforma se salta y se avisa una
 * vez; not_found / not_discoverable → status 'error' con el detalle en
 * español; transitorio → cuenta como failed y pg-boss reintenta.
 * ctx.db corre como mc_worker: cada escritura filtra por workspace_id.
 * Las cuentas autorizadas (direct_oauth) son de CON-5 y no se tocan aquí.
 */
import { createPublicProfileSources, isPlatformId, PublicLookupError, type PublicProfileSources } from '@mc/connectors';
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
}

export const PUBLIC_SNAPSHOT_SOURCE = 'public_profile';

export const collectAccountMetricsJob = defineJob<CollectAccountMetricsPayload>('collect.account_metrics', async (payload, ctx) => {
  const { rows } = await ctx.db.query<AccountRow>(
    `SELECT id, workspace_id, platform_id, handle, external_account_id
       FROM social_connection
      WHERE access_mode = 'public_profile' AND deleted_at IS NULL AND status IN ('active', 'error')
        AND ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR workspace_id = $2)
      ORDER BY platform_id, connected_at`,
    [payload.connectionId ?? null, payload.workspaceId ?? null],
  );
  const sources: PublicProfileSources = createPublicProfileSources(ctx.connectors.core, ctx.env);
  const snapshots: string[] = [];
  const noMetrics: string[] = [];
  const errored: string[] = [];
  const transient: string[] = [];
  const skipped: Record<string, string> = {};
  const day = ctx.now().toISOString().slice(0, 10);

  const byPlatform = new Map<string, AccountRow[]>();
  for (const r of rows) byPlatform.set(r.platform_id, [...(byPlatform.get(r.platform_id) ?? []), r]);

  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, accounts]) => {
      const source = isPlatformId(platform) ? sources[platform] : undefined;
      if (!source || source.missing.length > 0) {
        skipped[platform] = source ? `faltan ${source.missing.join(', ')}` : 'sin fuente pública';
        ctx.logger.warn('fuente pública sin configurar; se salta la plataforma', { platform, missing: source?.missing ?? [] });
        return;
      }
      await mapLimit(accounts, ctx.definition.maxConcurrency, async (acc) => {
        if (ctx.signal.aborted) { transient.push(acc.id); return; }
        const log = ctx.logger.child({ connectionId: acc.id, workspaceId: acc.workspace_id, platform });
        try {
          const profile = await source.lookup(acc.handle ?? acc.external_account_id, { signal: ctx.signal });
          const m = profile.metrics;
          if (m) {
            await ctx.db.transaction(async (tx) => {
              await tx.query(
                `INSERT INTO account_metric_snapshot (connection_id, workspace_id, day, followers, following, media_count, views, raw, source)
                 VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb, $9)
                 ON CONFLICT (connection_id, day, source) DO UPDATE
                   SET followers = EXCLUDED.followers, following = EXCLUDED.following, media_count = EXCLUDED.media_count,
                       views = EXCLUDED.views, raw = EXCLUDED.raw, captured_at = now()`,
                [acc.id, acc.workspace_id, day, m.followers, m.following, m.mediaCount, m.views, JSON.stringify(profile.raw ?? {}), PUBLIC_SNAPSHOT_SOURCE],
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
            await ctx.db.query(`UPDATE social_connection SET status_detail = $3 WHERE id = $1 AND workspace_id = $2`, [acc.id, acc.workspace_id, profile.metricsNote]);
            noMetrics.push(acc.id);
            log.info('la fuente no publica métricas; solo identidad', { source: profile.source });
          }
        } catch (err) {
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
    processed: snapshots.length + noMetrics.length + errored.length,
    failed: transient.length,
    metadata: { day, accounts: rows.length, snapshots, noMetrics, errored, transient, skipped },
  };
});

export type { JobContext };
