/**
 * campaign.compute (CAM-5) · el resultado de cada campaña en curso.
 *
 * Cada día a las 07:30 UTC (job_definition, 0009) recalcula
 * campaign_result de las campañas live, measuring y reported; closed y
 * cancelled conservan el suyo. La cuenta la hace calcularResultado
 * (@mc/core, pura) sobre lo que lee getResultInputs; esto solo reparte
 * el trabajo y lo anota.
 *
 * ctx.db corre como mc_worker (se salta RLS): la lista es de todos los
 * workspaces, y cada campaña se lee y se escribe con SU workspace_id en
 * cada SELECT y en el UPSERT (ResultExecutor), en su propia transacción.
 * Idempotente: el UPSERT reemplaza la fila; correr dos veces deja lo
 * mismo con otro computed_at. El reloj es ctx.now().
 *
 * Una campaña que falla no tumba las demás: cuenta en failed y pg-boss
 * reintenta la corrida (las que salieron bien se recalculan igual, sin
 * efecto). metadata lleva conteos e ids, nada más.
 *
 * Desde una pantalla: boss.send('campaign.compute', { workspaceId,
 * campaignId }) recalcula solo esa (hoy la web no llega a la cola; ver
 * docs/propuestas/CAM-5.md §0.3.6).
 */
import { computeCampaignResult, listCampaignsToCompute, type ResultExecutor } from '@mc/db';
import { defineJob, type JobPayload } from '../../runner/registry.ts';
import type { Queryable } from '../../runner/db.ts';
import { mapLimit } from '../conexiones/oauth-refresh.ts';

export interface CampaignComputePayload extends JobPayload {
  /** Solo esta campaña (con su workspaceId). */
  campaignId?: string;
}

/** La transacción del worker, atada al workspace de la campaña que se calcula. */
function scoped(tx: Queryable, workspaceId: string): ResultExecutor {
  return { workspaceId, query: (text, params) => tx.query(text, params) };
}

export const campaignComputeJob = defineJob<CampaignComputePayload>('campaign.compute', async (payload, ctx) => {
  const campaigns = await listCampaignsToCompute(ctx.db, { workspaceId: payload.workspaceId, campaignId: payload.campaignId });
  const computedAt = ctx.now().toISOString();
  const computed: string[] = [];
  const partial: string[] = [];
  const failed: string[] = [];
  ctx.logger.info('campañas por calcular', { total: campaigns.length });

  await mapLimit(campaigns, ctx.definition.maxConcurrency, async (c) => {
    if (ctx.signal.aborted) {
      failed.push(c.id);
      return;
    }
    try {
      const values = await ctx.db.transaction((tx) => computeCampaignResult(scoped(tx, c.workspaceId), c.id, computedAt));
      if (values) {
        computed.push(c.id);
        if (values.partial) partial.push(c.id);
      }
    } catch (err) {
      failed.push(c.id);
      ctx.logger.error('no se pudo calcular el resultado de una campaña', { campaignId: c.id, workspaceId: c.workspaceId, err });
    }
  });

  return {
    processed: computed.length,
    failed: failed.length,
    metadata: { campaigns: campaigns.length, computed, partial, failed },
  };
});
