/**
 * Ventas · lo que comparten las consultas de esta carpeta y no sale del
 * paquete: la conversión de filas de SQL a tipos, la normalización de lo
 * que escribe la persona, los trozos de SQL de la lista y el detalle de
 * empresa, y los ayudantes que usan dos módulos. ../ventas.ts NO lo
 * reexporta: no es API de @mc/db/queries/ventas.
 */
import { parseReplyOptOutCode } from '../canales.ts';
import { briefVerdictSql, type BriefVerdict } from '../brief.ts';
import { type CompanyListRow, type ContactRow, type ContactSource, type DueState, type LostReason, type PipelineDealRow, type Relationship, type SignalRow, type SignalStatus } from './comun.ts';

/** Un `limit` que llega de la URL, acotado a un rango sensato. */
export function safeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/**
 * La fecha de una siguiente acción que pone el producto («Enviar pitch»,
 * «Seguimiento a la cotización»): el N-ésimo día HÁBIL después del de
 * `desde`, a las HOUR en la zona del workspace (no en UTC: en Bogotá las
 * 15:00 UTC son las 10:00). Espera la fila `w` de WORKSPACE_TZ en el
 * FROM, cuya zona siempre es una que Postgres conoce (0044).
 *
 * Es UNA sola expresión para el pitch y para el seguimiento: antes el
 * pitch contaba días de calendario y el seguimiento hábiles, y la misma
 * pantalla mezclaba los dos criterios.
 *
 * Los festivos no cuentan como no hábiles: dependen del país y el
 * producto no los conoce todavía.
 *
 * `desde`, `dias` y `hora` son los marcadores de sus parámetros ($5…);
 * `desde` puede ser NULL, y entonces cuenta desde now().
 */
export function dueInBusinessDays(desde: string, dias: string, hora: string): string {
  const hoy = `date_trunc('day', coalesce(${desde}::timestamptz, now()) AT TIME ZONE w.tz)`;
  return `(SELECT (dia + (${hora}::int * interval '1 hour')) AT TIME ZONE w.tz
             FROM generate_series(${hoy} + interval '1 day', ${hoy} + interval '21 days', interval '1 day') AS dia
            WHERE extract(isodow FROM dia) < 6
            ORDER BY dia
           OFFSET ${dias}::int - 1
            LIMIT 1)`;
}

export interface CompanyRowSql {
  id: string; name: string; domain: string | null; country: string | null; city: string | null;
  industry: string | null; niche_slugs: string[] | null; size_bucket: string | null;
  relationship: Relationship; fit_score: string | null; owner_user_id: string | null;
  owner_name: string | null; notes: string | null; linked_at: string;
  contact_count: string; opted_out_count: string; open_deal_count: string; open_deal_amount: string | null;
  pending_signal_count: string; hidden_signal_count: string; last_activity_at: string | null;
}

export interface CompanyDetailSql {
  is_own: boolean;
  legal_name: string | null; socials: Record<string, string> | null; runs_ads: boolean | null;
  ads_platforms: string[] | null; logo_url: string | null; enriched_at: string | null;
}

export function toCompanyRow(r: CompanyRowSql): CompanyListRow {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    country: r.country,
    city: r.city,
    industry: r.industry,
    nicheSlugs: r.niche_slugs ?? [],
    sizeBucket: r.size_bucket,
    relationship: r.relationship,
    fitScore: r.fit_score,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    notes: r.notes,
    contactCount: Number(r.contact_count),
    optedOutCount: Number(r.opted_out_count),
    openDealCount: Number(r.open_deal_count),
    openDealAmount: r.open_deal_amount,
    pendingSignalCount: Number(r.pending_signal_count),
    hiddenSignalCount: Number(r.hidden_signal_count),
    lastActivityAt: r.last_activity_at,
    linkedAt: r.linked_at,
  };
}

export interface ContactRowSql {
  id: string; company_id: string; full_name: string | null; role_title: string | null;
  email: string | null; phone: string | null; linkedin_url: string | null;
  instagram_handle: string | null; source: ContactSource; source_url: string | null;
  opted_out: boolean; opted_out_at: string | null; opted_out_reason: string | null; opted_out_code: string | null;
  bounced: boolean; email_invalid_reason: string | null; email_invalid_at: Date | string | null;
  is_own: boolean; created_at: string;
}

export function toContactRow(r: ContactRowSql): ContactRow {
  return {
    id: r.id,
    companyId: r.company_id,
    fullName: r.full_name,
    roleTitle: r.role_title,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedin_url,
    instagramHandle: r.instagram_handle,
    source: r.source,
    sourceUrl: r.source_url,
    optedOut: r.opted_out,
    optedOutAt: r.opted_out_at,
    optedOutReason: r.opted_out_reason,
    optedOutByReply: parseReplyOptOutCode(r.opted_out_code),
    bounced: r.bounced,
    bouncedReason: r.email_invalid_reason ?? null,
    bouncedAt:
      r.email_invalid_at === null || r.email_invalid_at === undefined
        ? null
        : r.email_invalid_at instanceof Date
          ? r.email_invalid_at.toISOString()
          : new Date(r.email_invalid_at).toISOString(),
    isOwn: r.is_own,
    createdAt: r.created_at,
  };
}

export interface SignalRowSql {
  id: string; company_id: string | null; company_name: string | null; company_domain: string | null;
  company_linked: boolean; open_deal_id: string | null; open_deal_name: string | null; open_deal_count: number;
  source_id: string; source_label: string; headline_es: string;
  detected_at: string; evidence_url: string | null; fit_score: string | null;
  budget_estimate: string | null; budget_currency: string | null; dedupe_key: string;
  status: SignalStatus; discard_reason: string | null; reviewed_at: string | null; via: string;
  hidden_by: BriefVerdict | null; hidden_match: string | null; wanted_match: string | null;
  below_min_budget: boolean | null; country_outside: boolean | null; category_outside: boolean | null;
}

export function toSignalRow(r: SignalRowSql): SignalRow {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    companyDomain: r.company_domain,
    companyLinked: r.company_linked,
    openDealId: r.open_deal_id,
    openDealName: r.open_deal_name,
    openDealCount: r.open_deal_count,
    sourceId: r.source_id,
    sourceLabel: r.source_label,
    headlineEs: r.headline_es,
    detectedAt: r.detected_at,
    evidenceUrl: r.evidence_url,
    fitScore: r.fit_score,
    budgetEstimate: r.budget_estimate,
    budgetCurrency: r.budget_currency,
    dedupeKey: r.dedupe_key,
    status: r.status,
    discardReason: r.discard_reason,
    reviewedAt: r.reviewed_at,
    via: r.via === 'csv' ? 'csv' : 'manual',
    hiddenBy: r.hidden_by,
    hiddenMatch: r.hidden_match,
    briefFit: {
      belowMinBudget: r.below_min_budget === true,
      countryOutside: r.country_outside === true,
      wantedCategory: r.wanted_match,
      categoryOutside: r.category_outside === true,
    },
  };
}

export interface PipelineRowSql {
  id: string; company_id: string; company_name: string; name: string; stage_id: string;
  stage_label: string; stage_position: number; amount: string | null; currency: string;
  probability: string; weighted_amount: string | null; next_action: string | null;
  next_action_due: string | null; next_action_due_date: string | null; next_action_due_time: string | null;
  next_action_user_id: string | null; next_action_user_name: string | null;
  due_state: DueState; last_contact_at: string | null; last_contact_days: number | null;
  expected_close_date: string | null; is_won: boolean; is_lost: boolean;
  owner_user_id: string | null; owner_name: string | null; days_in_stage: number; lost_reason: LostReason | null;
}

export function toPipelineRow(r: PipelineRowSql): PipelineDealRow {
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    name: r.name,
    stageId: r.stage_id,
    stageLabel: r.stage_label,
    stagePosition: r.stage_position,
    amount: r.amount,
    currency: r.currency,
    probability: r.probability,
    weightedAmount: r.weighted_amount,
    nextAction: r.next_action,
    nextActionDue: r.next_action_due,
    nextActionDueDate: r.next_action_due_date,
    nextActionDueTime: r.next_action_due_time,
    nextActionUserId: r.next_action_user_id,
    nextActionUserName: r.next_action_user_name,
    dueState: r.due_state,
    lastContactAt: r.last_contact_at,
    lastContactDays: r.last_contact_days === null ? null : Number(r.last_contact_days),
    expectedCloseDate: r.expected_close_date,
    isWon: r.is_won,
    isLost: r.is_lost,
    daysInStage: Number(r.days_in_stage ?? 0),
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name,
    lostReason: r.is_lost ? r.lost_reason : null,
  };
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v || null;
}

/** «@cafealma» y «cafealma» son el mismo usuario. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^@/, '');
  return v || null;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** El texto del usuario, con los comodines de LIKE escapados. */
export const ESCAPE_LIKE = `replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

export const CONTACT_COUNTS = `
  (SELECT count(*) FROM contact c WHERE c.company_id = co.id)::text                       AS contact_count,
  (SELECT count(*) FROM contact c WHERE c.company_id = co.id AND c.opted_out)::text       AS opted_out_count`;

/**
 * Los negocios abiertos y su suma. `sum` sin COALESCE a propósito: si
 * ninguno tiene monto, la suma es NULL («Sin monto») y no 0.
 */
export const DEAL_COUNTS = `
  (SELECT count(*) FROM deal_pipeline dp
    WHERE dp.company_id = co.id AND NOT dp.is_won AND NOT dp.is_lost)::text               AS open_deal_count,
  (SELECT sum(dp.amount) FROM deal_pipeline dp
    WHERE dp.company_id = co.id AND NOT dp.is_won AND NOT dp.is_lost)::text               AS open_deal_amount`;

/**
 * Las señales pendientes de la empresa, partidas como las parte el radar
 * (VEN-7): las que se ven en la bandeja y las que el brief activo deja
 * fuera. Con la misma expresión que listSignals (briefVerdictSql): la
 * ficha no puede decir «1 señal en el radar» y enlazar a una bandeja
 * donde esa señal no está.
 */
export const PENDING_SIGNALS = `
  (SELECT count(*) FROM signal s
    WHERE s.company_id = co.id AND s.status = 'pending'
      AND ${briefVerdictSql('s')} IS NULL)::text                                          AS pending_signal_count,
  (SELECT count(*) FROM signal s
    WHERE s.company_id = co.id AND s.status = 'pending'
      AND ${briefVerdictSql('s')} IS NOT NULL)::text                                      AS hidden_signal_count`;

export const LAST_ACTIVITY = `
  (SELECT max(a.occurred_at) FROM activity a WHERE a.company_id = co.id)                  AS last_activity_at`;
