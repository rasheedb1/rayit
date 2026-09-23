/**
 * brand.snapshot · seguidores públicos de la marca de cada campaña (CAM-3).
 * Cada día a las 07:00 UTC (job_definition, 0009) lee, para cada campaña
 * planned/live/measuring con brand_accounts y en ventana (desde
 * brand_baseline_from hasta ends_on + 30: isBrandSnapshotDue, core), el
 * perfil público de la marca y deja una fila por (campaña, red, día) en
 * brand_account_snapshot con el MISMO INSERT que «Actualizar ahora» en la
 * ficha (recordBrandSnapshot, @mc/db).
 *
 *   instagram  business_discovery con INSTAGRAM_HOUSE_TOKEN (CON-10)
 *   youtube    Data API con GOOGLE_API_KEY
 *   tiktok     sin fuente pública de seguidores: fila con followers NULL y
 *              source 'no_public_source', sin llamada
 *   facebook   sin fuente: la red se salta
 *
 * Una marca en varias campañas del mismo workspace se lee UNA vez (por
 * workspace, empresa, red y handle) y deja una fila por campaña.
 *
 * Errores: not_found / not_discoverable / invalid_handle → fila con
 * followers NULL y la razón en source; no cuentan como fallo (mañana se
 * vuelve a mirar). Transitorio → failed, sin fila, pg-boss reintenta.
 * Cuota agotada → failed con retry: false (el siguiente tick es el
 * reintento). Fuente sin configurar → la red se salta y se avisa una vez.
 * ctx.db corre como mc_worker: cada consulta filtra por workspace_id.
 */
import { createPublicProfileSources, isPlatformApiError, isPlatformId, PublicLookupError, type PublicProfileSources } from '@mc/connectors';
import { brandAccountsOf, BRAND_SNAPSHOT_STATUSES, isBrandSnapshotDue, recordBrandSnapshot, type BrandNoDataReason, type BrandSnapshotInput } from '@mc/db/queries/campanas';
import { defineJob, type JobPayload } from '../../runner/registry.ts';
import { mapLimit } from '../conexiones/oauth-refresh.ts';

export interface BrandSnapshotPayload extends JobPayload {
  /** Solo esta campaña (desde una pantalla o una prueba). */
  campaignId?: string;
}

interface CampaignRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  company_id: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  brand_baseline_from: string | null;
  brand_accounts: unknown;
}

/** Una marca a leer: todas las campañas en ventana que la nombran en esa red. */
interface Target {
  workspaceId: string;
  companyId: string;
  platformId: string;
  handle: string;
  campaignIds: string[];
}

/** Lo que va a job_run.metadata: pares campaña/red, sin handles ni tokens. */
type Ref = { campaignId: string; platformId: string };

export const NO_PUBLIC_SOURCE: BrandNoDataReason = 'no_public_source';

function reasonOf(code: PublicLookupError['code']): BrandNoDataReason | null {
  if (code === 'not_found' || code === 'invalid_handle') return 'not_found';
  if (code === 'not_discoverable') return 'not_discoverable';
  return null;
}

export const brandSnapshotJob = defineJob<BrandSnapshotPayload>('brand.snapshot', async (payload, ctx) => {
  const day = ctx.now().toISOString().slice(0, 10);
  const { rows } = await ctx.db.query<CampaignRow>(
    `SELECT id, workspace_id, company_id, status,
            to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
            to_char(brand_baseline_from, 'YYYY-MM-DD') AS brand_baseline_from, brand_accounts
       FROM campaign
      WHERE status = ANY($1::text[]) AND jsonb_array_length(brand_accounts) > 0
        AND ($2::uuid IS NULL OR workspace_id = $2) AND ($3::uuid IS NULL OR id = $3)
      ORDER BY workspace_id, company_id, starts_on NULLS LAST, created_at`,
    [BRAND_SNAPSHOT_STATUSES, payload.workspaceId ?? null, payload.campaignId ?? null],
  );

  const targets = new Map<string, Target>();
  let campaigns = 0;
  for (const c of rows) {
    const accounts = brandAccountsOf(c.brand_accounts);
    const status = c.status as (typeof BRAND_SNAPSHOT_STATUSES)[number];
    if (!isBrandSnapshotDue({ status, startsOn: c.starts_on, endsOn: c.ends_on, brandBaselineFrom: c.brand_baseline_from, brandAccounts: accounts.length }, day)) continue;
    campaigns++;
    for (const a of accounts) {
      const key = `${c.workspace_id}|${c.company_id}|${a.platform_id}|${a.handle.toLowerCase()}`;
      const t = targets.get(key) ?? { workspaceId: c.workspace_id, companyId: c.company_id, platformId: a.platform_id, handle: a.handle, campaignIds: [] };
      t.campaignIds.push(c.id);
      targets.set(key, t);
    }
  }

  const sources: PublicProfileSources = createPublicProfileSources(ctx.connectors.core, ctx.env);
  const snapshots: Ref[] = [];
  const noSource: Ref[] = [];
  const errored: Ref[] = [];
  const transient: Ref[] = [];
  const quota: Ref[] = [];
  const skipped: Record<string, string> = {};

  const byPlatform = new Map<string, Target[]>();
  for (const t of targets.values()) byPlatform.set(t.platformId, [...(byPlatform.get(t.platformId) ?? []), t]);

  /** Una fila por campaña del objetivo; el worker rellena una marca «sin cifra» del día con una lectura real. */
  const write = async (t: Target, row: Omit<BrandSnapshotInput, 'campaignId' | 'companyId' | 'platformId' | 'day'>): Promise<void> => {
    for (const campaignId of t.campaignIds) {
      await recordBrandSnapshot(ctx.db, { campaignId, companyId: t.companyId, platformId: t.platformId, day, ...row }, { onConflict: 'fill_missing' });
    }
  };
  const refs = (t: Target): Ref[] => t.campaignIds.map((campaignId) => ({ campaignId, platformId: t.platformId }));

  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, list]) => {
      const source = isPlatformId(platform) ? sources[platform] : undefined;
      const log = ctx.logger.child({ platform });
      if (platform === 'tiktok') {
        // Sin fuente pública de seguidores por @ (CON-10): la fila del día dice por qué, y la ficha lo explica.
        for (const t of list) {
          if (ctx.signal.aborted) { transient.push(...refs(t)); continue; }
          await write(t, { handle: t.handle, externalAccountId: null, followers: null, mediaCount: null, source: NO_PUBLIC_SOURCE });
          noSource.push(...refs(t));
        }
        return;
      }
      if (!source || source.missing.length > 0) {
        skipped[platform] = source ? `faltan ${source.missing.join(', ')}` : 'sin fuente pública';
        log.warn('fuente pública sin configurar; se saltan las marcas de la plataforma', { missing: source?.missing ?? [], brands: list.length });
        return;
      }
      await mapLimit(list, ctx.definition.maxConcurrency, async (t) => {
        if (ctx.signal.aborted) { transient.push(...refs(t)); return; }
        const tlog = log.child({ workspaceId: t.workspaceId, companyId: t.companyId, campaigns: t.campaignIds.length });
        try {
          const profile = await source.lookup(t.handle, { signal: ctx.signal });
          const m = profile.metrics;
          await write(t, {
            handle: profile.profile.handle ?? t.handle,
            externalAccountId: profile.profile.external_account_id,
            followers: m?.followers ?? null,
            mediaCount: m?.mediaCount ?? null,
            source: m ? profile.source : NO_PUBLIC_SOURCE,
          });
          if (m) { snapshots.push(...refs(t)); tlog.info('snapshot de la marca guardado', { day, followers: m.followers }); }
          else { noSource.push(...refs(t)); tlog.info('la fuente no publica seguidores; fila sin cifra'); }
        } catch (err) {
          const reason = err instanceof PublicLookupError ? reasonOf(err.code) : null;
          if (reason) {
            await write(t, { handle: t.handle, externalAccountId: null, followers: null, mediaCount: null, source: reason });
            errored.push(...refs(t));
            tlog.warn('la marca no se pudo leer; la fila del día lleva la razón', { code: err instanceof PublicLookupError ? err.code : reason });
            return;
          }
          const cause = err instanceof PublicLookupError ? err.cause : err;
          if (isPlatformApiError(cause) && cause.kind === 'quota') {
            quota.push(...refs(t));
            tlog.warn('cuota agotada; se reintenta en el siguiente tick', { code: cause.code, retryAfterS: cause.retryAfterS });
            return;
          }
          transient.push(...refs(t));
          tlog.warn('lectura de la marca con fallo transitorio', { code: err instanceof PublicLookupError ? err.code : 'unexpected', err: err instanceof PublicLookupError ? undefined : err });
        }
      });
    }),
  );

  const failed = transient.length + quota.length;
  return {
    processed: snapshots.length + noSource.length + errored.length,
    failed,
    // Un reintento inmediato no ayuda con la cuota; con un fallo transitorio, sí.
    ...(failed > 0 && transient.length === 0 ? { retry: false } : {}),
    metadata: { day, campaigns, targets: targets.size, snapshots, noSource, errored, transient, quota, skipped },
  };
});
