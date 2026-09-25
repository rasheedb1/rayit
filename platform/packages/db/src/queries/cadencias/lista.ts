/**
 * Cadencias · la lista /ventas/cadencias (VEN-13): las secuencias con
 * su estado, pasos, enrolados y respuesta ya contados en SQL; las
 * plantillas globales activas; y las señales desde las que se pide una
 * propuesta.
 */
import { signalKindOfSource, type RecommendSignalKind, type RecommendTemplate } from '@mc/core';
import type { WorkspaceTx } from '../../client.ts';
import { assertId, LIVE_ENROLLMENT_STATUSES, type SequenceStatus } from './comun.ts';

export interface SequenceListRow {
  id: string;
  name: string;
  status: SequenceStatus;
  channel: string;
  steps: number;
  /** Personas dentro que no terminaron (activas, en pausa o en enfriamiento). */
  enrolledLive: number;
  enrolledTotal: number;
  /** Personas a las que ya les salió algo. */
  contacted: number;
  replied: number;
  /** replied / contacted, calculado en SQL; null sin nadie contactado. */
  replyRate: number | null;
  signalHeadline: string | null;
  companyName: string | null;
  updatedAt: string;
}

/** Las secuencias del espacio: las vivas primero, luego borradores, pausadas y archivadas. */
export async function listSequences(tx: WorkspaceTx, opts: { includeArchived?: boolean } = {}): Promise<SequenceListRow[]> {
  const { rows } = await tx.query<{
    id: string; name: string; status: SequenceStatus; channel: string; steps: number; enrolled_live: number;
    enrolled_total: number; contacted: number; replied: number; reply_rate: string | null; signal_headline: string | null;
    company_name: string | null; updated_at: Date;
  }>(
    `WITH e AS (
       SELECT e.sequence_id,
              count(*) FILTER (WHERE e.status = ANY($2::text[]))::int AS enrolled_live,
              count(*)::int AS enrolled_total,
              count(*) FILTER (WHERE e.status = 'replied')::int AS replied,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM outbound_touch t
                                              WHERE t.enrollment_id = e.id AND t.status = 'sent'))::int AS contacted
         FROM outbound_enrollment e GROUP BY e.sequence_id)
     SELECT s.id, s.name, s.status, s.channel,
            (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id)::int AS steps,
            coalesce(e.enrolled_live, 0) AS enrolled_live, coalesce(e.enrolled_total, 0) AS enrolled_total,
            coalesce(e.contacted, 0) AS contacted, coalesce(e.replied, 0) AS replied,
            round(e.replied::numeric / nullif(e.contacted, 0), 4)::text AS reply_rate,
            sg.headline_es AS signal_headline, co.name AS company_name, s.updated_at
       FROM outbound_sequence s
       LEFT JOIN e ON e.sequence_id = s.id
       LEFT JOIN signal sg ON sg.id = s.signal_id
       LEFT JOIN company co ON co.id = sg.company_id
      WHERE $1::boolean OR s.status <> 'archived'
      ORDER BY array_position(ARRAY['active','draft','paused','archived'], s.status), s.updated_at DESC, s.id`,
    [opts.includeArchived === true, [...LIVE_ENROLLMENT_STATUSES]],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, channel: r.channel, steps: r.steps, enrolledLive: r.enrolled_live,
    enrolledTotal: r.enrolled_total, contacted: r.contacted, replied: r.replied,
    replyRate: r.reply_rate === null ? null : Number(r.reply_rate),
    signalHeadline: r.signal_headline, companyName: r.company_name, updatedAt: r.updated_at.toISOString(),
  }));
}

export interface TemplateRow extends RecommendTemplate {
  descriptionEs: string;
  /** El último día de la plantilla: «6 pasos en 9 días». */
  spanDays: number;
}

/** Las plantillas globales activas, por slug (el orden en que el recomendador desempata). */
export async function listSequenceTemplates(tx: WorkspaceTx): Promise<TemplateRow[]> {
  const { rows } = await tx.query<{
    slug: string; name_es: string; description_es: string; signal_kind: string | null; niche_slug: string | null;
    steps: RecommendTemplate['steps'];
  }>(
    `SELECT slug, name_es, description_es, signal_kind, niche_slug, steps
       FROM outbound_sequence_template WHERE active ORDER BY slug`,
  );
  return rows.map((r) => ({
    slug: r.slug, nameEs: r.name_es, descriptionEs: r.description_es, signalKind: r.signal_kind, nicheSlug: r.niche_slug,
    steps: r.steps, spanDays: r.steps.reduce((max, s) => Math.max(max, s.day_offset), 0),
  }));
}

export interface ProposableSignal {
  signalId: string;
  headline: string;
  signalKind: RecommendSignalKind;
  detectedAt: string;
  companyName: string | null;
  dealId: string;
  dealName: string;
  /** La cadencia que ya salió de esta señal, si hay una sin archivar. */
  sequenceId: string | null;
}

/** Las señales que se pueden proponer, y cuántas hay en total (para «Ver todas»). */
export interface ProposableSignals {
  signals: ProposableSignal[];
  total: number;
}

/** Cuántas señales devuelve listProposableSignals como mucho, aunque se pidan todas. */
export const PROPOSABLE_SIGNALS_MAX = 200;

/**
 * Las señales aceptadas cuyo negocio sigue abierto: desde ellas se pide
 * una propuesta. La más reciente primero. `limit` recorta la lista (la
 * portada de cadencias muestra unas pocas) y `total` dice cuántas hay,
 * para que ninguna quede sin camino; `companyId` las deja en las de una
 * empresa (la ficha, junto a cada negocio).
 */
export async function listProposableSignals(
  tx: WorkspaceTx, opts: { limit?: number; companyId?: string } = {},
): Promise<ProposableSignals> {
  if (opts.companyId !== undefined) assertId('listProposableSignals', opts.companyId);
  const limit = Math.min(PROPOSABLE_SIGNALS_MAX, Math.max(1, Math.floor(opts.limit ?? PROPOSABLE_SIGNALS_MAX)));
  const { rows } = await tx.query<{
    signal_id: string; headline: string; source_kind: string; detected_at: Date; company_name: string | null;
    deal_id: string; deal_name: string; sequence_id: string | null; total: number;
  }>(
    `SELECT x.*, count(*) OVER ()::int AS total,
            (SELECT s.id FROM outbound_sequence s WHERE s.signal_id = x.signal_id AND s.status <> 'archived'
              ORDER BY s.updated_at DESC LIMIT 1) AS sequence_id
       FROM (SELECT DISTINCT ON (sg.id) sg.id AS signal_id, sg.headline_es AS headline, src.kind AS source_kind,
                    sg.detected_at, co.name AS company_name, d.id AS deal_id, d.name AS deal_name
               FROM signal sg
               JOIN signal_source src ON src.id = sg.source_id
               JOIN deal d ON d.origin_signal_id = sg.id
               JOIN pipeline_stage st ON st.id = d.stage_id
               LEFT JOIN company co ON co.id = sg.company_id
              WHERE sg.status = 'accepted' AND NOT st.is_won AND NOT st.is_lost
                AND ($2::uuid IS NULL OR d.company_id = $2::uuid)
              ORDER BY sg.id, d.updated_at DESC) x
      ORDER BY x.detected_at DESC, x.signal_id
      LIMIT $1::int`,
    [limit, opts.companyId ?? null],
  );
  return {
    signals: rows.map((r) => ({
      signalId: r.signal_id, headline: r.headline, signalKind: signalKindOfSource(r.source_kind),
      detectedAt: r.detected_at.toISOString(), companyName: r.company_name, dealId: r.deal_id, dealName: r.deal_name,
      sequenceId: r.sequence_id,
    })),
    total: rows[0]?.total ?? 0,
  };
}
